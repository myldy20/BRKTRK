"use strict";

const assert = require("node:assert/strict");
const storesTypes = require("./stores.js");
const inputSafety = require("./input-safety.js");
const sessionDomain = require("./project-file-session.js");
const undoRedo = require("./undo-redo.js");

function makeProject(name = "G1 BOUNDARY") {
  return {
    schemaVersion: 4,
    projectName: name,
    tempo: 120,
    tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
    song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
    chains: {}, phrases: {}, instrumentPool: {},
    tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
    sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
  };
}

function makeState() {
  return {
    view: "sound", dock: "mix", songRow: 0, track: 0, chain: 0, chainRow: 0, phrase: 0, phraseRow: 0, instrument: 3,
    focus: { pane: "phrase", row: 0, col: 0 }, lastChain: 0, lastPhrase: 0,
    p3: { activeWorkspace: "sound", soundParam: 0, parents: [], mixReturn: null },
  };
}

function addInstrument(projectStore) {
  projectStore.createProductionInstrument(3, {
    id: 3,
    name: "BOUNDARY FIXTURE",
    engineRef: {
      moduleId: "design.myldy.fixture", engineId: "fixture", requestedVersion: "^1.0.0", resolvedVersion: "1.0.0",
      resolvedPackageSha256: "a".repeat(64), hostContract: "1.x",
    },
    patchState: { schemaVersion: 1, encoding: "opaque", data: null },
    parameterSnapshot: { cutoff: 0.25 },
    provenance: {}, compatibilityData: {}, unknownData: [],
  }, { source: "g1.boundary.setup" });
}

function gesture(id, phase = "begin", reason = null) {
  return {
    gestureId: id,
    gestureFamily: "sound",
    gestureKind: "pointer-range",
    gesturePhase: phase,
    ...(reason ? { gestureEndReason: reason } : {}),
  };
}

// Project New/Open/Save boundaries must finalize an active gesture before the
// file session decides whether the current Project is dirty. Otherwise a live
// value can still be transient while confirmDiscard incorrectly sees CLEAN.
{
  const model = makeProject();
  const bundle = storesTypes.createStores({ model, state: makeState(), trackCount: 8 });
  inputSafety.installContinuousGestureDurability(bundle.project);
  addInstrument(bundle.project);
  let confirmCount = 0;
  const boundaryReasons = [];
  const root = {
    BRKTRK_VERSION: "test",
    BRKTRKStores: bundle,
    BRKTRKCommands: { installed: true },
    BRKTRKUndoRedo: { reset() {} },
    BRKTRKSelectionClipboard: { cancelSelection() {} },
    BRKTRKInputSafety: {
      finalizeAllContinuousGestures(reason) {
        boundaryReasons.push(reason);
        const result = bundle.project.finalizeContinuousGesture(gesture("boundary-new", "end", reason));
        return { ok: result?.committed === true, committedCount: result?.committed ? 1 : 0, notificationErrors: result?.notificationErrors ?? [] };
      },
    },
    stopPlayback() {}, renderAll() {}, focusSelectedCell() {}, setStatus() {},
  };
  const controller = sessionDomain.createController(root, {
    projectStore: bundle.project,
    navigationStore: bundle.navigation,
    commands: root.BRKTRKCommands,
    adapter: {
      capabilities: { directOpen: true, directSave: true, uploadFallback: true, downloadFallback: true },
      async openFile() { return { ok: false, cancelled: true }; },
      async writeHandle() { return { ok: true, durableWriteConfirmed: true, mode: "handle", fileName: "x.brktrk", handle: { name: "x.brktrk" } }; },
      async saveAs() { return { ok: false, cancelled: true }; },
      async confirmDiscard() { confirmCount += 1; return false; },
    },
    createInitialProject: () => makeProject("NEW PROJECT"),
  });

  bundle.project.setProductionInstrumentParameter(3, "cutoff", 0.8, {
    source: "g1.boundary",
    transient: true,
    transaction: gesture("boundary-new"),
  });
  assert.equal(controller.snapshot().dirty, false, "active gesture remains transient before its boundary");

  const resultPromise = controller.dispatch({ type: "project.new", source: "g1.boundary" });
  assert.equal(typeof resultPromise?.then, "function");
  globalThis.__g1BoundaryPromise = resultPromise.then((result) => {
    assert.deepEqual(boundaryReasons, ["project-new"], "New must finalize continuous input before dirty/discard decision");
    assert.equal(confirmCount, 1, "finalize must make the live edit visible to confirmDiscard");
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true, "owner cancellation must preserve the now-durable current Project");
    assert.equal(model.projectName, "G1 BOUNDARY");
    assert.equal(model.instrumentPool[3].parameterSnapshot.cutoff, 0.8);
  });
}

// History is also a structural boundary: Undo must first finalize any active
// gesture, then consume that just-created gesture entry rather than reporting
// an empty history stack.
{
  const model = makeProject("G1 HISTORY BOUNDARY");
  const bundle = storesTypes.createStores({ model, state: makeState(), trackCount: 8 });
  inputSafety.installContinuousGestureDurability(bundle.project);
  addInstrument(bundle.project);
  const reasons = [];
  const root = { BRKTRKStores: bundle, setStatus() {}, renderAll() {} };
  const history = undoRedo.install(root, { projectStore: bundle.project });
  root.BRKTRKInputSafety = {
    finalizeAllContinuousGestures(reason) {
      reasons.push(reason);
      const result = bundle.project.finalizeContinuousGesture(gesture("boundary-undo", "end", reason));
      return { ok: result?.committed === true, committedCount: result?.committed ? 1 : 0, notificationErrors: result?.notificationErrors ?? [] };
    },
  };
  bundle.project.setProductionInstrumentParameter(3, "cutoff", 0.7, {
    source: "g1.history-boundary",
    transient: true,
    transaction: gesture("boundary-undo"),
  });
  assert.equal(history.snapshot().undoDepth, 0);
  const result = history.undo();
  assert.deepEqual(reasons, ["history-undo"], "Undo must close the active gesture before selecting an entry");
  assert.equal(result.ok, true);
  assert.equal(model.instrumentPool[3].parameterSnapshot.cutoff, 0.25, "Undo after boundary finalization restores pre-gesture state");
}

// A downstream persistence subscriber failure is post-commit. It must not make
// an already-installed Project mutation look rejected, must not strand the
// pending gesture for duplicate retry, and must not prevent later subscribers.
{
  const model = makeProject("G1 FAILURE BOUNDARY");
  const bundle = storesTypes.createStores({ model, state: makeState(), trackCount: 8 });
  inputSafety.installContinuousGestureDurability(bundle.project);
  addInstrument(bundle.project);
  let laterSubscriberCount = 0;
  bundle.project.subscribe("persistence", () => { throw new Error("fixture persistence failure"); });
  bundle.project.subscribe("persistence", () => { laterSubscriberCount += 1; });
  bundle.project.setProductionInstrumentParameter(3, "cutoff", 0.9, {
    source: "g1.failure",
    transient: true,
    transaction: gesture("boundary-failure"),
  });
  let finalized = null;
  assert.doesNotThrow(() => {
    finalized = bundle.project.finalizeContinuousGesture(gesture("boundary-failure", "end", "pointerup"));
  }, "post-commit persistence failure must be isolated");
  assert.equal(finalized.committed, true);
  assert.equal(finalized.notificationErrors.length, 1);
  assert.equal(laterSubscriberCount, 1, "one failing subscriber must not suppress later durability consumers");
  assert.equal(bundle.project.continuousGestureDurabilitySnapshot().pendingCount, 0, "failed notification must not strand a retryable pending gesture");
  assert.equal(bundle.project.finalizeContinuousGesture("boundary-failure").committed, false, "post-commit failure cannot be retried into duplicate persistence");
}

Promise.resolve(globalThis.__g1BoundaryPromise).then(() => {
  delete globalThis.__g1BoundaryPromise;
  console.log("G1 project/history/failure boundary exit contract passed");
}).catch((error) => {
  delete globalThis.__g1BoundaryPromise;
  console.error(error);
  process.exitCode = 1;
});
