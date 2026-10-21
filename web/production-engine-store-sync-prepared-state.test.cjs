const assert = require("node:assert/strict");
const fs = require("node:fs");

globalThis.BRKTRKStoreTypes = require("./stores.js");
globalThis.BRKTRKPreparedInstrumentStateDomain = require("./prepared-instrument-state-domain.js");
globalThis.BRKTRKPreparedInstrumentApplicationState = require("./prepared-instrument-application-state.js");

const SHA = "a".repeat(64);
const CONTENT = "b".repeat(64);
const engineRef = {
  moduleId: "design.myldy.fixture",
  engineId: "fixture",
  requestedVersion: "1.0.0",
  resolvedVersion: "1.0.0",
  resolvedPackageSha256: SHA,
};
const packageView = Object.freeze({
  entry: Object.freeze({ moduleId: engineRef.moduleId, engineId: engineRef.engineId, version: "1.0.0", packageSha256: SHA }),
  manifest: Object.freeze({ stateSchemaVersion: 1, stateBytes: 4, contentSha256: CONTENT }),
  parameters: Object.freeze([Object.freeze({ id: "cutoff" })]),
});
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const stateFor = (presetId, cutoff, bytes = "AQIDBA==") => ({
  patchState: { schemaVersion: 1, encoding: "base64", data: bytes },
  parameterSnapshot: { cutoff },
  presetRef: { id: presetId, moduleId: engineRef.moduleId, engineId: engineRef.engineId, version: "1.0.0", packageSha256: SHA },
});

const project = {
  instrumentPool: {
    3: {
      id: 3,
      name: "Fixture",
      engineRef: clone(engineRef),
      ...stateFor("factory-a", 0.25),
    },
  },
};

let audioSubscriber = null;
const transportListeners = new Map();
const emitted = [];
let phase = "playing";
let playing = true;
const projectStore = {
  owner: "project",
  getState: () => project,
  subscribe(channel, listener) {
    assert.equal(channel, "audio");
    audioSubscriber = listener;
    return () => { audioSubscriber = null; };
  },
};
const transportStore = {
  owner: "transport",
  emit(channel, changeSet) {
    emitted.push({ channel, changeSet });
    for (const listener of [...(transportListeners.get(channel) ?? [])]) listener(changeSet);
  },
  subscribe(channel, listener) {
    if (!transportListeners.has(channel)) transportListeners.set(channel, new Set());
    transportListeners.get(channel).add(listener);
    return () => transportListeners.get(channel)?.delete(listener);
  },
  runtime: {
    snapshot: () => Object.freeze({ phase, playing }),
  },
};
globalThis.BRKTRKStores = { project: projectStore, transport: transportStore };

const calls = {
  prepared: [],
  live: [],
  activate: 0,
  invalidations: [],
  readiness: [],
  shadowInvalidations: 0,
};
let statusListener = null;
globalThis.BRKTRKProductionEngineHost = {
  verifiedPackageViewFor(ref) {
    return ref?.resolvedPackageSha256 === SHA ? packageView : null;
  },
  sendPreparedState(input) {
    calls.prepared.push(input);
    return Object.freeze({ instrumentId: input.envelope.instrumentId, commitId: input.envelope.commitId });
  },
  subscribePreparedStateStatus(listener) {
    statusListener = listener;
    return () => { statusListener = null; };
  },
  invalidatePreparedStateShadow() { calls.shadowInvalidations += 1; },
  sendLiveParameter(input) { calls.live.push(clone(input)); return Object.freeze({ parameterId: input.parameterId }); },
  async activateProject() { calls.activate += 1; },
  registerDiagnostics() { return true; },
  refreshCatalog() { return Promise.resolve([]); },
};

globalThis.BRKTRKAudioReadiness = {
  invalidate(input) { calls.invalidations.push(clone(input)); },
  ensureReady(input) { calls.readiness.push(clone(input)); return Promise.resolve(); },
};
globalThis.audio = { ready: false, context: {}, node: {} };

function applyDirectPreset(presetId, cutoff, bytes = "AQIDBA==") {
  const before = stateFor(project.instrumentPool[3].presetRef.id, project.instrumentPool[3].parameterSnapshot.cutoff, project.instrumentPool[3].patchState.data);
  const after = stateFor(presetId, cutoff, bytes);
  Object.assign(project.instrumentPool[3], clone(after));
  const changeSet = Object.freeze({
    subtype: "instrument.preset",
    target: "project.instrumentPool.3.preset",
    path: Object.freeze(["instrumentPool", 3]),
    before: Object.freeze(clone(before)),
    after: Object.freeze(clone(after)),
    affectsPlayback: true,
    transaction: Object.freeze({ instrumentId: 3, presetId, safeBoundaryRequired: true }),
  });
  audioSubscriber(changeSet, project);
  return changeSet;
}

async function main() {
  require("./production-engine-store-sync.js");
  const bridge = globalThis.BRKTRKProductionEngineStoreSync;
  assert.equal(typeof audioSubscriber, "function");
  assert.equal(typeof statusListener, "function");
  assert.equal(bridge.preparedSupportReady(), true);
  assert.equal(bridge.authoritativeLiveTransport(), true);
  assert.equal(calls.activate, 0, "initial sync is skipped while audio is not ready in this fixture");

  globalThis.audio.ready = true;

  const liveChange = applyDirectPreset("factory-b", 0.75, "BQYHCA==");
  assert.equal(calls.prepared.length, 1, "authoritative playing preset mutation must use prepared MessagePort delivery");
  assert.equal(calls.activate, 0, "live same-topology preset must not activate/rebuild the structural Instrument graph");
  assert.equal(calls.invalidations.length, 0, "live same-topology preset must not revoke package readiness");
  assert.equal(calls.prepared[0].envelope.sourceSubtype, "instrument.preset");
  assert.equal(calls.prepared[0].envelope.desiredPresetId, "factory-b");
  assert.equal(bridge.beforeInstrument(liveChange, project.instrumentPool[3], 3).presetRef.id, "factory-a",
    "partial Project preset changeSet.before must reconstruct the previous same-topology Instrument");
  let application = transportStore.preparedInstrumentState.get(3);
  assert.equal(application.state, "requested");
  assert.equal(application.commitId, 1);
  assert.ok(emitted.some(({ changeSet }) => changeSet?.subtype === "prepared-state.requested"));

  statusListener({ type: "production-prepared-state-status", state: "queued", instrumentId: 3, commitId: 1, desiredPresetId: "factory-b" });
  statusListener({ type: "production-prepared-state-status", state: "applying", instrumentId: 3, commitId: 1, desiredPresetId: "factory-b" });
  statusListener({ type: "production-prepared-state-status", state: "applied", instrumentId: 3, commitId: 1, desiredPresetId: "factory-b" });
  application = transportStore.preparedInstrumentState.get(3);
  assert.equal(application.state, "applied");
  assert.equal(bridge.snapshot().preparedApplied, 1);
  assert.equal(bridge.snapshot().structuralSynchronizations, 0);

  project.instrumentPool[3].parameterSnapshot.cutoff = 0.8;
  audioSubscriber({
    subtype: "instrument.parameter",
    path: ["instrumentPool", 3, "parameterSnapshot", "cutoff"],
    after: 0.8,
    transaction: { instrumentId: 3, parameterKey: "cutoff", transient: true },
  }, project);
  assert.equal(calls.live.length, 1, "live parameter after prepared apply retains the dedicated parameter path");

  phase = "stopped";
  playing = false;
  applyDirectPreset("factory-c", 0.5, "CQoLDA==");
  assert.equal(calls.prepared.length, 1, "stopped preset load must retain the validated structural A4B1 path");
  assert.equal(bridge.snapshot().structuralSynchronizations, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.activate, 1, "stopped preset load structurally activates the current Project");
  assert.ok(calls.readiness.length >= 1, "stopped structural preset load re-proves canonical readiness");
  assert.equal(transportStore.preparedInstrumentState.get(3), null,
    "successful stopped structural reconciliation supersedes old transient prepared application state");
  assert.equal(bridge.snapshot().preparedStatusResetPending, false);

  phase = "playing";
  playing = true;
  applyDirectPreset("factory-d", 0.1, "DQ4PEA==");
  assert.equal(calls.prepared.length, 2);
  const secondCommit = calls.prepared[1].envelope.commitId;
  statusListener({ type: "production-prepared-state-status", state: "failed", instrumentId: 3, commitId: secondCommit, desiredPresetId: "factory-d", code: "native-state-read", reason: "fixture failure" });
  assert.equal(bridge.snapshot().preparedFailed, 1);
  assert.equal(bridge.snapshot().preparedFallbacks, 1);
  assert.equal(calls.shadowInvalidations, 1, "matching Worklet failure revokes optimistic Host convergence shadow");
  assert.equal(bridge.snapshot().structuralSynchronizations, 2, "failed live commit must enter stop-safe structural recovery");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.activate, 2);
  assert.equal(bridge.snapshot().readinessDeferredUntilStop, true, "playing fallback cannot claim readiness before authoritative STOP");
  assert.equal(bridge.snapshot().preparedStatusResetPending, true);
  assert.equal(transportStore.preparedInstrumentState.get(3).state, "failed",
    "failed live commit must stay visible until structural recovery is actually proven");

  phase = "stopped";
  playing = false;
  transportStore.emit("transport", { target: "transport.program.stopped", subtype: "program.stopped" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.snapshot().readinessDeferredUntilStop, false);
  assert.equal(bridge.snapshot().stopBoundaryReadinessProofs, 1);
  assert.equal(bridge.snapshot().preparedStatusResetPending, false);
  assert.equal(transportStore.preparedInstrumentState.get(3), null,
    "authoritative STOP readiness proof must clear recovered transient failure status");

  const surface = fs.readFileSync("web/sound-preset-surface.js", "utf8");
  const policy = fs.readFileSync("web/sound-preset-live-prepared-policy.js", "utf8");
  const sw = fs.readFileSync("web/sw.js", "utf8");
  for (const marker of ["ensureLivePreparedPolicy", "REQUESTING LIVE PRESET", "policy?.context", "live?.availability?.eligible", "transport.subscribe(\"render\""]) {
    assert.ok(surface.includes(marker), `Sound preset surface lost executable live prepared boundary: ${marker}`);
  }
  assert.ok(policy.includes("bridge.preparedPresetAvailability"),
    "live prepared policy must delegate eligibility to the Store/Host orchestration bridge");
  for (const asset of [
    "prepared-instrument-state-domain.js",
    "prepared-instrument-application-state.js",
    "production-engine-prepared-state-host-extension.js",
    "sound-preset-live-prepared-policy.js",
  ]) {
    assert.ok(sw.includes(`\"./${asset}\"`), `offline cache lost #297-C asset ${asset}`);
  }

  console.log("A5 #297-C Store/Host/Transport/UI prepared preset orchestration regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
