const assert = require("node:assert/strict");
require("./production-instrument-domain.js");
const stores = require("./stores.js");

const model = {
  schemaVersion: 4,
  projectName: "STORE TEST",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: {},
  instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};

const project = new stores.ProjectStore(model);
const channels = { project: [], persistence: [], audio: [], render: [] };
for (const channel of Object.keys(channels)) project.subscribe(channel, (changeSet) => channels[channel].push(changeSet));

const engine = {
  id: 3,
  name: "BRK TEST",
  engineRef: {
    moduleId: "org.myldydesign.brk.test-module",
    engineId: "org.myldydesign.brk.test-engine",
    requestedVersion: "^1.0.0",
    hostContract: "1.x",
  },
  patchState: { schemaVersion: 1, encoding: "json", data: { shape: 1 } },
  parameterSnapshot: { "osc.shape": 1 },
  provenance: {}, compatibilityData: {}, unknownData: [],
};

{
  const result = project.createProductionInstrument(3, engine, { source: "test.create" });
  assert.equal(result.mutated, true);
  assert.equal(result.changeSet.schemaVersion, 5);
  assert.equal(result.changeSet.target, "project.instrumentPool.3");
  assert.deepEqual(result.changeSet.path, ["instrumentPool", 3]);
  assert.equal(result.changeSet.persistsProject, true);
  assert.equal(result.changeSet.affectsPlayback, true);
  assert.equal(project.getState().instrumentPool[3].engineRef.engineId, engine.engineRef.engineId);
  assert.equal(channels.persistence.length, 1);
  assert.equal(channels.audio.length, 1);
  assert.equal(channels.render.length, 1);
}

assert.throws(() => project.createProductionInstrument(3, engine), /already exists/);

{
  const result = project.renameProductionInstrument(3, "BASS ONE", { source: "test.rename" });
  assert.equal(result.mutated, true);
  assert.equal(project.getState().instrumentPool[3].name, "BASS ONE");
  assert.equal(result.changeSet.affectsPlayback, false);
  assert.equal(result.changeSet.schemaVersion, 5);
}

{
  const assetRef = {
    schema: "brktrk-pcm-asset-ref-v1",
    format: "pcm-s16-interleaved",
    sha256: "a".repeat(64),
    sampleRateHz: 48000,
    channelCount: 1,
    frameCount: 64,
    byteSize: 128,
    sourceName: "kick.wav",
  };
  const audioBefore = channels.audio.length;
  const result = project.setProductionInstrumentAssetRef(3, assetRef, { source: "test.asset" });
  assert.equal(result.mutated, true);
  assert.equal(result.changeSet.subtype, "instrument.asset");
  assert.equal(result.changeSet.target, "project.instrumentPool.3.assetRef");
  assert.deepEqual(result.changeSet.path, ["instrumentPool", 3, "assetRef"]);
  assert.equal(result.changeSet.affectsPlayback, true);
  assert.equal(result.changeSet.structuralPlayback, true);
  assert.equal(result.changeSet.transaction.safeBoundaryRequired, true);
  assert.equal(project.getState().instrumentPool[3].assetRef.sha256, "a".repeat(64));
  assert.equal(channels.audio.length, audioBefore + 1);

  const unchanged = project.setProductionInstrumentAssetRef(3, { ...assetRef }, { source: "test.asset.same" });
  assert.equal(unchanged.mutated, false);

  const cleared = project.setProductionInstrumentAssetRef(3, null, { source: "test.asset.clear" });
  assert.equal(cleared.mutated, true);
  assert.equal(Object.hasOwn(project.getState().instrumentPool[3], "assetRef"), false);
}

{
  const result = project.setProductionInstrumentParameter(3, "osc.shape", 7, { source: "test.param", transient: true });
  assert.equal(result.mutated, true);
  assert.equal(result.before, 1);
  assert.equal(result.after, 7);
  assert.equal(result.changeSet.target, "project.instrumentPool.3.parameterSnapshot.osc.shape");
  assert.equal(result.changeSet.transaction.parameterKey, "osc.shape");
  assert.equal(result.changeSet.transaction.transient, true);
  assert.equal(project.getState().instrumentPool[3].parameterSnapshot["osc.shape"], 7);
}

{
  const result = project.replaceProductionInstrumentPatch(
    3,
    { schemaVersion: 2, encoding: "json", data: { shape: 9, gain: 0.5 } },
    { "osc.shape": 9, "amp.gain": 0.5 },
    { source: "test.patch" },
  );
  assert.equal(result.mutated, true);
  assert.equal(result.changeSet.transaction.safeBoundaryRequired, true);
  assert.equal(project.getState().instrumentPool[3].patchState.schemaVersion, 2);
  assert.equal(project.getState().instrumentPool[3].parameterSnapshot["amp.gain"], 0.5);
}

{
  const snapshot = stores.selectors.productionInstrument(project.getState(), 3);
  assert.equal(snapshot.name, "BASS ONE");
  assert.equal(stores.PROJECT_SCHEMA_VERSION, 5);
  assert.ok(stores.PROJECT_DOMAINS.includes("instrumentPool"));
  assert.ok(stores.OWNERSHIP.project.includes("instrumentPool"));
  assert.equal(stores.PROJECT_DOMAINS.includes("instruments"), false, "legacy preview Instruments are not a durable ProjectStore domain");
}

assert.throws(() => project.renameProductionInstrument(9, "MISSING"), /does not exist/);
assert.throws(() => project.setProductionInstrumentParameter(9, "x", 1), /does not exist/);
assert.throws(() => project.setProductionInstrumentAssetRef(9, null), /does not exist/);
assert.throws(() => project.setProductionInstrumentAssetRef(3, { sha256: "bad" }), /sha256/);
assert.throws(() => project.setProductionInstrumentParameter(3, "", 1), /must not be empty/);

console.log("ProjectStore production Instrument schema-v4 semantics passed under canonical Project schema v5");
