(() => {
  "use strict";

  const ASSET_SCHEMA = "brktrk-pcm-asset-ref-v1";
  const PCM_FORMAT = "pcm-s16-interleaved";
  const MAX_PCM_BYTES = 8 * 1024 * 1024;
  const DIGEST_PREFIX = "BRKTRK_PCM_S16_V1\0";

  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Sample bytes must be an ArrayBuffer or typed array");
  }

  function ascii(bytes, offset, length) {
    let out = "";
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
    return out;
  }

  function clampSample(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(-1, Math.min(1, value));
  }

  function floatToInt16(value) {
    const sample = clampSample(value);
    return sample <= -1 ? -32768 : sample >= 1 ? 32767 : Math.round(sample * 32767);
  }

  function decodePcmSample(view, offset, format, bitsPerSample) {
    if (format === 1) {
      if (bitsPerSample === 8) return (view.getUint8(offset) - 128) << 8;
      if (bitsPerSample === 16) return view.getInt16(offset, true);
      if (bitsPerSample === 24) {
        let value = view.getUint8(offset)
          | (view.getUint8(offset + 1) << 8)
          | (view.getUint8(offset + 2) << 16);
        if (value & 0x800000) value |= 0xff000000;
        return value >> 8;
      }
      if (bitsPerSample === 32) return view.getInt32(offset, true) >> 16;
    }
    if (format === 3 && bitsPerSample === 32) return floatToInt16(view.getFloat32(offset, true));
    throw new RangeError(`Unsupported WAV sample format: format=${format}, bits=${bitsPerSample}`);
  }

  function parseWav(value) {
    const bytes = asBytes(value);
    if (bytes.byteLength < 44) throw new RangeError("WAV file is too small");
    if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
      throw new TypeError("Only little-endian RIFF/WAVE files are supported");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let fmt = null;
    let data = null;
    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
      const id = ascii(bytes, offset, 4);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      const end = body + size;
      if (end > bytes.byteLength) throw new RangeError(`WAV chunk ${id} exceeds file bounds`);
      if (id === "fmt " && fmt == null) {
        if (size < 16) throw new RangeError("WAV fmt chunk is too small");
        fmt = {
          audioFormat: view.getUint16(body, true),
          channelCount: view.getUint16(body + 2, true),
          sampleRateHz: view.getUint32(body + 4, true),
          byteRate: view.getUint32(body + 8, true),
          blockAlign: view.getUint16(body + 12, true),
          bitsPerSample: view.getUint16(body + 14, true),
        };
      } else if (id === "data" && data == null) {
        data = { offset: body, byteSize: size };
      }
      offset = end + (size & 1);
    }
    if (!fmt) throw new TypeError("WAV fmt chunk is missing");
    if (!data) throw new TypeError("WAV data chunk is missing");
    if (fmt.channelCount !== 1 && fmt.channelCount !== 2) {
      throw new RangeError("Sampler P0 supports mono or stereo WAV only");
    }
    if (!Number.isInteger(fmt.sampleRateHz) || fmt.sampleRateHz < 1000 || fmt.sampleRateHz > 384000) {
      throw new RangeError("WAV sample rate is out of supported range");
    }
    const supported = (fmt.audioFormat === 1 && [8,16,24,32].includes(fmt.bitsPerSample))
      || (fmt.audioFormat === 3 && fmt.bitsPerSample === 32);
    if (!supported) {
      throw new RangeError(`Unsupported WAV encoding: format=${fmt.audioFormat}, bits=${fmt.bitsPerSample}`);
    }
    const bytesPerSample = fmt.bitsPerSample / 8;
    const expectedAlign = fmt.channelCount * bytesPerSample;
    if (fmt.blockAlign !== expectedAlign || fmt.blockAlign === 0) {
      throw new RangeError("WAV block alignment does not match channel/bit depth metadata");
    }
    if (data.byteSize === 0 || data.byteSize % fmt.blockAlign !== 0) {
      throw new RangeError("WAV data size is not a whole number of frames");
    }
    const frameCount = data.byteSize / fmt.blockAlign;
    const canonicalByteSize = frameCount * fmt.channelCount * 2;
    if (!Number.isSafeInteger(frameCount) || canonicalByteSize > MAX_PCM_BYTES) {
      throw new RangeError(`Canonical PCM exceeds sampler P0 limit of ${MAX_PCM_BYTES} bytes`);
    }

    const pcmBytes = new Uint8Array(canonicalByteSize);
    const pcmView = new DataView(pcmBytes.buffer);
    let sourceOffset = data.offset;
    let targetOffset = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < fmt.channelCount; channel += 1) {
        const sample = decodePcmSample(view, sourceOffset, fmt.audioFormat, fmt.bitsPerSample);
        pcmView.setInt16(targetOffset, Math.max(-32768, Math.min(32767, sample)), true);
        sourceOffset += bytesPerSample;
        targetOffset += 2;
      }
    }
    return Object.freeze({
      sampleRateHz: fmt.sampleRateHz,
      channelCount: fmt.channelCount,
      frameCount,
      byteSize: canonicalByteSize,
      pcmBytes,
    });
  }

  function digestInput(meta, pcmBytesValue) {
    const pcmBytes = asBytes(pcmBytesValue);
    const prefix = new TextEncoder().encode(DIGEST_PREFIX);
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, Number(meta.sampleRateHz) >>> 0, true);
    view.setUint32(4, Number(meta.channelCount) >>> 0, true);
    view.setUint32(8, Number(meta.frameCount) >>> 0, true);
    view.setUint32(12, Number(meta.byteSize) >>> 0, true);
    const all = new Uint8Array(prefix.byteLength + header.byteLength + pcmBytes.byteLength);
    all.set(prefix, 0);
    all.set(header, prefix.byteLength);
    all.set(pcmBytes, prefix.byteLength + header.byteLength);
    return all;
  }

  async function sha256Hex(bytesValue) {
    const bytes = asBytes(bytesValue);
    if (globalThis.crypto?.subtle) {
      const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer : bytes.slice().buffer;
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
      return [...digest].map((v) => v.toString(16).padStart(2, "0")).join("");
    }
    if (typeof require !== "undefined") {
      const { createHash } = require("node:crypto");
      return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    }
    throw new Error("SHA-256 implementation is unavailable");
  }

  function normalizeSourceName(value) {
    if (value == null) return null;
    const text = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return text ? text.slice(0, 255) : null;
  }

  async function assetRefForPcm(meta, pcmBytesValue, options = {}) {
    const pcmBytes = asBytes(pcmBytesValue);
    const sampleRateHz = Number(meta?.sampleRateHz);
    const channelCount = Number(meta?.channelCount);
    const frameCount = Number(meta?.frameCount);
    const byteSize = Number(meta?.byteSize ?? pcmBytes.byteLength);
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 1000 || sampleRateHz > 384000) {
      throw new RangeError("PCM sample rate is out of range");
    }
    if (channelCount !== 1 && channelCount !== 2) throw new RangeError("PCM channel count must be 1 or 2");
    if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new RangeError("PCM frame count must be positive");
    if (byteSize !== frameCount * channelCount * 2 || byteSize !== pcmBytes.byteLength || byteSize > MAX_PCM_BYTES) {
      throw new RangeError("PCM byte size is inconsistent with canonical PCM16 metadata");
    }
    const sha256 = await sha256Hex(digestInput({ sampleRateHz, channelCount, frameCount, byteSize }, pcmBytes));
    return Object.freeze({
      schema: ASSET_SCHEMA,
      format: PCM_FORMAT,
      sha256,
      sampleRateHz,
      channelCount,
      frameCount,
      byteSize,
      sourceName: normalizeSourceName(options.sourceName),
    });
  }

  async function importWav(value, options = {}) {
    const decoded = parseWav(value);
    const ref = await assetRefForPcm(decoded, decoded.pcmBytes, options);
    return Object.freeze({ ref, pcmBytes: decoded.pcmBytes });
  }

  async function verifyAsset(ref, pcmBytesValue) {
    if (!isObject(ref)) throw new TypeError("Asset ref must be an object");
    const pcmBytes = asBytes(pcmBytesValue);
    const expected = await assetRefForPcm(ref, pcmBytes, { sourceName: ref.sourceName });
    if (expected.sha256 !== String(ref.sha256 ?? "").toLowerCase()) {
      throw new Error("Sample asset content hash mismatch");
    }
    if (expected.schema !== ref.schema || expected.format !== ref.format
      || expected.sampleRateHz !== ref.sampleRateHz || expected.channelCount !== ref.channelCount
      || expected.frameCount !== ref.frameCount || expected.byteSize !== ref.byteSize) {
      throw new Error("Sample asset metadata does not match canonical PCM");
    }
    return true;
  }

  const api = Object.freeze({
    ASSET_SCHEMA,
    PCM_FORMAT,
    MAX_PCM_BYTES,
    parseWav,
    assetRefForPcm,
    importWav,
    verifyAsset,
    sha256Hex,
  });

  globalThis.BRKTRKSampleAssetDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
