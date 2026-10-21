"use strict";

// G1 focused contract: real continuous input families own explicit interaction
// identity without clocks. UI/controller lifecycle produces gesture metadata;
// Store/domain layers preserve it in changeSet.transaction.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const storeTypes = require("./stores.js");
const phraseStepTypes = require("./project-phrase-step.js");
const trackMixTypes = require("./track-mix-domain.js");
const fields = require("./field-schema.js");
const inputSafety = require("./input-safety.js");

const inputSafetySource = fs.readFileSync(require.resolve("./input-safety.js"), "utf8");
for (const forbidden of ["requestAnimationFrame", "setTimeout", "setInterval"]) {
  assert.equal(inputSafetySource.includes(forbidden), false, `continuous gesture attribution must not use ${forbidden}`);
}

const emptyStep = () => ({
  note: -1,
  velocity: 40,
  instrument: -1,
  fx: Array.from({ length: 3 }, () => ({ command: 0, value: 0 })),
});
const model = {
  schemaVersion: 4,
  projectName: "G1 GESTURE ATTRIBUTION",
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
const gestures = inputSafety.createContinuousGestureController();
inputSafety.decorateProjectStore(stores.project, gestures);
const previousInputSafety = globalThis.BRKTRKInputSafety;
globalThis.BRKTRKInputSafety = Object.freeze({
  currentContinuousTransaction: gestures.currentContinuousTransaction,
});

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

function assertSameGesture(actual, expected, label) {
  assert.equal(actual?.gestureId, expected?.gestureId, `${label}: gestureId`);
  assert.equal(actual?.gestureFamily, expected?.gestureFamily, `${label}: gestureFamily`);
  assert.equal(actual?.gestureKind, expected?.gestureKind, `${label}: gestureKind`);
}
function assertGesture(changeSet, expected, label) {
  assertSameGesture(changeSet.transaction, expected, label);
  assert.equal(changeSet.transaction?.gesturePhase, expected.gesturePhase, `${label}: gesturePhase`);
}

// Sound pointer lifecycle: pointerdown -> input(s) -> pointerup -> native change.
// Pointerup leaves only a bounded pending-finalization identity so the native
// change remains in the same gesture; no clock/window heuristic is involved.
const soundRange = {};
const soundBegin = gestures.beginRange(soundRange, "sound", 11);
const soundSample1 = gestures.sampleRange(soundRange, "sound");
const soundSample2 = gestures.sampleRange(soundRange, "sound");
assertSameGesture(soundSample1, soundBegin, "Sound first input");
assertSameGesture(soundSample2, soundBegin, "Sound repeated input");
assert.equal(soundSample1.gesturePhase, "update");
const sound = gestures.withContinuousTransaction(soundSample2, () => (
  stores.project.setProductionInstrumentParameter(3, "cutoff", 0.5, {
    source: "a4-sound-range",
    transient: true,
  })
));
assert.equal(sound.changeSet.transaction.instrumentId, 3);
assert.equal(sound.changeSet.transaction.parameterKey, "cutoff");
assert.equal(sound.changeSet.transaction.transient, true);
assertGesture(sound.changeSet, soundSample2, "Sound range mutation");
const soundPointerUp = gestures.endRangePointer(soundRange, 11);
const soundChange = gestures.changeRange(soundRange, "sound");
assertSameGesture(soundPointerUp, soundBegin, "Sound pointerup");
assertSameGesture(soundChange, soundBegin, "Sound native change");
assert.equal(soundPointerUp.gestureEndReason, "pointerup");
assert.equal(soundChange.gesturePhase, "end");
assert.equal(soundChange.gestureEndReason, "change");

// pointercancel terminates identity. A later native change must not be folded
// into the cancelled gesture.
const cancelledRange = {};
const cancelledBegin = gestures.beginRange(cancelledRange, "sound", 12);
const cancelled = gestures.cancelRange(cancelledRange, 12);
const afterCancelChange = gestures.changeRange(cancelledRange, "sound");
assertSameGesture(cancelled, cancelledBegin, "Sound pointercancel");
assert.equal(cancelled.gesturePhase, "cancel");
assert.notEqual(afterCancelChange.gestureId, cancelledBegin.gestureId, "native change after cancel starts a new identity");
assert.equal(afterCancelChange.gestureKind, "native-range");

// blur is a deterministic end boundary even when no native change arrives.
const blurredRange = {};
const blurredBegin = gestures.beginRange(blurredRange, "sound", 13);
const blurred = gestures.blurRange(blurredRange);
const afterBlurSample = gestures.sampleRange(blurredRange, "sound");
assertSameGesture(blurred, blurredBegin, "Sound blur");
assert.equal(blurred.gestureEndReason, "blur");
assert.notEqual(afterBlurSample.gestureId, blurredBegin.gestureId, "input after blur starts a new identity");

// Mixer range uses the same controller context but Track Mix remains the
// authoritative owner of track/field metadata.
const mixerRange = {};
const mixBegin = gestures.beginRange(mixerRange, "mixer", 21);
const mixSample = gestures.sampleRange(mixerRange, "mixer");
const mix = gestures.withContinuousTransaction(mixSample, () => trackMix.set(0, { gain: 0.8 }, {
  field: "gain",
  source: "track-mixer-gain-input",
}));
assert.equal(mix.changeSet.transaction.track, 0);
assert.equal(mix.changeSet.transaction.field, "gain");
assertGesture(mix.changeSet, mixSample, "Mixer range mutation");
assertSameGesture(gestures.endRangePointer(mixerRange, 21), mixBegin, "Mixer pointerup");
assertSameGesture(gestures.changeRange(mixerRange, "mixer"), mixBegin, "Mixer change");

// Mixer vertical pan drag reuses one pointer identity for all move samples and
// terminates explicitly on pointerup/cancel.
const panBegin = gestures.beginPointer(31, "mixer", {});
const panMove1 = gestures.samplePointer(31);
const panMove2 = gestures.samplePointer(31);
assertSameGesture(panMove1, panBegin, "Mixer pan move 1");
assertSameGesture(panMove2, panBegin, "Mixer pan move 2");
assert.equal(panMove2.gesturePhase, "update");
const panEnd = gestures.endPointer(31, false);
assertSameGesture(panEnd, panBegin, "Mixer pan pointerup");
assert.equal(panEnd.gesturePhase, "end");
const panCancelBegin = gestures.beginPointer(32, "mixer", {});
const panCancel = gestures.endPointer(32, true);
assertSameGesture(panCancel, panCancelBegin, "Mixer pan pointercancel");
assert.equal(panCancel.gesturePhase, "cancel");

// Tracker held-key/repeat: one keydown identity survives all repeat samples and
// field-schema.adjust must not drop the source/transaction options on the way to
// Phrase-step storage.
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
const trackerBegin = gestures.sampleKey("ArrowRight", "tracker", false);
const trackerRepeat1 = gestures.sampleKey("ArrowRight", "tracker", true);
const trackerRepeat2 = gestures.sampleKey("ArrowRight", "tracker", true);
assertSameGesture(trackerRepeat1, trackerBegin, "Tracker repeat 1");
assertSameGesture(trackerRepeat2, trackerBegin, "Tracker repeat 2");
const tracker = gestures.withContinuousTransaction(trackerRepeat2, () => fields.adjust(
  env,
  velocity,
  "ArrowRight",
  state.focus,
  { source: "keyboard" },
));
assert.equal(tracker.projectChangeSet?.source, "keyboard", "Tracker adjust must preserve source metadata");
assertGesture(tracker.projectChangeSet, trackerRepeat2, "Tracker held-key repeat mutation");
const trackerEnd = gestures.endKey("ArrowRight");
assertSameGesture(trackerEnd, trackerBegin, "Tracker keyup");
assert.equal(trackerEnd.gestureEndReason, "keyup");
const nextTrackerGesture = gestures.sampleKey("ArrowRight", "tracker", false);
assert.notEqual(nextTrackerGesture.gestureId, trackerBegin.gestureId, "new keydown starts a new tracker gesture");
gestures.endKey("ArrowRight");

// The same canonical field boundary must preserve ambient tracker identity for
// insert/clear/reset, not only adjust. These operations intentionally omit an
// explicit source/transaction so the controller-owned inputSource is exercised.
const trackerOpsGesture = gestures.sampleKey("ArrowDown", "tracker", false);
const trackerOps = gestures.withContinuousTransaction(trackerOpsGesture, () => [
  fields.insert(env, velocity, {}, state.focus),
  fields.clear(env, velocity, state.focus),
  fields.reset(env, velocity, state.focus),
]);
for (const [index, mutation] of trackerOps.entries()) {
  const label = ["insert", "clear", "reset"][index];
  assert.equal(mutation.projectChangeSet?.source, "keyboard", `Tracker ${label}: source`);
  assertGesture(mutation.projectChangeSet, trackerOpsGesture, `Tracker ${label}`);
}
assertSameGesture(gestures.endKey("ArrowDown"), trackerOpsGesture, "Tracker field operations keyup");

// Explicit transaction metadata always wins over ambient UI context.
const ambient = gestures.sampleKey("ArrowUp", "sound", false);
const explicit = Object.freeze({
  gestureId: "explicit-sound:1",
  gestureFamily: "sound",
  gestureKind: "programmatic-explicit",
  gesturePhase: "update",
});
const explicitSound = gestures.withContinuousTransaction(ambient, () => (
  stores.project.setProductionInstrumentParameter(3, "cutoff", 0.6, {
    source: "g1-explicit-precedence",
    transient: true,
    transaction: explicit,
  })
));
assertGesture(explicitSound.changeSet, explicit, "Explicit transaction precedence");
gestures.endKey("ArrowUp");

assert.equal(gestures.currentContinuousTransaction(), null, "synchronous transaction context must clear after mutation");
if (previousInputSafety === undefined) delete globalThis.BRKTRKInputSafety;
else globalThis.BRKTRKInputSafety = previousInputSafety;

console.log("G1 explicit continuous gesture lifecycle + mutation attribution contract passed");
