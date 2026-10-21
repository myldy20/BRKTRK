const assert = require("node:assert/strict");
require("./production-instrument-domain.js");
const stores = require("./stores.js");
const presetDomain = require("./project-instrument-preset.js");

const model = {
  schemaVersion: 4,
  projectName: "PRESET STORE",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {}, phrases: {}, instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};
const project = new stores.ProjectStore(model);
project.createProductionInstrument(7, {
  name: "SYNTH",
  engineRef: {
    moduleId: "design.myldy.fixture",
    engineId: "fixture",
    requestedVersion: "1.2.3",
    resolvedVersion: "1.2.3",
    resolvedPackageSha256: "a".repeat(64),
    hostContract: "brktrk-synth-gateway-v1",
  },
  patchState: { schemaVersion: 1, encoding: "base64", data: null },
  parameterSnapshot: { cutoff: 1, level: 0.5 },
});
const domain = presetDomain.install(project);
assert.equal(project.instrumentPresets, domain);

const seen = { project: [], persistence: [], audio: [], render: [] };
for (const channel of Object.keys(seen)) project.subscribe(channel, (changeSet) => seen[channel].push(changeSet));

const preset = Object.freeze({
  id: "factory-dark",
  name: "Dark",
  bank: "Factory",
  origin: "brk",
  readOnly: true,
  applicable: true,
  patchState: Object.freeze({ schemaVersion: 1, encoding: "base64", data: "AQIDBA==" }),
  parameterSnapshot: Object.freeze({ cutoff: 0.2, level: 0.75 }),
});
const result = domain.apply(7, preset, { source: "test.preset" });
assert.equal(result.mutated, true);
assert.equal(result.changeSet.subtype, "instrument.preset");
assert.equal(result.changeSet.target, "project.instrumentPool.7.preset");
assert.equal(result.changeSet.transaction.safeBoundaryRequired, true);
assert.equal(result.changeSet.transaction.presetId, "factory-dark");
assert.equal(result.changeSet.affectsPlayback, true);
assert.equal(result.changeSet.persistsProject, true);
assert.deepEqual(result.changeSet.renderTargets, ["instrument.context"]);
for (const channel of Object.keys(seen)) assert.equal(seen[channel].length, 1, `${channel} must receive one atomic preset changeSet`);

const instrument = project.getState().instrumentPool[7];
assert.equal(instrument.patchState.data, "AQIDBA==");
assert.deepEqual(instrument.parameterSnapshot, { cutoff: 0.2, level: 0.75 });
assert.deepEqual(instrument.presetRef, {
  id: "factory-dark",
  name: "Dark",
  bank: "Factory",
  origin: "brk",
  readOnly: true,
  moduleId: "design.myldy.fixture",
  engineId: "fixture",
  version: "1.2.3",
  packageSha256: "a".repeat(64),
});

const unchanged = domain.apply(7, preset, { source: "test.same" });
assert.equal(unchanged.mutated, false);
for (const channel of Object.keys(seen)) assert.equal(seen[channel].length, 1, `${channel} must not receive no-op preset mutation`);

assert.throws(() => domain.apply(7, { ...preset, applicable: false }), /verified applicable/);
assert.throws(() => domain.apply(8, preset), /does not exist/);
assert.equal(project.getState().instrumentPool[7].presetRef.id, "factory-dark", "failed preset attempts must not partially mutate the Instrument");

console.log("A4B1 atomic production Instrument preset mutation passed");