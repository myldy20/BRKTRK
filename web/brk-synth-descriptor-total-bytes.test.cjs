// Native ABI descriptor functions return total bytes (struct + UTF-8 strings).
// A parser demanding exactly 84/76/96 bytes silently hid BRK Modal's entire
// 89-parameter metadata from Sound, even though the engine was registered.
const assert = require("node:assert/strict");
require("./brk-synth-abi-v1-worklet.js");
const read = globalThis.BRKTRKBrkSynthAbiV1Runtime.readModuleDescriptors;
const heap = new Uint8Array(4096);
const view = new DataView(heap.buffer);
const scratch = 512;
const put32 = (at, value) => view.setUint32(scratch + at, value, true);
const putFloat = (at, value) => view.setFloat32(scratch + at, value, true);
function writeStrings(baseBytes, values) {
  let used = 0;
  for (const [refOffset, value] of values) {
    const bytes = Buffer.from(value, "utf8");
    heap.set(bytes, scratch + baseBytes + used);
    put32(refOffset, scratch + baseBytes + used);
    put32(refOffset + 4, bytes.length);
    used += bytes.length;
  }
  return baseBytes + used;
}
const module = {
  HEAPU8: heap,
  _malloc: () => scratch,
  _free: () => {},
  _brk_module_descriptor: () => {
    heap.fill(0, scratch, scratch + 256);
    put32(0, 84); put32(12, 1);
    return writeStrings(84, [
      [16, "design.myldy.brk-modal"], [24, "BRK Modal"],
      [32, "Myldy"], [40, "GPL-3.0-only"],
    ]);
  },
  _brk_engine_descriptor: (engine) => {
    if (engine !== 0) return 0;
    heap.fill(0, scratch, scratch + 256);
    put32(0, 76); put32(24, 2); put32(28, 2);
    put32(32, 65536); put32(36, 16);
    return writeStrings(76, [[8, "brk-modal"], [16, "BRK Modal"]]);
  },
  _brk_parameter_descriptor: (engine, index) => {
    if (engine !== 0 || index >= 2) return 0;
    heap.fill(0, scratch, scratch + 256);
    put32(0, 96); put32(4, index + 1);
    put32(8, 1); put32(12, 1);
    putFloat(48, 0.5); putFloat(52, 0); putFloat(56, 1);
    return writeStrings(96, [
      [16, index === 0 ? "a_decay" : "b_decay"],
      [24, index === 0 ? "A Decay" : "B Decay"],
      [32, "s"], [40, "Resonator"],
    ]);
  },
};
const descriptors = read(module);
assert.ok(descriptors, "struct + strings must parse as complete ABI metadata");
assert.equal(descriptors.module.moduleId, "design.myldy.brk-modal");
assert.equal(descriptors.engine.engineId, "brk-modal");
assert.equal(descriptors.engine.parameterCount, 2);
assert.deepEqual(descriptors.parameters.map(p => p.key), ["a_decay", "b_decay"]);
assert.deepEqual(descriptors.parameters.map(p => p.abiId), [1, 2]);
assert.deepEqual(descriptors.parameters.map(p => p.displayName), ["A Decay", "B Decay"]);
const oversize = { ...module, _brk_parameter_descriptor: (engine, index) =>
  index === 1 ? 300 : module._brk_parameter_descriptor(engine, index) };
assert.equal(read(oversize), null, "do not accept truncated descriptor sets or oversized records");
console.log("Modal ABI descriptor total-size contract PASS");
