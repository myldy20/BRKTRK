"use strict";

const assert = require("node:assert/strict");
const storeTypes = require("./stores.js");
const inputSafety = require("./input-safety.js");
const sessionDomain = require("./project-file-session.js");
const undoRedoTypes = require("./undo-redo.js");

function projectFixture() {
  return {
    schemaVersion: 4,
    projectName: "G1 OPEN BASELINE",
    tempo: 120,
    tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
    song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
    chains: {}, phrases: {}, instrumentPool: {},
    tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
    sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
  };
}

const model = projectFixture();
const state = {
  view: "sound", dock: "sound", songRow: 0, track: 0, chain: 0, chainRow: 0, phrase: 0, phraseRow: 0, instrument: 3,
  focus: { pane: "phrase", row: 0, col: 0 }, lastChain: 0, lastPhrase: 0,
  p3: { activeWorkspace: "sound", soundParam: 0, parents: [], mixReturn: null },
};
const stores = storeTypes.createStores({ model, state, trackCount: 8 });
inputSafety.installContinuousGestureDurability(stores.project);
stores.project.createProductionInstrument(3, {
  id: 3,
  name: "OPEN BASELINE FIXTURE",
  engineRef: {
    moduleId: "design.myldy.fixture", engineId: "fixture", requestedVersion: "^1.0.0", resolvedVersion: "1.0.0",
    resolvedPackageSha256: "a".repeat(64), hostContract: "1.x",
  },
  patchState: { schemaVersion: 1, encoding: "opaque", data: null },
  parameterSnapshot: { cutoff: 0.25 },
  provenance: {}, compatibilityData: {}, unknownData: [],
}, { source: "g1.open.setup" });

const writes = [];
const handle = { name: "g1-open-baseline.brktrk" };
const root = {
  BRKTRK_VERSION: "g1-test",
  BRKTRKStores: stores,
  BRKTRKCommands: { installed: true },
  BRKTRKUndoRedo: { reset() {} },
  BRKTRKSelectionClipboard: { cancelSelection() {} },
  stopPlayback() {}, renderAll() {}, focusSelectedCell() {}, setStatus() {},
};
const adapter = {
  capabilities: { directOpen: true, directSave: true, uploadFallback: true, downloadFallback: true },
  async openFile() { return { ok: false, cancelled: true }; },
  async saveAs(text, fileName) {
    writes.push({ text, fileName });
    return { ok: true, handle, fileName: handle.name, mode: "handle", durableWriteConfirmed: true };
  },
  async writeHandle(boundHandle, text) {
    writes.push({ text, fileName: boundHandle?.name ?? handle.name });
    return { ok: true, handle: boundHandle, fileName: boundHandle?.name ?? handle.name, mode: "handle", durableWriteConfirmed: true };
  },
  async confirmDiscard() { return true; },
};
const session = sessionDomain.createController(root, {
  projectStore: stores.project,
  navigationStore: stores.navigation,
  commands: root.BRKTRKCommands,
  adapter,
  createInitialProject: projectFixture,
});
const history = undoRedoTypes.install(root, { projectStore: stores.project });
root.BRKTRKInputSafety = {
  finalizeAllContinuousGestures(reason) {
    return stores.project.finalizeAllContinuousGestures({ gesturePhase: "end", gestureEndReason: reason });
  },
};

(async () => {
  const saved = await session.dispatch({ type: "project.saveAs", source: "g1.open.save-baseline" });
  assert.equal(saved.ok, true);
  assert.equal(saved.durableWriteConfirmed, true);
  const savedText = writes.at(-1).text;
  assert.equal(session.snapshot().dirty, false);

  stores.project.setProductionInstrumentParameter(3, "cutoff", 0.7, { source: "g1.open.pre-open-dirty" });
  assert.equal(session.snapshot().dirty, true);
  assert.equal(history.snapshot().undoDepth, 1);

  const opened = await session.dispatch({
    type: "project.open",
    force: true,
    source: "g1.open.baseline",
    file: { text: savedText, fileName: handle.name, handle, mode: "handle" },
  });
  assert.equal(opened.ok, true);
  assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.25);
  assert.equal(session.snapshot().dirty, false, "Open must establish the exact clean baseline");
  assert.equal(history.snapshot().undoDepth, 0, "Open must reset pre-file history");

  for (const [index, value] of [0.4, 0.6, 0.9].entries()) {
    stores.project.setProductionInstrumentParameter(3, "cutoff", value, {
      source: "a4-sound-range",
      transient: true,
      transaction: {
        gestureId: "open-baseline-gesture",
        gestureFamily: "sound",
        gestureKind: "pointer-range",
        gesturePhase: index === 0 ? "begin" : "update",
      },
    });
  }
  assert.equal(session.snapshot().dirty, false, "raw samples must not churn the durable Open baseline");
  const finalized = stores.project.finalizeContinuousGesture({
    gestureId: "open-baseline-gesture",
    gestureFamily: "sound",
    gestureKind: "pointer-range",
    gesturePhase: "end",
    gestureEndReason: "pointerup",
  });
  assert.equal(finalized.committed, true);
  assert.equal(session.snapshot().dirty, true);
  assert.equal(history.snapshot().undoDepth, 1);

  const undone = history.undo();
  assert.equal(undone.ok, true);
  assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.25);
  assert.equal(session.snapshot().dirty, false, "Undo to the exact Open baseline must restore CLEAN");

  const redone = history.redo();
  assert.equal(redone.ok, true);
  assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.9);
  assert.equal(session.snapshot().dirty, true);

  console.log("G1 Open baseline -> gesture -> Undo exact-clean contract passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
