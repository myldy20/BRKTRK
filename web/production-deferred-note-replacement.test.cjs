"use strict";

// A deferred Instrument snapshot rebuilds the gateway at Stop. The first
// note routes through the live runtime; the next note must replace it through
// that same gateway instead of the stale one from the prior transport.
const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");
require("./engine-registry-domain.js");
require("./performer-registry-domain.js");
require("./synth-gateway-domain.js");
const abi = require("./brk-synth-abi-v1-worklet.js");

function fakeModule() {
  const buffer = new ArrayBuffer(4 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  let cursor = 8192;
  let nextHandle = 10;
  const liveHandles = new Set();
  const processHandles = [];
  let destroyed = 0;
  let failNextDestroy = false;
  return {
    HEAPU8,
    HEAPF32,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return 0x00010000; },
    liveHandles,
    processHandles,
    get destroyed() { return destroyed; },
    failNextDestroy() { failNextDestroy = true; },
    _brk_instance_create() { const handle = ++nextHandle; liveHandles.add(handle); return handle; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate() { return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset() { return 0; },
    _brk_instance_destroy(handle) {
      if (failNextDestroy) { failNextDestroy = false; return 91; }
      liveHandles.delete(handle);
      destroyed += 1;
      return 0;
    },
    _brk_instance_state_read() { return 0; },
    _brk_instance_process(handle, processPtr) {
      processHandles.push(handle);
      const dv = new DataView(buffer);
      const frames = dv.getUint32(processPtr + 4, true);
      const span = dv.getUint32(processPtr + 8, true);
      const outputPtr = dv.getUint32(span + 4, true);
      const stride = dv.getUint32(span + 16, true);
      const base = outputPtr >>> 2;
      for (let frame = 0; frame < frames; frame += 1) {
        HEAPF32[base + frame] = 0.2;
        HEAPF32[base + stride + frame] = 0.1;
      }
      return 0;
    },
  };
}

const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const entry = {
  moduleId: "design.myldy.fixture",
  engineId: "runtime-fixture",
  version: "1.0.0",
  channel: "stable",
  hostContract,
  abiVersion: 65536,
  packageUrl: "fixture://runtime-fixture",
  packageSha256: "a".repeat(64),
  stateSchemaVersion: 1,
  parameterSchemaVersion: 1,
  status: "active",
};
const manifest = {
  schema: packageDomain.PACKAGE_FORMAT,
  moduleId: entry.moduleId,
  engineId: entry.engineId,
  version: entry.version,
  hostContract,
  abiVersion: 65536,
  stateSchemaVersion: 1,
  stateBytes: 224,
  parameterSchemaVersion: 1,
  contentSha256: "b".repeat(64),
  files: [{ path: "runtime/module.wasm", bytes: 1, sha256: "c".repeat(64) }],
  runtime: { maxModuleInstances: 16, wasmInitialMemoryBytes: 4 * 1024 * 1024, memoryGrowth: false },
  parameters: [{ id: "cutoff", abiId: 513, defaultNormalized: 1 }],
};
const wasmModule = fakeModule();

assert.deepEqual(packageDomain.moduleInstanceCapability(manifest), {
  capacity: 16,
  source: "runtime.maxModuleInstances",
  explicit: true,
  legacy: false,
});
assert.deepEqual(packageDomain.moduleInstanceCapability({ runtime: {} }), {
  capacity: 8,
  source: "legacy-host-fallback",
  explicit: false,
  legacy: true,
});

const instrument = {
  id: 3,
  engineRef: { moduleId: entry.moduleId, engineId: entry.engineId, resolvedVersion: entry.version },
  patchState: { schemaVersion: 1, encoding: "opaque", data: null },
  parameterSnapshot: { cutoff: 0.5 },
};
require("./brk-synth-runtime-lifetime-extension.js");
require("./brk-synth-prepared-state-extension.js");
require("./brk-synth-r6-realtime-extension.js");
require("./prepared-instrument-state-worklet-domain.js");
require("./prepared-instrument-state-gateway-extension.js");
require("./synth-gateway-r6-realtime-extension.js");
require("./production-audio-runtime.js");
require("./production-runtime-lifetime-extension.js");
require("./production-r6-realtime-extension.js");
require("./production-prepared-lifecycle-pair-runtime-extension.js");
require("./production-track-note-owner-runtime-extension.js");
require("./production-prepared-state-runtime-extension.js");
const actual = globalThis.BRKTRKProductionAudioRuntime.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 2 });
actual.prepareProgram({ mode: "sequence", steps: [] });
globalThis.BRKTRKBrkSynthAbiV1Runtime.registerModuleRuntime({ entry, manifest, module: wasmModule });
assert.equal(actual.configureInstruments({ 3: instrument }), false, "Instrument sync remains deferred during transport");
assert.equal(actual.diagnostics().pendingInstrumentSync, true);
actual.stop();
assert.equal(actual.diagnostics().pendingInstrumentSync, false);
actual.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3, -1] }] });
actual.beginBlock(0, 128);
assert.equal(actual.routePreparedLifecycle(0, 0, 3, "note-on", 48, 58), true);
actual.endBlock();
actual.beginBlock(128, 128);
assert.equal(actual.routePreparedLifecycle(128, 0, 3, "note-on", 60, 100), true, "note replacement must route through the gateway promoted at Stop");
actual.endBlock();

assert.equal(actual.diagnostics().trackNoteOwnership.replacements, 1);
actual.stop();
console.log("Deferred Instrument Stop → note replacement regression passed");
