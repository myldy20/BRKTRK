const assert = require("node:assert/strict");
const d = require("./production-instrument-domain.js");

const fixture = (overrides = {}) => ({
  id: 3,
  name: "BRK TEST",
  engineRef: {
    moduleId: "org.myldydesign.brk.test-module",
    engineId: "org.myldydesign.brk.test-engine",
    requestedVersion: "^1.0.0",
    resolvedVersion: null,
    hostContract: "1.x",
    channel: "preview",
    futureEngineRef: { keep: true },
  },
  patchState: {
    schemaVersion: 1,
    encoding: "json",
    data: { gain: 0.5 },
    futurePatchField: { keep: true },
  },
  parameterSnapshot: {
    "amp.gain": 0.5,
    "osc.mode": "sine",
  },
  presetRef: null,
  provenance: { source: "test" },
  compatibilityData: { "org.example.future": { keep: true } },
  unknownData: [{ keep: true }],
  futureInstrumentField: { keep: true },
  ...overrides,
});

{
  const normalized = d.normalizeInstrument(3, fixture());
  assert.equal(normalized.id, 3);
  assert.equal(normalized.name, "BRK TEST");
  assert.equal(normalized.engineRef.moduleId, "org.myldydesign.brk.test-module");
  assert.equal(normalized.engineRef.channel, "preview", "engineRef channel must survive normalization");
  assert.equal(normalized.engineRef.futureEngineRef.keep, true);
  assert.equal(normalized.patchState.futurePatchField.keep, true);
  assert.equal(normalized.parameterSnapshot["amp.gain"], 0.5);
  assert.equal(normalized.compatibilityData["org.example.future"].keep, true);
  assert.equal(normalized.futureInstrumentField.keep, true);
}

{
  const pool = d.normalizeInstrumentPool({ 3: fixture(), 254: fixture({ id: 254, name: "FE" }) });
  assert.deepEqual(Object.keys(pool), ["3", "254"]);
  assert.equal(pool[254].id, 254);
  assert.equal(pool[254].name, "FE");
}

{
  const source = { 3: fixture() };
  const before = JSON.stringify(source);
  const pool = d.normalizeInstrumentPool(source);
  pool[3].patchState.data.gain = 0.75;
  assert.equal(JSON.stringify(source), before, "normalization must not mutate source project data");
}

assert.deepEqual(d.normalizeInstrumentPool(null), {});
assert.throws(() => d.normalizeInstrumentPool([]), /instrumentPool must be an object/);
assert.throws(() => d.normalizeInstrumentPool({ 256: fixture({ id: 256 }) }), /00–FF/);
assert.throws(() => d.normalizeInstrument(3, fixture({ id: 4 })), /conflicts with embedded id/);
assert.throws(() => d.normalizeInstrument(3, fixture({ engineRef: {} })), /moduleId/);
assert.throws(() => d.normalizeInstrument(3, fixture({ patchState: { schemaVersion: -1 } })), /non-negative integer/);
assert.throws(() => d.normalizeInstrument(3, fixture({ parameterSnapshot: [] })), /parameterSnapshot must be an object/);


{
  const assetRef = {
    schema: d.SAMPLE_ASSET_REF_SCHEMA,
    format: d.SAMPLE_ASSET_FORMAT,
    sha256: "A".repeat(64),
    sampleRateHz: 48000,
    channelCount: 2,
    frameCount: 1000,
    byteSize: 4000,
    sourceName: "Kick.wav",
    futureAssetField: { keep: true },
  };
  const normalized = d.normalizeInstrument(3, fixture({ assetRef }));
  assert.equal(normalized.assetRef.sha256, "a".repeat(64), "asset SHA is canonical lowercase");
  assert.equal(normalized.assetRef.byteSize, 4000);
  assert.equal(normalized.assetRef.futureAssetField.keep, true, "compatible asset metadata is preserved");
  assert.equal(normalized.assetRef.sourceName, "Kick.wav");
}

{
  const normalized = d.normalizeInstrument(3, fixture());
  assert.equal(Object.hasOwn(normalized, "assetRef"), false, "legacy instruments do not gain serialized assetRef noise");
}

assert.throws(() => d.normalizeSampleAssetRef({}), /sha256/);
assert.throws(() => d.normalizeSampleAssetRef({
  sha256: "a".repeat(64), sampleRateHz: 48000, channelCount: 3, frameCount: 1, byteSize: 6,
}), /channelCount/);
assert.throws(() => d.normalizeSampleAssetRef({
  sha256: "a".repeat(64), sampleRateHz: 48000, channelCount: 2, frameCount: 1000, byteSize: 3998,
}), /byteSize/);
assert.throws(() => d.normalizeSampleAssetRef({
  sha256: "a".repeat(64), sampleRateHz: 48000, channelCount: 2,
  frameCount: (d.SAMPLE_ASSET_MAX_BYTES / 4) + 1, byteSize: d.SAMPLE_ASSET_MAX_BYTES + 4,
}), /byteSize/);

console.log("Production Instrument sparse domain + sample assetRef tests passed");
