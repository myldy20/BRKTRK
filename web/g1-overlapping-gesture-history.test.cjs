"use strict";

const assert = require("node:assert/strict");
const storeTypes = require("./stores.js");
const undoRedoTypes = require("./undo-redo.js");
const inputSafety = require("./input-safety.js");

const model = {
  schemaVersion: 4,
  projectName: "G1 OVERLAP",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: {},
  instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};
const state = {
  view: "sound",
  focus: { pane: "phrase", row: 0, col: 0 },
  p3: { activeWorkspace: "sound", soundParam: 0, parents: [], mixReturn: null },
  songRow: 0, track: 0, chain: 0, chainRow: 0, phrase: 0, phraseRow: 0, instrument: 3,
};

const stores = storeTypes.createStores({ model, state, trackCount: 8 });
inputSafety.installContinuousGestureDurability(stores.project);
stores.project.createProductionInstrument(3, {
  id: 3,
  name: "OVERLAP FIXTURE",
  engineRef: {
    moduleId: "design.myldy.fixture",
    engineId: "fixture",
    requestedVersion: "^1.0.0",
    resolvedVersion: "1.0.0",
    resolvedPackageSha256: "a".repeat(64),
    hostContract: "1.x",
  },
  patchState: { schemaVersion: 1, encoding: "opaque", data: null },
  parameterSnapshot: { cutoff: 0.25, resonance: 0.1 },
  provenance: {}, compatibilityData: {}, unknownData: [],
}, { source: "g1.overlap.setup" });

const root = { BRKTRKStores: stores, setStatus() {}, renderAll() {} };
const history = undoRedoTypes.install(root, { projectStore: stores.project });

function tx(gestureId, parameterKey, phase) {
  return {
    gestureId,
    gestureFamily: "sound",
    gestureKind: "pointer-range",
    gesturePhase: phase,
    parameterKey,
  };
}

// Two controls can be active before either durable finalize. Their history
// identity must remain independent even though the current Project already
// contains both live values when the first persistence event is published.
stores.project.setProductionInstrumentParameter(3, "cutoff", 0.6, {
  source: "g1.overlap.cutoff",
  transient: true,
  transaction: tx("sound-range:overlap-a", "cutoff", "begin"),
});
stores.project.setProductionInstrumentParameter(3, "resonance", 0.3, {
  source: "g1.overlap.resonance",
  transient: true,
  transaction: tx("sound-range:overlap-b", "resonance", "begin"),
});

stores.project.finalizeContinuousGesture({
  gestureId: "sound-range:overlap-a",
  gestureFamily: "sound",
  gestureKind: "pointer-range",
  gesturePhase: "end",
  gestureEndReason: "pointerup",
});
stores.project.finalizeContinuousGesture({
  gestureId: "sound-range:overlap-b",
  gestureFamily: "sound",
  gestureKind: "pointer-range",
  gesturePhase: "end",
  gestureEndReason: "pointerup",
});

assert.equal(history.snapshot().undoDepth, 2, "overlapping stable-target gestures must create two independent history entries");

assert.equal(history.undo().ok, true);
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.6, "Undo B must preserve A final value");
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.resonance, 0.1, "Undo B restores only B pre-gesture value");

assert.equal(history.undo().ok, true);
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.25, "Undo A restores A pre-gesture value");
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.resonance, 0.1, "Undo A must preserve already-undone B");

assert.equal(history.redo().ok, true);
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.6, "Redo A restores A final value");
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.resonance, 0.1, "Redo A must not replay B");

assert.equal(history.redo().ok, true);
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.6, "Redo B must preserve A");
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.resonance, 0.3, "Redo B restores B final value");

console.log("G1 overlapping gesture history isolation passed");
