"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  let destroyed = 0;
  let mallocCalls = 0;
  let failNextStateRead = false;
  const operations = [];
  const stateReads = [];
  return {
    HEAPU8,
    HEAPF32,
    operations,
    stateReads,
    get destroyed() { return destroyed; },
    get mallocCalls() { return mallocCalls; },
    failStateReadOnce() { failNextStateRead = true; },
    _malloc(size) { mallocCalls += 1; const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return 0x00010000; },
    _brk_instance_create() { return ++nextHandle; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate(handle) { operations.push(`activate:${handle}`); return 0; },
    _brk_instance_deactivate(handle) { operations.push(`deactivate:${handle}`); return 0; },
    _brk_instance_reset(handle) { operations.push(`reset:${handle}`); return 0; },
    _brk_instance_destroy() { destroyed += 1; return 0; },
    _brk_instance_state_read(handle, ptr, byteLength, schemaVersion) {
      operations.push(`state-read:${handle}`);
      if (failNextStateRead) { failNextStateRead = false; return 77; }
      stateReads.push(Object.freeze({ handle, schemaVersion, bytes: Object.freeze([...HEAPU8.slice(ptr, ptr + byteLength)]) }));
      return 0;
    },
    _brk_instance_process(handle, processPtr) {
      operations.push(`process:${handle}`);
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
  engineId: "prepared-runtime-fixture",
  version: "1.0.0",
  channel: "stable",
  hostContract,
  abiVersion: 65536,
  packageUrl: "fixture://prepared-runtime",
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
const wasmModule = fakeModule();
abi.registerModuleRuntime({ entry, manifest, module: wasmModule });

const instrument = Object.freeze({
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

function prepared(commitId, bytes, cutoff, gain, extra = {}) {
  return {
    type: "production-prepared-state",
    instrumentId: 3,
    commitId,
    exactEngineIdentity,
    stateSchemaVersion: 1,
    stateBytes: Uint8Array.from(bytes),
    parameterIds: ["cutoff", "gain"],
    parameterValues: [cutoff, gain],
    sourceSubtype: "instrument.preset",
    desiredPresetId: `fixture-${commitId}`,
    ...extra,
  };
}

const messages = [];
const runtime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1, postMessage: (message) => messages.push(message) });
runtime.configureInstruments({ 3: instrument });
runtime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3] }] });
assert.equal(runtime.hasPreparedPerformers(), true);
const initialHandle = runtime.diagnostics().performers.activeSlots[0].performer.handle;
const mallocAfterPrepare = wasmModule.mallocCalls;
wasmModule.operations.length = 0;

// A live value that arrived before a newer prepared commit must not leak past
// that commit. The prepared snapshot overwrites the same stable-key queue.
runtime.handleMessage({ type: "production-parameter", instrumentId: 3, parameterId: "cutoff", value: 0.2, rampFrames: 0 });
const firstInput = prepared(1, [1, 2, 3, 4], 0.7, 0.6);
assert.equal(runtime.handleMessage(firstInput), true);
firstInput.stateBytes[0] = 99;
assert.equal(wasmModule.stateReads.length, 0, "state_read must not run in the Worklet message callback");
assert.equal(wasmModule.mallocCalls, mallocAfterPrepare, "prepared-state message staging must reuse performer-owned scratch without _malloc");
assert.equal(messages.at(-1).state, "queued");

runtime.beginBlock(1000, 4);
const left = new Float32Array(4);
const right = new Float32Array(4);
runtime.renderInto(left, right, [{ gain: 1, pan: 0, mute: false }]);
runtime.endBlock();
assert.deepEqual(wasmModule.stateReads.at(-1).bytes, [1, 2, 3, 4], "performer staging must own bytes independently of the caller");
assert.ok(wasmModule.operations.indexOf(`state-read:${initialHandle}`) < wasmModule.operations.indexOf(`process:${initialHandle}`), "prepared state must commit before the block reaches performer processing/K0-K4 audio work");
let slot = runtime.diagnostics().performers.activeSlots[0];
assert.equal(slot.performer.parameterValues.cutoff, 0.7, "newer prepared state must supersede an older pending live parameter");
assert.equal(slot.performer.parameterValues.gain, 0.6);
assert.equal(runtime.diagnostics().preparedState.applied, 1);
assert.equal(runtime.diagnostics().preparedState.syntheticParameterWrites, 2);
assert.equal(wasmModule.destroyed, 0, "same-topology prepared state must not rebuild/destroy the performer registry");
assert.equal(runtime.diagnostics().performers.activeSlots[0].performer.handle, initialHandle);
assert.deepEqual(messages.filter((message) => message.type === "production-prepared-state-status" && message.commitId === 1).map((message) => message.state), ["queued", "applying", "applied"]);

// A live parameter that arrives after the prepared commit must remain newest.
runtime.handleMessage(prepared(2, [5, 6, 7, 8], 0.4, 0.3));
runtime.handleMessage({ type: "production-parameter", instrumentId: 3, parameterId: "cutoff", value: 0.9, rampFrames: 0 });
runtime.beginBlock(1004, 4);
runtime.renderInto(new Float32Array(4), new Float32Array(4), [{ gain: 1, pan: 0, mute: false }]);
runtime.endBlock();
slot = runtime.diagnostics().performers.activeSlots[0];
assert.equal(slot.performer.parameterValues.cutoff, 0.9, "later live parameter must supersede prepared snapshot on the same MessagePort order");
assert.equal(slot.performer.parameterValues.gain, 0.3);

// Rapid same-Instrument commits stay one pending item; only the newest state is
// read at the next block boundary.
const stateReadsBeforeBurst = wasmModule.stateReads.length;
runtime.handleMessage(prepared(3, [9, 9, 9, 9], 0.2, 0.2));
runtime.handleMessage(prepared(4, [4, 4, 4, 4], 0.8, 0.8));
assert.equal(runtime.diagnostics().preparedState.pending, 1);
assert.equal(runtime.diagnostics().preparedState.superseded, 1);
runtime.beginBlock(1008, 4);
runtime.renderInto(new Float32Array(4), new Float32Array(4), [{ gain: 1, pan: 0, mute: false }]);
runtime.endBlock();
assert.equal(wasmModule.stateReads.length, stateReadsBeforeBurst + 1, "superseded prepared state must never reach ABI state_read");
assert.deepEqual(wasmModule.stateReads.at(-1).bytes, [4, 4, 4, 4]);

// Stale ids fail in the control callback before gateway staging or synthetic
// parameter writes can mutate the pending runtime state.
const syntheticBeforeStale = runtime.diagnostics().preparedState.syntheticParameterWrites;
const readsBeforeStale = wasmModule.stateReads.length;
runtime.handleMessage(prepared(3, [3, 3, 3, 3], 0.1, 0.1));
assert.equal(runtime.diagnostics().preparedState.syntheticParameterWrites, syntheticBeforeStale);
assert.equal(wasmModule.stateReads.length, readsBeforeStale);
const staleStatus = messages.at(-1);
assert.equal(staleStatus.state, "failed");
assert.equal(staleStatus.code, "stale-commit");

// Exact package identity is checked again inside the Worklet against the active
// ABI runtime, not trusted from the main-thread classifier alone.
runtime.handleMessage(prepared(5, [5, 5, 5, 5], 0.5, 0.5, {
  exactEngineIdentity: { ...exactEngineIdentity, packageSha256: "d".repeat(64) },
}));
assert.equal(messages.at(-1).state, "failed");
assert.equal(messages.at(-1).code, "exact-engine-identity");

// A native state-read failure is fail-closed: failed ACK, no claim of applied
// convergence, and beginBlock throws before authoritative lifecycle routing.
wasmModule.failStateReadOnce();
runtime.handleMessage(prepared(6, [6, 6, 6, 6], 0.6, 0.6));
assert.throws(() => runtime.beginBlock(1012, 4), /brk_instance_state_read failed/);
assert.equal(runtime.diagnostics().preparedState.failed, 1);
assert.equal(runtime.diagnostics().preparedState.blockApplyFailures, 1);
assert.deepEqual(messages.filter((message) => message.type === "production-prepared-state-status" && message.commitId === 6).map((message) => message.state), ["queued", "applying", "failed"]);

// Capacity preflight must reject before any prepared snapshot key is written.
// This protects the shared live-parameter map from a partially injected full
// snapshot if only one slot remains but the prepared state needs two keys.
const capacityMessages = [];
const capacityRuntime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1, postMessage: (message) => capacityMessages.push(message) });
capacityRuntime.configureInstruments({ 3: instrument });
capacityRuntime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3] }] });
for (let index = 0; index < 4095; index += 1) {
  assert.equal(capacityRuntime.queueParameter({ instrumentId: 3, parameterId: `fixture-capacity-${index}`, value: 0.25, rampFrames: 0 }), true);
}
assert.equal(capacityRuntime.diagnostics().pendingLiveParameters, 4095);
const capacitySyntheticBefore = capacityRuntime.diagnostics().preparedState.syntheticParameterWrites;
const capacityGatewayStagesBefore = capacityRuntime.diagnostics().preparedState.gateway.stagedCount;
capacityRuntime.handleMessage(prepared(1, [7, 7, 7, 7], 0.7, 0.7));
const capacityFailure = capacityMessages.at(-1);
assert.equal(capacityFailure.state, "failed");
assert.equal(capacityFailure.code, "parameter-capacity-preflight");
assert.equal(capacityRuntime.diagnostics().pendingLiveParameters, 4095, "failed prepared-state preflight must leave the live-parameter queue unchanged");
assert.equal(capacityRuntime.diagnostics().preparedState.syntheticParameterWrites, capacitySyntheticBefore, "failed capacity preflight must inject zero synthetic prepared parameters");
assert.equal(capacityRuntime.diagnostics().preparedState.gateway.stagedCount, capacityGatewayStagesBefore, "failed capacity preflight must not stage state bytes in the gateway/performer boundary");
capacityRuntime.stop();

// The generic gateway must not own BRK ABI calls or Wasm heap operations.
// Raw native state operations belong exclusively to the BRK performer adapter.
const runtimeSource = fs.readFileSync(path.join(__dirname, "production-prepared-state-runtime-extension.js"), "utf8");
const gatewaySource = fs.readFileSync(path.join(__dirname, "prepared-instrument-state-gateway-extension.js"), "utf8");
const performerExtensionSource = fs.readFileSync(path.join(__dirname, "brk-synth-prepared-state-extension.js"), "utf8");
const runtimeBegin = runtimeSource.slice(runtimeSource.indexOf("function beginBlock("), runtimeSource.indexOf("function stop()"));
const gatewayApply = gatewaySource.slice(gatewaySource.indexOf("function applyStagedState("), gatewaySource.indexOf("function reconcilePreparedState("));
const performerCommit = performerExtensionSource.slice(performerExtensionSource.indexOf("function commitPreparedState("), performerExtensionSource.indexOf("function destroy()"));
for (const forbidden of ["JSON.parse", "JSON.stringify", "base64", "_malloc", "HEAPU8.set", "fetch(", "rebuildRegistries", "stagePreparedState(", "queueParameter("]) {
  assert.equal(runtimeBegin.includes(forbidden), false, `runtime block boundary must not contain ${forbidden}`);
}
for (const forbidden of ["_brk_instance_", "_malloc", "HEAPU8", "JSON.parse", "JSON.stringify", "base64", "fetch("]) {
  assert.equal(gatewaySource.includes(forbidden), false, `generic prepared-state gateway must not own ${forbidden}`);
}
for (const forbidden of ["JSON.parse", "JSON.stringify", "base64", "_malloc", "HEAPU8.set", "fetch("]) {
  assert.equal(gatewayApply.includes(forbidden), false, `gateway apply boundary must not contain ${forbidden}`);
  assert.equal(performerCommit.includes(forbidden), false, `BRK performer commit boundary must not contain ${forbidden}`);
}

console.log("A5 #297-B prepared-state runtime boundary regression passed");
