(() => {
  const MIN_INSTRUMENT_ID = 0;
  const MAX_INSTRUMENT_ID = 255;
  const DEFAULT_PATCH_ENCODING = "json";
  const SAMPLE_ASSET_REF_SCHEMA = "brktrk-pcm-asset-ref-v1";
  const SAMPLE_ASSET_FORMAT = "pcm-s16-interleaved";
  const SAMPLE_ASSET_MAX_BYTES = 8 * 1024 * 1024;
  const SHA256_RE = /^[0-9a-f]{64}$/;

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  function instrumentId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < MIN_INSTRUMENT_ID || id > MAX_INSTRUMENT_ID) {
      throw new RangeError(`Instrument id must be 00–FF, got ${String(value)}`);
    }
    return id;
  }

  function requiredString(value, field) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) throw new TypeError(`Production Instrument ${field} must be a non-empty string`);
    return text;
  }

  function optionalString(value, fallback = null) {
    if (value == null) return fallback;
    const text = String(value).trim();
    return text || fallback;
  }

  function normalizeEngineRef(value) {
    if (!isObject(value)) throw new TypeError("Production Instrument engineRef must be an object");
    return {
      ...clone(value),
      moduleId: requiredString(value.moduleId, "engineRef.moduleId"),
      engineId: requiredString(value.engineId, "engineRef.engineId"),
      requestedVersion: optionalString(value.requestedVersion),
      resolvedVersion: optionalString(value.resolvedVersion),
      hostContract: optionalString(value.hostContract),
    };
  }

  function normalizePatchState(value = {}) {
    const source = isObject(value) ? value : {};
    const schemaVersion = source.schemaVersion == null ? 0 : Number(source.schemaVersion);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
      throw new TypeError("Production Instrument patchState.schemaVersion must be a non-negative integer");
    }
    return {
      ...clone(source),
      schemaVersion,
      encoding: optionalString(source.encoding, DEFAULT_PATCH_ENCODING),
      data: clone(Object.hasOwn(source, "data") ? source.data : null),
    };
  }

  function normalizeParameterSnapshot(value = {}) {
    if (!isObject(value)) throw new TypeError("Production Instrument parameterSnapshot must be an object");
    const output = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = String(rawKey).trim();
      if (!key) throw new TypeError("Production Instrument parameter key must not be empty");
      output[key] = clone(rawValue);
    }
    return output;
  }

  function normalizeObjectEnvelope(value) {
    return isObject(value) ? clone(value) : {};
  }

  function normalizeSampleAssetRef(value) {
    if (value == null) return null;
    if (!isObject(value)) throw new TypeError("Production Instrument assetRef must be an object");
    const schema = optionalString(value.schema, SAMPLE_ASSET_REF_SCHEMA);
    if (schema !== SAMPLE_ASSET_REF_SCHEMA) throw new TypeError(`Unsupported sample assetRef schema: ${schema}`);
    const format = optionalString(value.format, SAMPLE_ASSET_FORMAT);
    if (format !== SAMPLE_ASSET_FORMAT) throw new TypeError(`Unsupported sample assetRef format: ${format}`);
    const sha256 = String(value.sha256 ?? "").trim().toLowerCase();
    if (!SHA256_RE.test(sha256)) throw new TypeError("Production Instrument assetRef.sha256 must be lowercase SHA-256");
    const sampleRateHz = Number(value.sampleRateHz);
    const channelCount = Number(value.channelCount);
    const frameCount = Number(value.frameCount);
    const byteSize = Number(value.byteSize);
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 1000 || sampleRateHz > 384000) {
      throw new RangeError("Production Instrument assetRef.sampleRateHz is out of range");
    }
    if (channelCount !== 1 && channelCount !== 2) {
      throw new RangeError("Production Instrument assetRef.channelCount must be 1 or 2");
    }
    if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
      throw new RangeError("Production Instrument assetRef.frameCount must be a positive safe integer");
    }
    const expectedBytes = frameCount * channelCount * 2;
    if (!Number.isSafeInteger(byteSize) || byteSize !== expectedBytes || byteSize > SAMPLE_ASSET_MAX_BYTES) {
      throw new RangeError(`Production Instrument assetRef.byteSize must equal canonical PCM bytes and fit ${SAMPLE_ASSET_MAX_BYTES}`);
    }
    return {
      ...clone(value),
      schema: SAMPLE_ASSET_REF_SCHEMA,
      format: SAMPLE_ASSET_FORMAT,
      sha256,
      sampleRateHz,
      channelCount,
      frameCount,
      byteSize,
      sourceName: optionalString(value.sourceName, null)?.slice(0, 255) ?? null,
    };
  }

  function normalizeInstrument(slot, value) {
    const id = instrumentId(slot);
    if (!isObject(value)) throw new TypeError(`Production Instrument ${id} must be an object`);
    if (Object.hasOwn(value, "id") && Number(value.id) !== id) {
      throw new RangeError(`Production Instrument pool key ${id} conflicts with embedded id ${String(value.id)}`);
    }
    const rawName = typeof value.name === "string" ? value.name.trim() : "";
    const name = (rawName || `INSTRUMENT ${id.toString(16).toUpperCase().padStart(2, "0")}`).slice(0, 48);
    return {
      ...clone(value),
      id,
      name,
      engineRef: normalizeEngineRef(value.engineRef),
      patchState: normalizePatchState(value.patchState),
      parameterSnapshot: normalizeParameterSnapshot(value.parameterSnapshot ?? {}),
      ...(Object.hasOwn(value, "assetRef") ? { assetRef: normalizeSampleAssetRef(value.assetRef) } : {}),
      presetRef: clone(Object.hasOwn(value, "presetRef") ? value.presetRef : null),
      provenance: normalizeObjectEnvelope(value.provenance),
      compatibilityData: normalizeObjectEnvelope(value.compatibilityData),
      unknownData: Array.isArray(value.unknownData) ? clone(value.unknownData) : [],
    };
  }

  function normalizeInstrumentPool(value) {
    if (value == null) return {};
    if (!isObject(value)) throw new TypeError("Project instrumentPool must be an object");
    const output = {};
    for (const [rawId, instrument] of Object.entries(value)) {
      const id = instrumentId(rawId);
      output[id] = normalizeInstrument(id, instrument);
    }
    return output;
  }

  function createInstrument(slot, input) {
    return normalizeInstrument(slot, input);
  }

  function clonePool(value) {
    return normalizeInstrumentPool(value);
  }

  const api = Object.freeze({
    MIN_INSTRUMENT_ID,
    MAX_INSTRUMENT_ID,
    DEFAULT_PATCH_ENCODING,
    SAMPLE_ASSET_REF_SCHEMA,
    SAMPLE_ASSET_FORMAT,
    SAMPLE_ASSET_MAX_BYTES,
    instrumentId,
    normalizeEngineRef,
    normalizePatchState,
    normalizeParameterSnapshot,
    normalizeSampleAssetRef,
    normalizeInstrument,
    normalizeInstrumentPool,
    createInstrument,
    clonePool,
  });

  globalThis.BRKTRKProductionInstrumentDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
