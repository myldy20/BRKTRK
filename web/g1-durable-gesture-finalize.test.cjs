"use strict";

const assert = require("node:assert/strict");
const storeTypes = require("./stores.js");
const phraseStepTypes = require("./project-phrase-step.js");
const trackMixTypes = require("./track-mix-domain.js");
const fields = require("./field-schema.js");
const undoRedoTypes = require("./undo-redo.js");
const inputSafety = require("./input-safety.js");

const emptyStep = () => ({
  note: -1,
  velocity: 40,
  instrument: -1,
  fx: Array.from({ length: 3 }, () => ({ command: 0, value: 0 })),
});

const model = {
  schemaVersion: 4,
  projectName: "G1 DURABLE GESTURE",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: { 0: Array.from({ length: 16 }, emptyStep) },
  instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};
const state = {
  view: "phrase",
  focus: { pane: "phrase", row: 0, col: 1 },
  p3: {}, songRow: 0, track: 0, chain: 0, chainRow: 0, phrase: 0, phraseRow: 0, instrument: 3,
};

const stores = storeTypes.createStores({ model, state, trackCount: 8 });
phraseStepTypes.install(stores.project);
const trackMix = trackMixTypes.install(stores.project, { trackCount: 8 });
inputSafety.installContinuousGestureDurability(stores.project);
stores.project.createProductionInstrument(3, {
  id: 3,
  name: "G1 FIXTURE",
  engineRef: {
    moduleId: "design.myldy.fixture",
    engineId: "fixture",
    requestedVersion: "^1.0.0",
    resolvedVersion: "1.0.0",
    resolvedPackageSha256: "a".repeat(64),
    hostContract: "1.x",
  },
  patchState: { schemaVersion: 1, encoding: "opaque", data: null },
  parameterSnapshot: { cutoff: 0.25 },
  provenance: {}, compatibilityData: {}, unknownData: [],
}, { source: "g1.setup" });

const root = {
  BRKTRKStores: stores,
  setStatus() {},
  renderAll() {},
};
const history = undoRedoTypes.install(root, { projectStore: stores.project });

const channels = Object.freeze({
  project: "project",
  persistence: "persistence",
  audio: "audio",
  render: "render",
  trackMix: "track-mix",
});
const counts = Object.fromEntries(Object.keys(channels).map((key) => [key, 0]));
for (const [key, channel] of Object.entries(channels)) {
  stores.project.subscribe(channel, () => { counts[key] += 1; });
}
const snapshotCounts = () => ({ ...counts });
const delta = (before) => Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value - before[key]]));

function tx(gestureId, gestureFamily, gestureKind, gesturePhase) {
  return Object.freeze({ gestureId, gestureFamily, gestureKind, gesturePhase });
}

// Sound: all intermediate samples are immediate desired/audio/render mutations,
// but persistence/history is deferred to one explicit Store finalize.
const soundBeforeCounts = snapshotCounts();
for (const [index, value] of [0.4, 0.6, 0.8].entries()) {
  stores.project.setProductionInstrumentParameter(3, "cutoff", value, {
    source: "a4-sound-range",
    transient: true,
    transaction: tx("sound-range:durable-1", "sound", "pointer-range", index === 0 ? "begin" : "update"),
  });
}
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.8, "Sound desired state must update on every sample");
assert.deepEqual(delta(soundBeforeCounts), { project: 3, persistence: 0, audio: 3, render: 3, trackMix: 0 }, "Sound samples must skip only durable persistence fan-out");
assert.equal(history.snapshot().undoDepth, 0, "intermediate Sound samples must not consume history");

const soundPreFinalizeCounts = snapshotCounts();
const soundFinalize = stores.project.finalizeContinuousGesture({
  gestureId: "sound-range:durable-1",
  gestureFamily: "sound",
  gestureKind: "pointer-range",
  gesturePhase: "end",
  gestureEndReason: "pointerup",
});
assert.equal(soundFinalize?.committed, true, "Sound gesture must explicitly finalize");
assert.deepEqual(delta(soundPreFinalizeCounts), { project: 0, persistence: 1, audio: 0, render: 0, trackMix: 0 }, "finalize must not replay the setter/audio/render mutation");
assert.equal(history.snapshot().undoDepth, 1, "one Sound gesture must create one history entry");
assert.equal(stores.project.finalizeContinuousGesture(soundFinalize.changeSet.transaction)?.committed, false, "second finalize must be idempotent");
assert.equal(counts.persistence, soundPreFinalizeCounts.persistence + 1, "idempotent finalize must not duplicate persistence");
assert.equal(history.undo().ok, true);
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.25, "one Undo restores Sound pre-gesture value");
assert.equal(history.redo().ok, true);
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.8, "one Redo restores Sound final value");

// Mixer retains its dedicated track-mix live fan-out while persistence waits
// for one durable finalize.
const mixBeforeCounts = snapshotCounts();
for (const [index, gain] of [0.9, 0.8, 0.7].entries()) {
  trackMix.set(0, { gain }, {
    field: "gain",
    source: "track-mixer-gain-input",
    transaction: tx("mixer-range:durable-1", "mixer", "pointer-range", index === 0 ? "begin" : "update"),
  });
}
assert.equal(trackMix.get(0).gain, 0.7);
assert.deepEqual(delta(mixBeforeCounts), { project: 0, persistence: 0, audio: 0, render: 0, trackMix: 3 }, "Mixer samples must preserve dedicated live fan-out while skipping persistence");
assert.equal(history.snapshot().undoDepth, 1, "Mixer intermediates must not consume history");
const mixPreFinalizeCounts = snapshotCounts();
stores.project.finalizeContinuousGesture({
  gestureId: "mixer-range:durable-1",
  gestureFamily: "mixer",
  gestureKind: "pointer-range",
  gesturePhase: "end",
  gestureEndReason: "change",
});
assert.deepEqual(delta(mixPreFinalizeCounts), { project: 0, persistence: 1, audio: 0, render: 0, trackMix: 0 }, "Mixer finalize must be persistence-only");
assert.equal(history.snapshot().undoDepth, 2, "Mixer gesture must add exactly one history entry");
assert.equal(history.undo().ok, true);
assert.equal(trackMix.get(0).gain, 1, "one Undo restores Mixer pre-gesture value");
assert.equal(history.redo().ok, true);
assert.equal(trackMix.get(0).gain, 0.7, "one Redo restores Mixer final value");

// Tracker held-key repeat: Field Schema samples stay immediate but durable work
// waits for keyup finalize.
const env = {
  EMPTY: -1,
  NOTE_OFF: -2,
  state,
  model,
  projectStore: stores.project,
  phrase(id, create = true) {
    if (!Object.hasOwn(model.phrases, id) && create) model.phrases[id] = Array.from({ length: 16 }, emptyStep);
    return model.phrases[id];
  },
  chain(id, create = true) {
    if (!Object.hasOwn(model.chains, id) && create) model.chains[id] = [];
    return model.chains[id];
  },
  firstUnused() { return 1; },
  noteName(value) { return String(value); },
  fxName(value) { return String(value); },
};
const velocity = fields.resolve("phrase", 1);
const trackerBeforeCounts = snapshotCounts();
for (const phase of ["begin", "update", "update"]) {
  fields.adjust(env, velocity, "ArrowRight", state.focus, {
    source: "keyboard",
    transaction: tx("tracker-key:durable-1", "tracker", "keyboard-repeat", phase),
  });
}
assert.equal(model.phrases[0][0].velocity, 43);
assert.deepEqual(delta(trackerBeforeCounts), { project: 3, persistence: 0, audio: 3, render: 3, trackMix: 0 }, "tracker repeats must preserve immediate Project/audio/render fan-out without persistence");
assert.equal(history.snapshot().undoDepth, 2, "tracker repeats must not consume history");
const trackerPreFinalizeCounts = snapshotCounts();
stores.project.finalizeContinuousGesture({
  gestureId: "tracker-key:durable-1",
  gestureFamily: "tracker",
  gestureKind: "keyboard-repeat",
  gesturePhase: "end",
  gestureEndReason: "keyup",
});
assert.deepEqual(delta(trackerPreFinalizeCounts), { project: 0, persistence: 1, audio: 0, render: 0, trackMix: 0 }, "tracker finalize must be persistence-only");
assert.equal(history.snapshot().undoDepth, 3, "held tracker edit must be one history entry");
assert.equal(history.undo().ok, true);
assert.equal(model.phrases[0][0].velocity, 40, "one Undo restores tracker pre-gesture value");
assert.equal(history.redo().ok, true);
assert.equal(model.phrases[0][0].velocity, 43, "one Redo restores tracker final value");

// Non-gesture edits retain their existing immediate durable contract.
const normalBefore = counts.persistence;
stores.project.renameProject("NORMAL DURABLE EDIT", { source: "g1.normal" });
assert.equal(counts.persistence, normalBefore + 1, "ordinary non-gesture Project mutations remain immediately durable");

// Current input owners keep a stable target, but a future multi-target audible
// gesture must fall back conservatively instead of pretending it can use one
// scalar/path restore contract.
const multiId = "tracker-key:multi-target";
fields.adjust(env, velocity, "ArrowRight", state.focus, {
  source: "g1.multi-target",
  transaction: tx(multiId, "tracker", "keyboard-repeat", "begin"),
});
const instrument = fields.resolve("phrase", 2);
fields.adjust(env, instrument, "ArrowRight", { ...state.focus, col: 2 }, {
  source: "g1.multi-target",
  transaction: tx(multiId, "tracker", "keyboard-repeat", "update"),
});
const multiFinalize = stores.project.finalizeContinuousGesture({
  gestureId: multiId,
  gestureFamily: "tracker",
  gestureKind: "keyboard-repeat",
  gesturePhase: "end",
  gestureEndReason: "keyup",
});
assert.equal(multiFinalize.committed, true);
assert.equal(multiFinalize.changeSet.subtype, "gesture.commit", "multi-target gesture must use generic durable changeSet");
assert.equal(multiFinalize.changeSet.transaction.gestureStableTarget, false);
assert.equal(multiFinalize.changeSet.structuralPlayback, true, "audible multi-target fallback must restore conservatively");

console.log("G1 transient-vs-durable gesture finalize + one-history contract passed");
