const assert = require("node:assert/strict");
require("./sample-asset-domain.js");
require("./sample-asset-store.js");
const surface = require("./sample-asset-surface.js");

function wav16(samples, sampleRate = 48000, channels = 1) {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => [...text].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  write(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, dataBytes, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

(async () => {
  assert.equal(surface.supportsView({ manifest: { runtime: { assetExtensionVersion: 65536 } } }), true);
  assert.equal(surface.supportsView({ manifest: { runtime: { assetExtensionVersion: 0 } } }), false);
  assert.equal(surface.supportsView({ manifest: {} }), false);

  const info = surface.metadata({
    sourceName: "kick.wav",
    sampleRateHz: 48000,
    channelCount: 1,
    frameCount: 4800,
    byteSize: 9600,
    sha256: "a".repeat(64),
  });
  assert.equal(info.durationSeconds, 0.1);
  assert.equal(surface.metadataText({
    sourceName: "kick.wav",
    sampleRateHz: 48000,
    channelCount: 1,
    frameCount: 4800,
    byteSize: 9600,
    sha256: "a".repeat(64),
  }), "MONO · 48 kHz · 100 ms · 4800 frames");
  assert.equal(surface.metadataText(null), "NO SAMPLE LOADED");

  const store = globalThis.BRKTRKSampleAssetStore.createMemoryStore();
  let assigned = null;
  const projectStore = {
    setProductionInstrumentAssetRef(slot, ref, metadata) {
      assigned = { slot, ref, metadata };
      return { mutated: true, after: ref };
    },
  };
  const wav = wav16([-32768, 0, 32767]);
  const file = {
    name: "My Kick.wav",
    async arrayBuffer() {
      return wav.slice().buffer;
    },
  };
  const result = await surface.importFile(9, file, { store, projectStore, source: "test.sample.import" });
  assert.equal(result.inserted, true);
  assert.equal(assigned.slot, 9);
  assert.equal(assigned.ref.sourceName, "My Kick.wav");
  assert.equal(assigned.ref.frameCount, 3);
  assert.equal(assigned.ref.channelCount, 1);
  assert.equal(assigned.metadata.source, "test.sample.import");
  assert.equal(await store.count(), 1);
  assert.ok(await store.get(assigned.ref.sha256));

  const repeat = await surface.importFile(9, { ...file, name: "Renamed.wav" }, { store, projectStore });
  assert.equal(repeat.inserted, false, "same canonical PCM must reuse content-addressed bytes");
  assert.equal(await store.count(), 1);
  assert.equal(repeat.ref.sha256, result.ref.sha256);
  assert.equal(repeat.ref.sourceName, "Renamed.wav", "display source name may change without changing content identity");

  let cleared = false;
  const clearResult = surface.clearAsset(9, {
    projectStore: {
      setProductionInstrumentAssetRef(slot, ref, metadata) {
        cleared = slot === 9 && ref === null && metadata.source === "sound.sample.clear";
        return { mutated: true };
      },
    },
  });
  assert.equal(cleared, true);
  assert.equal(clearResult.mutated, true);
  assert.equal(await store.count(), 1, "clearing an Instrument must not delete shared/undoable sample content");

  const cleanupStore = globalThis.BRKTRKSampleAssetStore.createMemoryStore();
  await assert.rejects(
    () => surface.importFile(3, file, {
      store: cleanupStore,
      projectStore: {
        setProductionInstrumentAssetRef() {
          throw new Error("Project mutation failed");
        },
      },
    }),
    /Project mutation failed/,
  );
  assert.equal(await cleanupStore.count(), 0, "new content must be rolled back when Project mutation fails");

  await assert.rejects(
    () => surface.importFile(1, {
      name: "not-wave.bin",
      async arrayBuffer() { return Uint8Array.from([1,2,3,4]).buffer; },
    }, { store, projectStore }),
    /WAV file is too small/,
  );

  console.log("Sampler Sound asset import surface contract passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
