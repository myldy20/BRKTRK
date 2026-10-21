const assert = require("node:assert/strict");
require("./production-instrument-domain.js");
const fx = require("./track-insert-fx-domain.js");
const stores = require("./stores.js");

const model = {
  schemaVersion: 4,
  projectName: "INSERT FX TEST",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {}, phrases: {}, instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};
const project = new stores.ProjectStore(model);
const channels = { project: [], persistence: [], "track-insert-fx": [], render: [], audio: [] };
for (const channel of Object.keys(channels)) project.subscribe(channel, (changeSet) => channels[channel].push(changeSet));

for (const track of project.getState().tracks) {
  assert.equal(track.insertFx.length, 2);
  assert.deepEqual(track.insertFx.map((slot) => slot.module), ["off", "off"]);
}

{
  const result = project.selectTrackInsertFxModule(2, 0, "saturation", { source: "test.module" });
  assert.equal(result.mutated, true);
  assert.equal(result.changeSet.structuralPlayback, false);
  assert.equal(result.changeSet.affectsPlayback, true);
  assert.deepEqual(result.after.values.slice(0, 4), [80, 220, 128, 255]);
  assert.equal(project.getState().tracks[2].insertFx[0].module, "saturation");
  assert.equal(channels.persistence.length, 1);
  assert.equal(channels["track-insert-fx"].length, 1);
  assert.equal(channels.audio.length, 0, "dedicated insert-FX runtime owns live delivery");
}

{
  const result = project.setTrackInsertFxParameter(2, 0, 0, 999, { source: "test.param" });
  assert.equal(result.after.values[0], 255);
  assert.equal(result.changeSet.transaction.parameterIndex, 0);
  assert.equal(result.changeSet.structuralPlayback, false);
}

{
  const result = project.setTrackInsertFxBypass(2, 0, true, { source: "test.bypass" });
  assert.equal(result.after.bypass, true);
  assert.equal(project.getState().tracks[2].insertFx[0].bypass, true);
}

{
  project.selectTrackInsertFxModule(2, 1, "phaser", { source: "test.slot2" });
  const slot = project.getState().tracks[2].insertFx[1];
  assert.equal(slot.module, "phaser");
  assert.deepEqual(slot.values.slice(0, 5), [60, 160, 144, 128, 0]);
  for (let index = 0; index < fx.descriptor(slot.module).parameters.length; index += 1) {
    assert.ok(Number.isInteger(slot.values[index]), `parameter ${index} must stay byte/discrete-owned`);
  }
}

assert.throws(() => project.selectTrackInsertFxModule(8, 0, "chorus"), /track is out of range/);
assert.throws(() => project.selectTrackInsertFxModule(0, 2, "chorus"), /slot is out of range/);
assert.throws(() => project.setTrackInsertFxParameter(0, 0, 0, 1), /parameter is out of range/);

console.log("ProjectStore Track Insert FX two-slot ownership contract passed");
