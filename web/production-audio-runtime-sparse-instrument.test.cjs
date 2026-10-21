const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");
require("./engine-registry-domain.js");
require("./performer-registry-domain.js");
require("./synth-gateway-domain.js");
const abi = require("./brk-synth-abi-v1-worklet.js");
const production = require("./production-audio-runtime.js");

const instrument0 = {
  id: 0,
  engineRef: {
    moduleId: "design.myldy.fixture",
    engineId: "sparse-program-fixture",
    resolvedVersion: "1.0.0",
  },
};

const browserShaped = {
  mode: "sequence",
  steps: [{ instrumentIds: [0, null, undefined, "", "   ", null, null, null] }],
};
assert.deepEqual(
  production.programPairs(browserShaped, { 0: instrument0 }, 8),
  [[0, 0]],
  "empty sparse Track slots must not coerce to production Instrument 00",
);

assert.deepEqual(
  production.programPairs({ mode: "sequence", steps: [{ instrumentIds: ["0", -1] }] }, { 0: instrument0 }, 2),
  [[0, 0]],
  "explicit numeric-string Instrument 00 remains a valid reference",
);

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
    _brk_instance_process() { return 0; },
  };
}

const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const entry = {
  moduleId: "design.myldy.fixture",
  engineId: "live-additive-fixture",
  version: "1.0.0",
  channel: "stable",
  hostContract,
  abiVersion: 65536,
  packageUrl: "fixture://live-additive-fixture",
  packageSha256: "d".repeat(64),
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
  contentSha256: "e".repeat(64),
  files: [{ path: "runtime/module.wasm", bytes: 1, sha256: "f".repeat(64) }],
  runtime: { maxModuleInstances: 16, wasmInitialMemoryBytes: 2 * 1024 * 1024, memoryGrowth: false },
  parameters: [],
};
abi.registerModuleRuntime({ entry, manifest, module: fakeModule() });

const makeInstrument = (id) => ({
  id,
  engineRef: { moduleId: entry.moduleId, engineId: entry.engineId, resolvedVersion: entry.version },
  patchState: { schemaVersion: 1, encoding: "opaque", data: null },
  parameterSnapshot: {},
});

const instrument1 = makeInstrument(1);
const instrument2 = makeInstrument(2);
const runtime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1 });
runtime.configureInstruments({ 1: instrument1 });
runtime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [1] }] });

assert.equal(
  runtime.configureInstruments({ 1: instrument1, 2: instrument2 }),
  false,
  "the authoritative structural snapshot remains deferred while transport is active",
);
assert.equal(runtime.diagnostics().pendingInstrumentSync, true);
assert.ok(runtime.hasInstrument(2), "a new Instrument backed by the already-active exact engine must become addressable immediately");
assert.equal(runtime.diagnostics().traffic.promotedDeferredInstrumentAdditions, 1);

const switched = runtime.prepareProgram({
  mode: "sequence",
  steps: [
    { instrumentIds: [1] },
    { instrumentIds: [2] },
    { instrumentIds: [1] },
  ],
});
assert.equal(switched.requiredPairs, 2, "01 → 02 → 01 must prepare two independent Track×Instrument performers");
assert.deepEqual(
  switched.capacityPlan.flatMap((group) => group.pairs.map((pair) => [pair.track, pair.instrumentId])),
  [[0, 1], [0, 2]],
  "capacity planning must retain both same-package Instruments on the same Track",
);
assert.deepEqual(
  runtime.diagnostics().performers.activeSlots.map((slot) => slot.instrumentId).sort((a, b) => a - b),
  [1, 2],
  "both performer slots must exist before realtime rendering begins",
);

runtime.stop();
assert.equal(runtime.diagnostics().pendingInstrumentSync, false, "the full deferred snapshot must still reconcile at the stopped boundary");

console.log("Production sparse Instrument + live 01 → 02 → 01 pairing regressions passed");
