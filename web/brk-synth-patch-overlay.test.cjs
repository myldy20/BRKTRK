const assert = require("node:assert/strict");
const abi = require("./brk-synth-abi-v1-worklet.js");

function fixtureModule() {
  const buffer = new ArrayBuffer(1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  let cursor = 4096;
  const stateReads = [];
  const processes = [];
  return {
    HEAPU8,
    HEAPF32,
    stateReads,
    processes,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return abi.ABI_VERSION; },
    _brk_instance_create() { return 1; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate() { return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset() { return 0; },
    _brk_instance_destroy() { return 0; },
    _brk_instance_state_read(_handle, ptr, size, schema) {
      stateReads.push({ bytes: Array.from(HEAPU8.slice(ptr, ptr + size)), schema });
      return 0;
    },
    _brk_instance_process(_handle, processPtr) {
      const view = new DataView(buffer);
      const eventPtr = view.getUint32(processPtr + 12, true);
      const eventBytes = view.getUint32(processPtr + 16, true);
      const eventCount = view.getUint32(processPtr + 20, true);
      const decoded = [];
      let offset = eventPtr;
      for (let index = 0; index < eventCount; index += 1) {
        const size = view.getUint16(offset, true);
        const type = view.getUint16(offset + 2, true);
        if (type === abi.EVENT.PARAM_VALUE) decoded.push({
          type,
          parameterId: view.getUint32(offset + 12, true),
          value: view.getFloat32(offset + 16, true),
        });
        offset += size;
      }
      processes.push({ eventBytes, eventCount, decoded });
      return 0;
    },
  };
}

const fixture = fixtureModule();
const record = {
  entry: { moduleId: "design.myldy.fixture", engineId: "fixture", version: "1.0.0" },
  manifest: {
    stateSchemaVersion: 65536,
    stateBytes: 4,
    runtime: { maxModuleInstances: 2 },
    parameters: [{ id: "cutoff", numericId: 513, defaultNormalized: 1 }],
  },
  module: fixture,
};
const factory = abi.createPerformerFactory(record);
const performer = factory({
  track: 0,
  instrumentId: 3,
  sampleRate: 48000,
  patchState: { schemaVersion: 65536, encoding: "base64", data: Buffer.from([1, 2, 3, 4]).toString("base64") },
  parameterSnapshot: { cutoff: 0.25 },
});
assert.equal(fixture.stateReads.length, 1);
assert.deepEqual(fixture.stateReads[0], { bytes: [1, 2, 3, 4], schema: 65536 });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(fixture.processes[0].eventCount, 1, "stable snapshot must overlay initial opaque state");
assert.equal(fixture.processes[0].decoded[0].parameterId, 513);
assert.ok(Math.abs(fixture.processes[0].decoded[0].value - 0.25) < 1e-6);

performer.applyState({
  patchState: { schemaVersion: 65536, encoding: "base64", data: Buffer.from([9, 8, 7, 6]).toString("base64") },
  parameterSnapshot: { cutoff: 0.75 },
});
assert.equal(fixture.stateReads.length, 2);
assert.deepEqual(fixture.stateReads[1], { bytes: [9, 8, 7, 6], schema: 65536 });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(fixture.processes[1].eventCount, 1, "stable snapshot must overlay replaced opaque state");
assert.ok(Math.abs(fixture.processes[1].decoded[0].value - 0.75) < 1e-6);

performer.destroy();
console.log("A4B1 opaque patch + stable parameter override contract passed");