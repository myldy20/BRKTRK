const assert = require("node:assert/strict");
const abi = require("./brk-synth-runtime-lifetime-extension.js");

function fakeModule() {
  const buffer = new ArrayBuffer(1024 * 1024);
  let cursor = 4096;
  let nextHandle = 1;
  const liveHandles = new Set();
  return {
    HEAPU8: new Uint8Array(buffer),
    HEAPF32: new Float32Array(buffer),
    liveHandles,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return 0x00010000; },
    _brk_instance_create() { const handle = nextHandle++; liveHandles.add(handle); return handle; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate() { return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset() { return 0; },
    _brk_instance_destroy(handle) { liveHandles.delete(handle); return 0; },
    _brk_instance_state_read() { return 0; },
    _brk_instance_process() { return 0; },
  };
}

const entry = Object.freeze({
  moduleId: "design.myldy.retirement-fixture",
  engineId: "retirement-fixture",
  version: "1.0.0",
  packageSha256: "a".repeat(64),
});
const manifest = Object.freeze({
  moduleId: entry.moduleId,
  engineId: entry.engineId,
  version: entry.version,
  abiVersion: "0x00010000",
  stateSchemaVersion: 1,
  contentSha256: "b".repeat(64),
  stateBytes: 32,
  runtime: Object.freeze({ maxModuleInstances: 4 }),
  parameters: Object.freeze([]),
});

assert.equal(typeof abi.unregisterModuleRuntime, "function",
  "#349 requires an explicit Worklet runtime retirement API rather than deleting registry internals from another owner");

const firstModule = fakeModule();
const firstRecord = abi.registerModuleRuntime({ entry, manifest, module: firstModule });
const firstFactory = abi.createPerformerFactory(firstRecord, { maxBlockFrames: 8, maxEventsPerPerformer: 8 });
const performer = firstFactory({ track: 0, instrumentId: 1, sampleRate: 48000 });

assert.throws(
  () => abi.unregisterModuleRuntime(entry),
  (error) => error?.code === "runtime-in-use",
  "a runtime with a live Track × Instrument performer must fail closed instead of being retired",
);
assert.equal(abi.recordFor(entry), firstRecord, "failed retirement must leave the exact runtime registered");

performer.destroy();
assert.equal(firstModule.liveHandles.size, 0, "performer destruction must release the ABI instance before runtime retirement");
assert.equal(abi.unregisterModuleRuntime(entry), true, "inactive runtime should retire after the last performer disappears");
assert.equal(abi.recordFor(entry), null);
assert.equal(abi.runtimeRecords().some((record) => record.entry.moduleId === entry.moduleId), false);

const secondModule = fakeModule();
const secondRecord = abi.registerModuleRuntime({ entry, manifest, module: secondModule });
assert.notEqual(secondRecord, firstRecord, "returning to a retired exact package must permit a fresh runtime registration");
assert.equal(abi.unregisterModuleRuntime(entry), true);

const sameSemverA = Object.freeze({ ...entry, packageSha256: "c".repeat(64) });
const sameSemverB = Object.freeze({ ...entry, packageSha256: "d".repeat(64) });
const coexistA = abi.registerModuleRuntime({ entry: sameSemverA, manifest, module: fakeModule() });
const coexistB = abi.registerModuleRuntime({ entry: sameSemverB, manifest, module: fakeModule() });
assert.notEqual(coexistA.key, coexistB.key, "same-semver runtimes from different exact package SHA must have distinct Worklet identities");
assert.equal(abi.recordFor(sameSemverA), coexistA);
assert.equal(abi.recordFor(sameSemverB), coexistB);
assert.equal(abi.unregisterModuleRuntime(sameSemverA), true, "retiring SHA A must not retire same-semver SHA B");
assert.equal(abi.recordFor(sameSemverA), null);
assert.equal(abi.recordFor(sameSemverB), coexistB);
assert.equal(abi.unregisterModuleRuntime(sameSemverB), true);

console.log("A5 #349 Worklet runtime retirement regression passed");