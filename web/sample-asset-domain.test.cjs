const assert = require("node:assert/strict");
const domain = require("./sample-asset-domain.js");
const storeApi = require("./sample-asset-store.js");

function wavPcm16({ sampleRate = 48000, channels = 1, samples }) {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return bytes;
}

function wavPcm24Stereo({ sampleRate = 44100, frames }) {
  const channels = 2;
  const dataBytes = frames.length * channels * 3;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
  text(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 6, true);
  view.setUint16(32, 6, true); view.setUint16(34, 24, true);
  text(36, "data"); view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const frame of frames) {
    for (const input of frame) {
      let value = input;
      if (value < 0) value += 0x1000000;
      bytes[offset++] = value & 0xff;
      bytes[offset++] = (value >>> 8) & 0xff;
      bytes[offset++] = (value >>> 16) & 0xff;
    }
  }
  return bytes;
}

(async () => {
  {
    const wav = wavPcm16({ samples: [-32768, -1234, 0, 1234, 32767] });
    const decoded = domain.parseWav(wav);
    assert.equal(decoded.sampleRateHz, 48000);
    assert.equal(decoded.channelCount, 1);
    assert.equal(decoded.frameCount, 5);
    assert.equal(decoded.byteSize, 10);
    const view = new DataView(decoded.pcmBytes.buffer);
    assert.deepEqual(
      Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true)),
      [-32768, -1234, 0, 1234, 32767],
    );

    const imported = await domain.importWav(wav, { sourceName: "  Kick\u0000.wav  " });
    assert.equal(imported.ref.schema, domain.ASSET_SCHEMA);
    assert.equal(imported.ref.format, domain.PCM_FORMAT);
    assert.match(imported.ref.sha256, /^[0-9a-f]{64}$/);
    assert.equal(imported.ref.sourceName, "Kick.wav");
    assert.equal(await domain.verifyAsset(imported.ref, imported.pcmBytes), true);

    const repeat = await domain.importWav(wav, { sourceName: "renamed.wav" });
    assert.equal(repeat.ref.sha256, imported.ref.sha256, "source filename must not affect content identity");

    const otherRate = await domain.importWav(wavPcm16({ sampleRate: 44100, samples: [-32768, -1234, 0, 1234, 32767] }));
    assert.notEqual(otherRate.ref.sha256, imported.ref.sha256, "sample rate is part of semantic asset identity");
  }

  {
    const wav = wavPcm24Stereo({
      frames: [
        [-0x800000, 0x7fffff],
        [-0x010000, 0x010000],
      ],
    });
    const decoded = domain.parseWav(wav);
    assert.equal(decoded.channelCount, 2);
    assert.equal(decoded.frameCount, 2);
    const view = new DataView(decoded.pcmBytes.buffer);
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => view.getInt16(i * 2, true)),
      [-32768, 32767, -256, 256],
    );
  }

  {
    const good = await domain.importWav(wavPcm16({ channels: 2, samples: [100, -100, 200, -200] }));
    const store = storeApi.createMemoryStore();
    assert.deepEqual(await store.put(good.ref, good.pcmBytes), { inserted: true, ref: good.ref });
    assert.equal(await store.count(), 1);
    const duplicate = await store.put(good.ref, good.pcmBytes);
    assert.equal(duplicate.inserted, false);
    assert.equal(await store.count(), 1);
    assert.equal(await store.has(good.ref.sha256), true);
    const loaded = await store.get(good.ref.sha256);
    assert.deepEqual(loaded.ref, good.ref);
    assert.deepEqual([...loaded.pcmBytes], [...good.pcmBytes]);
    loaded.pcmBytes[0] ^= 0xff;
    const loadedAgain = await store.get(good.ref.sha256);
    assert.deepEqual([...loadedAgain.pcmBytes], [...good.pcmBytes], "store reads must not alias mutable bytes");

    const badRef = { ...good.ref, sha256: "0".repeat(64) };
    await assert.rejects(() => store.put(badRef, good.pcmBytes), /hash mismatch/);
    assert.equal(await store.delete(good.ref.sha256), true);
    assert.equal(await store.count(), 0);
  }

  {
    const threeChannel = wavPcm16({ channels: 3, samples: [0, 0, 0] });
    assert.throws(() => domain.parseWav(threeChannel), /mono or stereo/);
  }

  console.log("Sample asset WAV decode + content store tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
