"use strict";

const assert = require("node:assert/strict");

let captureToken = null;
let capturedGateway = null;
let nextGatewayId = 1;
const stagedBy = [];

function makeGateway(label) {
  const id = nextGatewayId++;
  let staged = null;
  const gateway = Object.freeze({
    label: `${label}-${id}`,
    stagePreparedState(commit) {
      staged = commit;
      stagedBy.push(`${label}-${id}`);
      return Object.freeze({ instrumentId: commit.instrumentId, commitId: commit.commitId, preparedPerformers: label === "structural" ? 1 : 0 });
    },
    discardPreparedState() { staged = null; return true; },
    applyStagedState(instrumentId, commitId) {
      assert.equal(staged?.instrumentId, instrumentId);
      assert.equal(staged?.commitId, commitId);
      staged = null;
      return Object.freeze({ instrumentId, commitId, appliedPerformers: label === "structural" ? 1 : 0 });
    },
    reconcilePreparedState(commit) {
      this.stagePreparedState(commit);
      return this.applyStagedState(commit.instrumentId, commit.commitId);
    },
    clearPreparedState() { staged = null; return true; },
    preparedStateDiagnostics() { return Object.freeze({ label: `${label}-${id}`, staged: staged ? 1 : 0 }); },
  });
  if (captureToken !== null) capturedGateway = gateway;
  return gateway;
}

globalThis.BRKTRKPreparedStateGatewayCapture = Object.freeze({
  beginCapture(token) {
    assert.equal(captureToken, null, "gateway capture must not nest");
    captureToken = token;
    capturedGateway = null;
  },
  finishCapture(token) {
    assert.equal(captureToken, token, "gateway capture token must match");
    captureToken = null;
    const result = capturedGateway;
    capturedGateway = null;
    return result;
  },
});

class PreparedStateQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

globalThis.BRKTRKPreparedInstrumentStateWorkletDomain = Object.freeze({
  PreparedStateQueueError,
  normalizeCommit(data) { return Object.freeze({ ...data }); },
  createQueue() {
    let pending = null;
    let lastSeen = [];
    return Object.freeze({
      snapshot() { return Object.freeze({ lastSeen: Object.freeze(lastSeen), pending: pending ? 1 : 0 }); },
      stage(commit) {
        const supersededCommitId = pending?.commitId ?? null;
        pending = commit;
        lastSeen = [Object.freeze({ instrumentId: commit.instrumentId, commitId: commit.commitId })];
        return Object.freeze({ supersededCommitId });
      },
      beginNext() { const result = pending; pending = null; return result; },
      finishApplied(instrumentId, commitId) { return Object.freeze({ instrumentId, commitId, state: "applied" }); },
      finishFailed() { return true; },
    });
  },
});

globalThis.BRKTRKProductionAudioRuntime = Object.freeze({
  MAX_PENDING_PARAMETERS: 64,
  createProductionAudioRuntime({ postMessage = () => {} } = {}) {
    let gateway = makeGateway("initial");
    let instruments = {};
    const diagnostics = () => Object.freeze({
      pendingLiveParameters: 0,
      pendingInstrumentSync: false,
      gatewayLabel: gateway.label,
    });
    function configureInstruments(snapshot) {
      instruments = snapshot ?? {};
      gateway = makeGateway("structural");
      return true;
    }
    function handleMessage(data) {
      if (data?.type === "production-instruments") {
        configureInstruments(data.instruments);
        postMessage({ type: "production-diagnostics", snapshot: diagnostics() });
        return true;
      }
      return false;
    }
    return Object.freeze({
      configureInstruments,
      handleMessage,
      diagnostics,
      postDiagnostics() { postMessage({ type: "production-diagnostics", snapshot: diagnostics() }); },
      prepareProgram() { return true; },
      queueAudition() { return true; },
      beginBlock() { return true; },
      stop() { return true; },
      hasInstrument(instrumentId) { return Boolean(instruments[instrumentId]); },
      queueParameter() { return true; },
    });
  },
});

const production = require("./production-prepared-state-runtime-extension.js");
const messages = [];
const runtime = production.createProductionAudioRuntime({ postMessage: (message) => messages.push(message) });

// This is the real Worklet-facing shape: structural state arrives through
// handleMessage(), not by calling the wrapper's configureInstruments() method.
assert.equal(runtime.handleMessage({
  type: "production-instruments",
  instruments: { 0: { id: 0, engineRef: { moduleId: "fixture", engineId: "fixture", resolvedVersion: "1", resolvedPackageSha256: "a".repeat(64) } } },
}), true);
assert.equal(runtime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [0] }] }), true);

assert.equal(runtime.handleMessage({
  type: "production-prepared-state",
  instrumentId: 0,
  commitId: 1,
  exactEngineIdentity: { moduleId: "fixture", engineId: "fixture", version: "1", packageSha256: "a".repeat(64) },
  stateSchemaVersion: 1,
  stateBytes: Uint8Array.from([1, 2, 3, 4]),
  parameterIds: ["gain"],
  parameterValues: [0.5],
  desiredPresetId: "fixture-preset",
}), true);

assert.equal(stagedBy.length, 1, "prepared state must stage exactly once");
assert.match(stagedBy[0], /^structural-/, "prepared state must use the gateway created by the MessagePort structural snapshot, not the runtime-construction gateway");
assert.equal(messages.at(-1)?.state, "queued");
assert.match(runtime.diagnostics().preparedState.gateway.label, /^structural-/, "prepared diagnostics must follow the same authoritative structural gateway");

runtime.beginBlock(0, 128);
assert.equal(messages.at(-1)?.state, "applied");
assert.equal(messages.at(-1)?.appliedPerformers, 1, "prepared commit must apply to the live structural performer set rather than a stale zero-slot gateway");

console.log("A5 #297 prepared-state MessagePort gateway-capture regression passed");
