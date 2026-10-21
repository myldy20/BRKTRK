"use strict";

// G1 focused regression: a non-structural live Instrument parameter gesture
// must remain non-structural through the real Undo -> Redo composition path.
//
// This intentionally measures the whole ProjectStore subscriber fan-out rather
// than calling history/audio helpers in isolation. Before the G1 correction,
// createRestoreChangeSet() dropped structuralPlayback and
// production-engine-store-sync treated every Instrument history restore as a
// whole-Project structural resync. The multi-sample case also proves that a
// coalesced history entry restores the pre-gesture/final snapshot values rather
// than the before/after pair from only its last raw sample.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const storeTypes = require("./stores.js");
require("./production-instrument-domain.js");
const transportRuntimeDomain = require("./transport-runtime-state.js");
const phraseStepDomain = require("./project-phrase-step.js");
const navigationEntryDomain = require("./navigation-entry-state.js");
const undoRedoDomain = require("./undo-redo.js");

const model = {
  schemaVersion: 4,
  projectName: "G1 HISTORY LIVE PARAMETER",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: {},
  instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};
const navigationState = { view: "sound", focus: { row: 0, column: 0 }, p3: {}, song: 0, chain: 0, phrase: 0, track: 0, instrument: 3 };
const stores = storeTypes.createStores({ model, state: navigationState, trackCount: 8 });
transportRuntimeDomain.install(stores.transport, { trackCount: 8 });
phraseStepDomain.install(stores.project);
navigationEntryDomain.install(stores.navigation);

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

const calls = {
  refreshPlayback: 0,
  updatePlan: 0,
  prepareProgram: 0,
  liveParameter: 0,
  liveValues: [],
  activateProject: 0,
  readinessInvalidations: 0,
};

const sandbox = {
  console,
  Promise,
  JSON,
  Object,
  Number,
  String,
  Boolean,
  Array,
  Math,
  Error,
  TypeError,
  RangeError,
  Set,
  Map,
  Date,
  audio: { ready: true, context: {}, node: {} },
  BRKTRKStoreTypes: storeTypes,
  BRKTRKTransportRuntimeState: transportRuntimeDomain,
  BRKTRKProjectPhraseStep: phraseStepDomain,
  BRKTRKNavigationEntryState: navigationEntryDomain,
  BRKTRKStores: stores,
  BRKTRKAudioReadiness: {
    invalidate() { calls.readinessInvalidations += 1; return Object.freeze({ ready: false }); },
    ensureReady() { return Promise.resolve(); },
  },
  BRKTRKProductionEngineHost: {
    sendLiveParameter(input) {
      calls.liveParameter += 1;
      calls.liveValues.push(Object.freeze({
        instrumentId: input.instrumentId,
        parameterId: input.parameterId,
        value: input.value,
      }));
      return Object.freeze({ parameterId: input.parameterId, rampFrames: 192, policy: "parameter-ramp" });
    },
    activateProject() { calls.activateProject += 1; return Promise.resolve(); },
    refreshCatalog() { return Promise.resolve(); },
    registerDiagnostics() { return true; },
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(read("project-playback-refresh.js"), sandbox, { filename: "project-playback-refresh.js" });
sandbox.BRKTRKProjectPlaybackRefresh.installRuntimeAdapter({
  owner: "g1-history-test",
  refresh() {
    calls.updatePlan += 1;
    calls.prepareProgram += 1;
    return true;
  },
  refreshLegacy() { return false; },
});

vm.runInContext(read("store-runtime-adapters.js"), sandbox, { filename: "store-runtime-adapters.js" });
const subscribers = sandbox.BRKTRKStoreRuntimeAdapters.createBrowserProjectSubscribers(sandbox, stores, {
  persistProject: () => {},
  setAudioTempo: () => {},
  refreshPlayback: (changeSet) => {
    calls.refreshPlayback += 1;
    return sandbox.BRKTRKProjectPlaybackRefresh.refresh(changeSet);
  },
});
storeTypes.connectProjectSubscribers(stores.project, subscribers);

vm.runInContext(read("production-engine-store-sync.js"), sandbox, { filename: "production-engine-store-sync.js" });
const history = undoRedoDomain.install(sandbox, { projectStore: stores.project });

async function settle() {
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

function snapshotCalls() {
  return {
    refreshPlayback: calls.refreshPlayback,
    updatePlan: calls.updatePlan,
    prepareProgram: calls.prepareProgram,
    liveParameter: calls.liveParameter,
    activateProject: calls.activateProject,
    readinessInvalidations: calls.readinessInvalidations,
  };
}

function assertTargetedLiveDelta(before, label, expectedDeliveries = 1) {
  assert.equal(calls.liveParameter - before.liveParameter, expectedDeliveries, `${label}: dedicated live-parameter delivery count`);
  assert.equal(calls.refreshPlayback - before.refreshPlayback, 0, `${label}: zero generic refreshPlayback`);
  assert.equal(calls.updatePlan - before.updatePlan, 0, `${label}: zero updatePlan`);
  assert.equal(calls.prepareProgram - before.prepareProgram, 0, `${label}: zero prepareProgram`);
  assert.equal(calls.activateProject - before.activateProject, 0, `${label}: zero host.activateProject`);
  assert.equal(calls.readinessInvalidations - before.readinessInvalidations, 0, `${label}: zero readiness invalidation`);
}

(async () => {
  // production-engine-store-sync performs one initial structural activation when
  // it installs. Settle it and measure only the edit/history path after that.
  await settle();

  const directBase = snapshotCalls();
  const first = stores.project.setProductionInstrumentParameter(3, "cutoff", 0.6, {
    source: "g1-history-fixture",
    transient: true,
  });
  const final = stores.project.setProductionInstrumentParameter(3, "cutoff", 0.9, {
    source: "g1-history-fixture",
    transient: true,
  });
  assert.equal(first.mutated, true);
  assert.equal(final.mutated, true);
  assert.equal(final.changeSet.affectsPlayback, true);
  assert.equal(final.changeSet.structuralPlayback, false);
  assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.9);
  assertTargetedLiveDelta(directBase, "two-sample direct gesture", 2);
  assert.deepEqual(calls.liveValues.slice(-2), [
    { instrumentId: 3, parameterId: "cutoff", value: 0.6 },
    { instrumentId: 3, parameterId: "cutoff", value: 0.9 },
  ]);
  assert.equal(history.snapshot().undoDepth, 1, "transient samples must coalesce to one existing history entry");

  const undoBase = snapshotCalls();
  const undone = history.undo();
  await settle();
  assert.equal(undone.ok, true);
  assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.25);
  assert.equal(undone.changeSet.affectsPlayback, true, "undo remains audible");
  assert.equal(undone.changeSet.structuralPlayback, false, "undo must preserve original non-structural playback semantics");
  assert.equal(undone.changeSet.transaction.originalSubtype, "instrument.parameter");
  assert.equal(undone.changeSet.transaction.originalStructuralPlayback, false);
  assert.deepEqual(Array.from(undone.changeSet.transaction.originalPath), ["instrumentPool", 3, "parameterSnapshot", "cutoff"]);
  assert.equal(undone.changeSet.transaction.restoredValue, 0.25, "undo live delivery must use the pre-gesture snapshot, not the last sample's before value");
  assertTargetedLiveDelta(undoBase, "undo");
  assert.deepEqual(calls.liveValues.at(-1), { instrumentId: 3, parameterId: "cutoff", value: 0.25 });

  const redoBase = snapshotCalls();
  const redone = history.redo();
  await settle();
  assert.equal(redone.ok, true);
  assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.9);
  assert.equal(redone.changeSet.structuralPlayback, false, "redo must preserve original non-structural playback semantics");
  assert.equal(redone.changeSet.transaction.restoredValue, 0.9, "redo live delivery must use the final coalesced snapshot");
  assertTargetedLiveDelta(redoBase, "redo");
  assert.deepEqual(calls.liveValues.at(-1), { instrumentId: 3, parameterId: "cutoff", value: 0.9 });

  console.log("G1 multi-sample live-parameter gesture -> undo -> redo stays targeted and snapshot-correct");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
