"use strict";

// G0 — live-parameter authority convergence.
//
// This regression owns the contract that the 2026-09-05 owner physical session
// disproved. It is deliberately composition-level: the physical defect lives in
// event routing between ProjectStore, the generic audio adapter, the dedicated
// production engine sync and the prepared-state Worklet runtime, so a direct
// internal API call would not be sufficient evidence.
//
// Section A — an ordinary `instrument.parameter` edit must reach audio through
//   the dedicated live parameter path only, and must request zero generic
//   playback refresh / update-plan / program prepare.
// Section B — a retained prepared full-state commit must never re-assert itself
//   over a later Project-owned live value, across structural prepare, retrigger
//   and Stop -> Start.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");

// ---------------------------------------------------------------------------
// Section A — Store/host authority under the real subscriber composition.
// ---------------------------------------------------------------------------

const storeTypes = require("./stores.js");
require("./production-instrument-domain.js");
const transportRuntimeDomain = require("./transport-runtime-state.js");
const phraseStepDomain = require("./project-phrase-step.js");
const navigationEntryDomain = require("./navigation-entry-state.js");

const model = {
  schemaVersion: 4,
  projectName: "G0 AUTHORITY",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: { 0: Array.from({ length: 16 }, () => ({ note: -1, velocity: 100, instrument: -1, fx: [{ command: 0, value: 0 }, { command: 0, value: 0 }, { command: 0, value: 0 }] })) },
  instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};
const navigationState = { view: "song", focus: { row: 0, column: 0 }, p3: {}, song: 0, chain: 0, phrase: 0, track: 0, instrument: 0 };

const stores = storeTypes.createStores({ model, state: navigationState, trackCount: 8 });
transportRuntimeDomain.install(stores.transport, { trackCount: 8 });
phraseStepDomain.install(stores.project);
navigationEntryDomain.install(stores.navigation);

stores.project.createProductionInstrument(3, {
  id: 3,
  name: "FOLD REED LEAD",
  engineRef: {
    moduleId: "design.myldy.fixture",
    engineId: "fixture",
    requestedVersion: "^1.0.0",
    resolvedVersion: "1.0.0",
    resolvedPackageSha256: "a".repeat(64),
    hostContract: "1.x",
  },
  patchState: { schemaVersion: 1, encoding: "opaque", data: null },
  parameterSnapshot: { cutoff: 0.5, gain: 0.5 },
  provenance: {}, compatibilityData: {}, unknownData: [],
}, { source: "g0.setup" });

const calls = {
  refreshPlayback: 0,
  refreshPlaybackTargets: [],
  liveParameter: 0,
  lastLiveParameter: null,
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
  audio: { ready: true, context: {}, node: {} },
  BRKTRKStoreTypes: storeTypes,
  BRKTRKTransportRuntimeState: transportRuntimeDomain,
  BRKTRKProjectPhraseStep: phraseStepDomain,
  BRKTRKNavigationEntryState: navigationEntryDomain,
  BRKTRKStores: stores,
  BRKTRKAudioReadiness: {
    invalidate(metadata) { calls.readinessInvalidations += 1; return Object.freeze({ ready: false, metadata }); },
    ensureReady() { return Promise.resolve(); },
  },
  BRKTRKProductionEngineHost: {
    sendLiveParameter(input) {
      calls.liveParameter += 1;
      calls.lastLiveParameter = { instrumentId: input.instrumentId, parameterId: input.parameterId, value: input.value };
      return Object.freeze({ parameterId: input.parameterId, rampFrames: 192, policy: "parameter-ramp" });
    },
    activateProject() { calls.activateProject += 1; return Promise.resolve(); },
    syncProject() { return true; },
    refreshCatalog() { return Promise.resolve(); },
    registerDiagnostics() { return true; },
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// The generic Project subscriber composition is the exact one app-bind installs.
vm.runInContext(read("store-runtime-adapters.js"), sandbox, { filename: "store-runtime-adapters.js" });
const adapters = sandbox.BRKTRKStoreRuntimeAdapters;
assert.ok(adapters?.createBrowserProjectSubscribers, "store runtime adapters must expose the browser Project subscribers");

const subscribers = adapters.createBrowserProjectSubscribers(sandbox, stores, {
  refreshPlayback: (changeSet) => {
    calls.refreshPlayback += 1;
    calls.refreshPlaybackTargets.push(String(changeSet?.target ?? ""));
  },
  persistProject: () => {},
  setAudioTempo: () => {},
});
storeTypes.connectProjectSubscribers(stores.project, subscribers);

// The dedicated production engine sync subscribes to the same "audio" channel.
vm.runInContext(read("production-engine-store-sync.js"), sandbox, { filename: "production-engine-store-sync.js" });
const engineSync = sandbox.BRKTRKProductionEngineStoreSync;
assert.ok(engineSync?.synchronize, "production engine Store sync must install against the shared ProjectStore");

// Initial activation happens once at install; measure deltas from here.
const baseline = { ...calls, refreshPlaybackTargets: [...calls.refreshPlaybackTargets] };

// --- A1: one ordinary live parameter edit -----------------------------------

const edit = stores.project.setProductionInstrumentParameter(3, "cutoff", 0.9, { source: "sound.range", transient: true });
assert.equal(edit.mutated, true);

assert.equal(
  calls.liveParameter - baseline.liveParameter,
  1,
  "an ordinary instrument.parameter edit must deliver exactly one dedicated live parameter message",
);
assert.deepEqual(calls.lastLiveParameter, { instrumentId: 3, parameterId: "cutoff", value: 0.9 });

assert.equal(
  calls.refreshPlayback - baseline.refreshPlayback,
  0,
  "an ordinary instrument.parameter edit must request zero generic playback refresh (no updatePlan, no prepareProgram)",
);
assert.equal(
  calls.activateProject - baseline.activateProject,
  0,
  "an ordinary instrument.parameter edit must not schedule a structural engine synchronization",
);
assert.equal(
  calls.readinessInvalidations - baseline.readinessInvalidations,
  0,
  "an ordinary instrument.parameter edit must not invalidate authoritative audio readiness",
);

// The edit is still audible and still durable. Only its *structural* meaning is
// removed, so `affectsPlayback` must stay honest for history/persistence owners.
assert.equal(edit.changeSet.affectsPlayback, true, "a live parameter edit remains audible");
assert.equal(edit.changeSet.persistsProject, true, "a live parameter edit remains durable Project state");
assert.equal(
  edit.changeSet.structuralPlayback,
  false,
  "a live parameter edit must be explicitly non-structural for playback refresh",
);
assert.equal(stores.project.getState().instrumentPool[3].parameterSnapshot.cutoff, 0.9);

// --- A2: a burst of edits stays proportional --------------------------------

const burstBase = { refreshPlayback: calls.refreshPlayback, liveParameter: calls.liveParameter };
for (let index = 0; index < 64; index += 1) {
  stores.project.setProductionInstrumentParameter(3, "cutoff", 0.1 + index / 1000, { source: "sound.range", transient: true });
}
assert.equal(calls.liveParameter - burstBase.liveParameter, 64, "every live edit delivers its dedicated parameter message");
assert.equal(
  calls.refreshPlayback - burstBase.refreshPlayback,
  0,
  "a 64-sample parameter gesture must not produce playback-refresh traffic",
);

// --- A3: genuinely structural mutations must still refresh ------------------

{
  const before = calls.refreshPlayback;
  stores.project.replaceProductionInstrumentPatch(3, { schemaVersion: 1, encoding: "opaque", data: null }, { cutoff: 0.25, gain: 0.25 }, { source: "g0.preset" });
  assert.equal(calls.refreshPlayback - before, 1, "full Instrument patch/preset application remains a structural playback change");
}
{
  const before = calls.refreshPlayback;
  stores.project.setTempo(128, { source: "g0.tempo" });
  assert.equal(calls.refreshPlayback - before, 0, "tempo is handled by the dedicated setAudioTempo branch, not generic refresh");
}
{
  const before = calls.refreshPlayback;
  stores.project.phraseSteps.setField(0, 0, "note", 60, { source: "g0.structure" });
  assert.equal(calls.refreshPlayback - before, 1, "structural composition edits remain structural playback changes");
}

// --- A4: undo of a parameter edit must still resynchronize the engine -------
//
// `undo-redo.createRestoreChangeSet` replaces the whole Project and forwards the
// original edit's `affectsPlayback`. If a live parameter edit were made
// non-audible instead of merely non-structural, `historyRestoresInstrument()`
// would reject the restore and undo would silently stop reaching audio.

const restore = storeTypes.createProjectChangeSet({
  subtype: "history.undo",
  target: "project.history.undo",
  path: [],
  before: null,
  after: null,
  affectsPlayback: edit.changeSet.affectsPlayback,
  renderTargets: ["project.all"],
  source: "m4.2a-undo",
  transaction: {
    historyAction: "undo",
    historyEntryId: 1,
    originalTarget: edit.changeSet.target,
    originalAffectsPlayback: edit.changeSet.affectsPlayback,
  },
});
assert.equal(
  engineSync.historyRestoresInstrument(restore),
  true,
  "undo of a live parameter edit must still be recognised as an Instrument restore for audio",
);
const historyResync = (() => {
  const before = calls.activateProject;
  const beforeInvalidations = calls.readinessInvalidations;
  stores.project.publish(restore, ["audio"]);
  assert.equal(
    calls.readinessInvalidations - beforeInvalidations,
    1,
    "history restore must invalidate authoritative audio readiness",
  );
  // The structural synchronization itself is queued behind the in-flight
  // readiness chain, so settle the microtask queue before asserting it.
  return (async () => {
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    assert.equal(calls.activateProject - before, 1, "history restore must still resynchronize the production engine");
  })();
})();

// ---------------------------------------------------------------------------
// Section B — prepared full-state must never overwrite a later live value.
// ---------------------------------------------------------------------------

const packageDomain = require("./engine-package-domain.js");
require("./engine-registry-domain.js");
require("./performer-registry-domain.js");
require("./synth-gateway-domain.js");
require("./brk-synth-abi-v1-worklet.js");
const abi = require("./brk-synth-prepared-state-extension.js");
require("./prepared-instrument-state-worklet-domain.js");
require("./prepared-instrument-state-gateway-extension.js");
require("./production-audio-runtime.js");
const production = require("./production-prepared-state-runtime-extension.js");

function fakeModule() {
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  let cursor = 8192;
  let nextHandle = 10;
  return {
    HEAPU8,
    HEAPF32,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return 0x00010000; },
    _brk_instance_create() { return ++nextHandle; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate() { return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset() { return 0; },
    _brk_instance_destroy() { return 0; },
    _brk_instance_state_read() { return 0; },
    _brk_instance_process(handle, processPtr) {
      const dv = new DataView(buffer);
      const frames = dv.getUint32(processPtr + 4, true);
      const span = dv.getUint32(processPtr + 8, true);
      const outputPtr = dv.getUint32(span + 4, true);
      const stride = dv.getUint32(span + 16, true);
      const base = outputPtr >>> 2;
      for (let frame = 0; frame < frames; frame += 1) {
        HEAPF32[base + frame] = 0.1;
        HEAPF32[base + stride + frame] = 0.1;
      }
      return 0;
    },
  };
}

const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const entry = Object.freeze({
  moduleId: "design.myldy.fixture",
  engineId: "g0-authority-fixture",
  version: "1.0.0",
  channel: "stable",
  hostContract,
  abiVersion: 65536,
  packageUrl: "fixture://g0-authority",
  packageSha256: "a".repeat(64),
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
});
const manifest = Object.freeze({
  schema: packageDomain.PACKAGE_FORMAT,
  moduleId: entry.moduleId,
  engineId: entry.engineId,
  version: entry.version,
  hostContract,
  abiVersion: 65536,
  stateSchemaVersion: 1,
  stateBytes: 4,
  parameterSchemaVersion: 1,
  contentSha256: "b".repeat(64),
  files: [{ path: "runtime/module.wasm", bytes: 1, sha256: "c".repeat(64) }],
  runtime: { maxModuleInstances: 8, wasmInitialMemoryBytes: 2 * 1024 * 1024, memoryGrowth: false },
  parameters: [
    { id: "cutoff", abiId: 513, defaultNormalized: 0.5 },
    { id: "gain", abiId: 514, defaultNormalized: 0.5 },
  ],
});
abi.registerModuleRuntime({ entry, manifest, module: fakeModule() });

const runtimeInstrument = Object.freeze({
  id: 3,
  engineRef: Object.freeze({
    moduleId: entry.moduleId,
    engineId: entry.engineId,
    resolvedVersion: entry.version,
    resolvedPackageSha256: entry.packageSha256,
  }),
  patchState: Object.freeze({ schemaVersion: 1, encoding: "opaque", data: null }),
  parameterSnapshot: Object.freeze({ cutoff: 0.5, gain: 0.5 }),
});
const exactEngineIdentity = Object.freeze({
  moduleId: entry.moduleId,
  engineId: entry.engineId,
  version: entry.version,
  packageSha256: entry.packageSha256,
});

const program = { mode: "sequence", steps: [{ instrumentIds: [3] }] };
const runtime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1, postMessage: () => {} });
runtime.configureInstruments({ 3: runtimeInstrument });
runtime.prepareProgram(program);

let frameCursor = 1000;
function renderBlock() {
  runtime.beginBlock(frameCursor, 4);
  runtime.renderInto(new Float32Array(4), new Float32Array(4), [{ gain: 1, pan: 0, mute: false }]);
  runtime.endBlock();
  frameCursor += 4;
}
const parameterValues = () => runtime.diagnostics().performers.activeSlots[0].performer.parameterValues;
const liveParameter = (parameterId, value) => runtime.handleMessage({ type: "production-parameter", instrumentId: 3, parameterId, value, rampFrames: 0 });

// A factory preset / full Instrument state is applied while playing.
runtime.handleMessage({
  type: "production-prepared-state",
  instrumentId: 3,
  commitId: 1,
  exactEngineIdentity,
  stateSchemaVersion: 1,
  stateBytes: Uint8Array.from([1, 2, 3, 4]),
  parameterIds: ["cutoff", "gain"],
  parameterValues: [0.4, 0.3],
  sourceSubtype: "instrument.preset",
  desiredPresetId: "fold-reed-lead",
});
renderBlock();
assert.equal(parameterValues().cutoff, 0.4, "the prepared preset must apply");
assert.equal(parameterValues().gain, 0.3);

// The user then edits one control and releases the pointer.
liveParameter("cutoff", 0.9);
renderBlock();
assert.equal(parameterValues().cutoff, 0.9, "the live edit must be audible");
assert.equal(parameterValues().gain, 0.3, "an untouched parameter keeps its prepared value");

// --- B1: a structural prepare must not resurrect the prepared snapshot ------
//
// This is the physical symptom: release the control, something re-prepares the
// program, and the timbre falls back toward the factory preset.

runtime.prepareProgram(program);
renderBlock();
assert.equal(
  parameterValues().cutoff,
  0.9,
  "a structural prepareProgram must not re-assert a retained prepared commit over a later live value",
);
assert.equal(parameterValues().gain, 0.3, "parameters the live edit never touched still follow the prepared commit");
assert.ok(
  runtime.diagnostics().preparedState.supersededPreparedParameters >= 1,
  "superseding a retained prepared parameter must be visible in the prepared-state diagnostics",
);

// --- B2: repeated prepares/retrigger keep the live value --------------------

for (let index = 0; index < 4; index += 1) {
  runtime.prepareProgram(program);
  renderBlock();
}
assert.equal(parameterValues().cutoff, 0.9, "retrigger and repeated program prepares must keep the live value");

// --- B3: Stop -> Start keeps the live value ---------------------------------

runtime.stop();
runtime.prepareProgram(program);
renderBlock();
assert.equal(
  parameterValues().cutoff,
  0.9,
  "Stop -> Start must reconstruct from current desired state, not from a retained prepared commit",
);

// --- B4: a genuinely newer prepared commit still wins -----------------------

runtime.handleMessage({
  type: "production-prepared-state",
  instrumentId: 3,
  commitId: 2,
  exactEngineIdentity,
  stateSchemaVersion: 1,
  stateBytes: Uint8Array.from([5, 6, 7, 8]),
  parameterIds: ["cutoff", "gain"],
  parameterValues: [0.15, 0.65],
  sourceSubtype: "instrument.preset",
  desiredPresetId: "second-preset",
});
renderBlock();
assert.equal(parameterValues().cutoff, 0.15, "a newer prepared full-state commit supersedes the older live value");
assert.equal(parameterValues().gain, 0.65);

runtime.prepareProgram(program);
renderBlock();
assert.equal(parameterValues().cutoff, 0.15, "the newest prepared commit remains authoritative across structural prepare");
assert.equal(parameterValues().gain, 0.65);

// ...and a live edit after it wins again.
liveParameter("gain", 0.05);
renderBlock();
runtime.prepareProgram(program);
renderBlock();
assert.equal(parameterValues().gain, 0.05, "the newest live edit wins again after the newer prepared commit");
assert.equal(parameterValues().cutoff, 0.15);

// --- B5: a full structural instrument snapshot still resets ownership -------

runtime.configureInstruments({ 3: runtimeInstrument });
runtime.prepareProgram(program);
renderBlock();
assert.equal(
  runtime.diagnostics().preparedState.retainedCommittedInstruments,
  0,
  "a full production-instruments snapshot supersedes retained prepared commits and live overrides",
);

(async () => {
  await historyResync;
  console.log("G0 live-parameter authority contract OK");
})();
