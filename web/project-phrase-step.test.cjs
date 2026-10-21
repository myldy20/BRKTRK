const assert = require("node:assert/strict");
const storeTypes = require("./stores.js");
const phraseStepTypes = require("./project-phrase-step.js");

const emptyStep = () => ({
  note: -1,
  velocity: 100,
  instrument: -1,
  fx: [
    { command: 1, value: 0x11 },
    { command: 4, value: 0x22 },
    { command: 0xE1, value: 0x33 },
  ],
  condition: { probability: 100, every: 1, offset: 0 },
  parameterEvents: [],
});
const model = {
  projectName: "TEST",
  tempo: 120,
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: { 0: Array.from({ length: 16 }, emptyStep) },
  instruments: Array.from({ length: 16 }, (_, id) => ({ id })),
};
const store = new storeTypes.ProjectStore(model, { trackCount: 8 });
const domain = phraseStepTypes.install(store);
assert.equal(store.phraseSteps, domain);

const counts = { project: 0, persistence: 0, audio: 0, render: 0 };
const changes = [];
for (const channel of Object.keys(counts)) {
  store.subscribe(channel, (changeSet) => {
    counts[channel] += 1;
    changes.push({ channel, changeSet });
  });
}

let mutation = domain.setField(0, 0, "note", 60, { source: "unit-note" });
assert.equal(mutation.after, 60);
assert.equal(model.phrases[0][0].note, 60);
assert.equal(mutation.changeSet.owner, "project");
assert.equal(mutation.changeSet.subtype, "phrase.note");
assert.equal(mutation.changeSet.target, "phrase.note");
assert.deepEqual(mutation.changeSet.path, ["phrases", 0, 0, "note"]);
assert.equal(mutation.changeSet.affectsPlayback, true);
assert.equal(mutation.changeSet.persistsProject, true);
assert.deepEqual(mutation.changeSet.renderTargets, ["phrase.row.0.0", "note.editor"]);
assert.deepEqual(counts, { project: 1, persistence: 1, audio: 1, render: 1 });

mutation = domain.setField(0, 0, "note", -2, { source: "unit-off" });
assert.equal(mutation.after, -2, "Note Off must remain distinct");
mutation = domain.setField(0, 0, "note", -1, { source: "unit-empty" });
assert.equal(mutation.after, -1, "Empty must remain distinct from Note Off");

mutation = domain.setField(0, 0, "velocity", 999, { source: "unit-velocity" });
assert.equal(mutation.after, 127);
assert.equal(model.phrases[0][0].velocity, 127);
assert.equal(mutation.changeSet.subtype, "phrase.velocity");

mutation = domain.setField(0, 0, "instrument", 3, { source: "unit-instrument" });
assert.equal(mutation.after, 3);
assert.equal(model.phrases[0][0].instrument, 3);
assert.ok(mutation.changeSet.renderTargets.includes("instrument.context"));

const fxBefore = structuredClone(model.phrases[0][1].fx);
const transaction = Object.freeze({
  kind: "prepared-note-entry",
  target: "phrase.step",
  phrase: 0,
  row: 1,
  fields: Object.freeze(["note", "velocity", "instrument"]),
});
mutation = domain.writeStep(0, 1, { note: 64, velocity: 93, instrument: 5 }, {
  source: "unit-prepared",
  transaction,
});
assert.deepEqual(mutation.before, { note: -1, velocity: 100, instrument: -1 });
assert.deepEqual(mutation.after, { note: 64, velocity: 93, instrument: 5 });
assert.deepEqual(model.phrases[0][1].fx, fxBefore, "prepared entry must not touch FX slots");
assert.equal(mutation.changeSet.target, "phrase.step");
assert.equal(mutation.changeSet.subtype, "phrase.step");
assert.deepEqual(mutation.changeSet.path, ["phrases", 0, 1]);
assert.deepEqual(mutation.changeSet.transaction, transaction);
assert.ok(mutation.changeSet.renderTargets.includes("phrase.row.0.1"));
assert.ok(mutation.changeSet.renderTargets.includes("instrument.context"));

const countsBeforeNoop = { ...counts };
mutation = domain.writeStep(0, 1, { note: 64, velocity: 93, instrument: 5 }, { source: "unit-noop" });
assert.equal(mutation.mutated, false);
assert.deepEqual(counts, countsBeforeNoop, "no-op Phrase writes must not notify subscribers");

assert.deepEqual(domain.read(0, 1), {
  note: 64,
  velocity: 93,
  instrument: 5,
  fx: fxBefore,
  condition: { probability: 100, every: 1, offset: 0 },
  parameterEvents: [],
});

const countsBeforeCondition = { ...counts };
mutation = domain.setCondition(0, 1, { probability: -10, every: 99, offset: 99 }, { source: "unit-condition" });
assert.deepEqual(mutation.after, { probability: 0, every: 16, offset: 15 });
assert.deepEqual(model.phrases[0][1].condition, mutation.after);
assert.equal(mutation.changeSet.subtype, "phrase.condition");
assert.equal(mutation.changeSet.target, "phrase.condition");
assert.deepEqual(mutation.changeSet.path, ["phrases", 0, 1, "condition"]);
assert.equal(mutation.changeSet.affectsPlayback, true);
assert.equal(mutation.changeSet.persistsProject, true);
assert.deepEqual(counts, {
  project: countsBeforeCondition.project + 1,
  persistence: countsBeforeCondition.persistence + 1,
  audio: countsBeforeCondition.audio + 1,
  render: countsBeforeCondition.render + 1,
});

const parameterEvents = [
  { instrumentId: 5, parameterId: "filter.cutoff", value: 0.75, interpolationOut: "linear" },
  { instrumentId: 2, parameterId: "amp.gain", value: 0.5, interpolationOut: "step" },
];
const countsBeforeParameterEvents = { ...counts };
mutation = domain.setParameterEvents(0, 1, parameterEvents, { source: "unit-parameter-events" });
assert.deepEqual(mutation.after, [parameterEvents[1], parameterEvents[0]], "ParameterEvents must canonicalize in stable target order");
assert.deepEqual(domain.readParameterEvents(0, 1), mutation.after);
assert.equal(mutation.changeSet.subtype, "phrase.parameterEvents");
assert.equal(mutation.changeSet.target, "phrase.parameterEvents");
assert.deepEqual(mutation.changeSet.path, ["phrases", 0, 1, "parameterEvents"]);
assert.deepEqual(counts, {
  project: countsBeforeParameterEvents.project + 1,
  persistence: countsBeforeParameterEvents.persistence + 1,
  audio: countsBeforeParameterEvents.audio + 1,
  render: countsBeforeParameterEvents.render + 1,
});

const conditionBeforePreparedEdit = structuredClone(model.phrases[0][1].condition);
const parameterEventsBeforePreparedEdit = structuredClone(model.phrases[0][1].parameterEvents);
mutation = domain.writeStep(0, 1, { note: 65, velocity: 94, instrument: 5 }, { source: "unit-condition-preserve" });
assert.deepEqual(model.phrases[0][1].condition, conditionBeforePreparedEdit, "ordinary Note entry must not overwrite the independent condition");
assert.deepEqual(model.phrases[0][1].parameterEvents, parameterEventsBeforePreparedEdit, "ordinary Note entry must not overwrite authored ParameterEvents");
assert.deepEqual(model.phrases[0][1].fx, fxBefore, "ordinary Note entry must still leave FX independent from conditions");

const conditionNoopCounts = { ...counts };
mutation = domain.setCondition(0, 1, { probability: 0, every: 16, offset: 15 }, { source: "unit-condition-noop" });
assert.equal(mutation.mutated, false);
assert.deepEqual(counts, conditionNoopCounts, "no-op condition edits must not notify subscribers");

const countsBeforeFx = { ...counts };
mutation = domain.setFxComponent(0, 1, 0, "command", 5, { source: "unit-fx-command" });
assert.equal(mutation.value, 5);
assert.equal(mutation.slotValue.command, 5);
assert.equal(mutation.slotValue.value, 0x11);
assert.deepEqual(model.phrases[0][1].fx[0], { command: 5, value: 0x11 });
assert.equal(mutation.changeSet.subtype, "phrase.fx.command");
assert.equal(mutation.changeSet.target, "phrase.fx.command");
assert.deepEqual(mutation.changeSet.path, ["phrases", 0, 1, "fx", 0, "command"]);
assert.equal(mutation.changeSet.affectsPlayback, true, "M4.1C FX edits must participate in live playback refresh");
assert.equal(mutation.changeSet.persistsProject, true);
assert.deepEqual(counts, {
  project: countsBeforeFx.project + 1,
  persistence: countsBeforeFx.persistence + 1,
  audio: countsBeforeFx.audio + 1,
  render: countsBeforeFx.render + 1,
}, "M4.1C compound FX mutations must notify the audio/playback-refresh channel exactly once");

const countsBeforeValue = { ...counts };
mutation = domain.setFxComponent(0, 1, 0, "value", 0xA7, { source: "unit-fx-value" });
assert.equal(mutation.value, 0xA7);
assert.deepEqual(domain.readFxSlot(0, 1, 0), { command: 5, value: 0xA7 });
assert.equal(mutation.changeSet.affectsPlayback, true);
assert.deepEqual(counts, {
  project: countsBeforeValue.project + 1,
  persistence: countsBeforeValue.persistence + 1,
  audio: countsBeforeValue.audio + 1,
  render: countsBeforeValue.render + 1,
});

const countsBeforeUnknown = { ...counts };
mutation = domain.setFxSlot(0, 1, 2, { command: 0xE7, value: 0xC4 }, { source: "unit-unknown-fx" });
assert.deepEqual(mutation.value, { command: 0xE7, value: 0xC4 }, "unknown command/value bytes must be preserved");
assert.deepEqual(domain.readFxSlot(0, 1, 2), { command: 0xE7, value: 0xC4 });
assert.equal(mutation.changeSet.affectsPlayback, true, "unknown FX stays inert at runtime but changing it still rebuilds the deterministic program snapshot");
assert.equal(counts.audio, countsBeforeUnknown.audio + 1);

mutation = domain.setFxSlot(0, 1, 1, { command: 0, value: 0xFF }, { source: "unit-none-fx" });
assert.deepEqual(mutation.value, { command: 0, value: 0 }, "NONE must clear its value byte");

const noOpBefore = { ...counts };
mutation = domain.setFxComponent(0, 1, 0, "value", 0xA7, { source: "unit-fx-noop" });
assert.equal(mutation.mutated, false);
assert.deepEqual(counts, noOpBefore, "no-op FX edits must not notify subscribers");

const beforeAtomicCounts = { ...counts };
const atomicRows = [
  {
    note: 48,
    velocity: 88,
    instrument: 2,
    fx: [
      { command: 4, value: 0x40 },
      { command: 5, value: 0x60 },
      { command: 0xE7, value: 0xC4 },
    ],
    condition: { probability: 35, every: 4, offset: 2 },
    parameterEvents: [
      { instrumentId: 2, parameterId: "filter.cutoff", value: 0.4, interpolationOut: "step" },
    ],
  },
  {
    note: -2,
    velocity: 101,
    instrument: 7,
    fx: [
      { command: 1, value: 0x03 },
      { command: 0, value: 0 },
      { command: 4, value: 0x08 },
    ],
    condition: { probability: 100, every: 1, offset: 0 },
    parameterEvents: [
      { instrumentId: 7, parameterId: "amp.gain", value: 0.8, interpolationOut: "linear" },
    ],
  },
];
mutation = domain.replaceRows(0, 6, atomicRows, {
  source: "unit-m42b-paste",
  transaction: { kind: "phrase-row-paste", rowCount: 2 },
});
assert.equal(mutation.mutated, true);
assert.equal(mutation.rowCount, 2);
assert.equal(mutation.clipped, false);
assert.equal(mutation.changeSet.subtype, "phrase.rows");
assert.equal(mutation.changeSet.target, "phrase.rows");
assert.deepEqual(mutation.changeSet.path, ["phrases", 0, 6, 2]);
assert.deepEqual(domain.read(0, 6), atomicRows[0], "atomic row replacement must include all compound FX bytes");
assert.deepEqual(domain.read(0, 7), atomicRows[1]);
assert.deepEqual(counts, {
  project: beforeAtomicCounts.project + 1,
  persistence: beforeAtomicCounts.persistence + 1,
  audio: beforeAtomicCounts.audio + 1,
  render: beforeAtomicCounts.render + 1,
}, "one multi-row replacement must publish one Project persistence boundary");

const beforeClipCounts = { ...counts };
mutation = domain.replaceRows(0, 15, atomicRows, { source: "unit-m42b-clipped" });
assert.equal(mutation.rowCount, 1);
assert.equal(mutation.requestedRowCount, 2);
assert.equal(mutation.clipped, true, "row replacement must clip at 0F without wrapping");
assert.deepEqual(domain.read(0, 15), atomicRows[0]);
assert.deepEqual(counts, {
  project: beforeClipCounts.project + 1,
  persistence: beforeClipCounts.persistence + 1,
  audio: beforeClipCounts.audio + 1,
  render: beforeClipCounts.render + 1,
});

const beforeClearCounts = { ...counts };
mutation = domain.clearRows(0, 6, 2, { source: "unit-m42b-clear" });
assert.equal(mutation.rowCount, 2);
assert.deepEqual(domain.read(0, 6), {
  note: -1,
  velocity: 100,
  instrument: -1,
  fx: [
    { command: 0, value: 0 },
    { command: 0, value: 0 },
    { command: 0, value: 0 },
  ],
  condition: { probability: 100, every: 1, offset: 0 },
  parameterEvents: [],
});
assert.deepEqual(domain.read(0, 7), domain.read(0, 6));
assert.deepEqual(counts, {
  project: beforeClearCounts.project + 1,
  persistence: beforeClearCounts.persistence + 1,
  audio: beforeClearCounts.audio + 1,
  render: beforeClearCounts.render + 1,
}, "one multi-row clear must publish one Project persistence boundary");

assert.throws(() => domain.replaceRows(0, 0, []), /at least one row/);
assert.throws(() => domain.setField(4, 0, "note", 60), /does not exist/);
assert.throws(() => domain.setField(0, 0, "fx", 1), /Unsupported/);
assert.throws(() => domain.setFxComponent(0, 0, 0, "bogus", 1), /Unsupported Phrase FX component/);

console.log("ProjectStore Phrase-step compound FX and M4.2B atomic row tests passed");
