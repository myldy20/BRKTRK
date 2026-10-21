const assert = require("node:assert/strict");
const abi = require("./brk-synth-abi-v1-worklet.js");

function fakeModule() {
  const buffer = new ArrayBuffer(4 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  let cursor = 4096;
  const seen = [];
  let nextHandle = 1;
  return {
    HEAPU8,
    HEAPF32,
    seen,
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
    _brk_instance_process(_handle, processPtr) {
      const dv = new DataView(buffer);
      const frames = dv.getUint32(processPtr + 4, true);
      const audioSpanPtr = dv.getUint32(processPtr + 8, true);
      const eventPtr = dv.getUint32(processPtr + 12, true);
      const eventCount = dv.getUint32(processPtr + 20, true);
      let offset = eventPtr;
      for (let index = 0; index < eventCount; index += 1) {
        const size = dv.getUint16(offset, true);
        const type = dv.getUint16(offset + 2, true);
        const frameOffset = dv.getUint32(offset + 4, true);
        const parameterId = [abi.EVENT.PARAM_VALUE, abi.EVENT.PARAM_RAMP].includes(type) ? dv.getUint32(offset + 12, true) : null;
        const value = type === abi.EVENT.PARAM_VALUE ? dv.getFloat32(offset + 16, true) : null;
        const endValue = type === abi.EVENT.PARAM_RAMP ? dv.getFloat32(offset + 20, true) : null;
        seen.push({ type, frameOffset, parameterId, value, endValue });
        offset += size;
      }
      const outputPtr = dv.getUint32(audioSpanPtr + 4, true);
      const stride = dv.getUint32(audioSpanPtr + 16, true);
      const base = outputPtr >>> 2;
      for (let frame = 0; frame < frames; frame += 1) {
        HEAPF32[base + frame] = 0.1;
        HEAPF32[base + stride + frame] = 0.1;
      }
      return 0;
    },
  };
}

let fixtureId = 0;
function makePerformer() {
  fixtureId += 1;
  const module = fakeModule();
  const entry = {
    moduleId: `design.myldy.deferred-fixture-${fixtureId}`,
    engineId: `deferred-fixture-${fixtureId}`,
    version: "1.0.0",
    packageSha256: "a".repeat(64),
  };
  const manifest = {
    moduleId: entry.moduleId,
    engineId: entry.engineId,
    version: entry.version,
    abiVersion: "0x00010000",
    stateSchemaVersion: 1,
    contentSha256: "b".repeat(64),
    stateBytes: 32,
    runtime: { maxModuleInstances: 4 },
    parameters: [{ id: "cutoff", abiId: 513, defaultNormalized: 0.5 }],
  };
  const record = abi.registerModuleRuntime({ entry, manifest, module });
  const factory = abi.createPerformerFactory(record, { maxBlockFrames: 16, maxEventsPerPerformer: 16 });
  const performer = factory({ track: 0, instrumentId: 0, sampleRate: 48000, parameterSnapshot: { cutoff: 0.5 } });
  performer.process({ frameCount: 16, left: new Float32Array(16), right: new Float32Array(16) });
  module.seen.length = 0;
  return { module, performer };
}

{
  const { module, performer } = makePerformer();
  performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.2, rampFrames: 20, sampleOffset: 0 });
  performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
  assert.equal(performer.diagnostics().activeParameterRampCount, 1);

  performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.4, rampFrames: 0, sampleOffset: 5 });
  assert.equal(performer.diagnostics().deferredParameterCount, 1);
  performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
  assert.equal(performer.diagnostics().activeParameterRampCount, 1);

  performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.9, rampFrames: 0, sampleOffset: 5 });
  const before = module.seen.length;
  performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
  const emitted = module.seen.slice(before).filter((event) => event.type === abi.EVENT.PARAM_VALUE);
  assert.equal(emitted.length, 1, "promotion must not duplicate same-key/same-offset parameter work");
  assert.equal(emitted[0].frameOffset, 5);
  assert.ok(Math.abs(emitted[0].value - 0.9) < 1e-6, "newer pending value must win over an older promoted deferred value");
  assert.equal(performer.diagnostics().deferredParameterCount, 0);
  assert.ok(Math.abs(performer.diagnostics().parameterValues.cutoff - 0.9) < 1e-6);
  performer.destroy();
}

{
  const { module, performer } = makePerformer();
  performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.25, rampFrames: 32, sampleOffset: 0 });
  performer.process({ frameCount: 16, left: new Float32Array(16), right: new Float32Array(16) });
  performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.75, rampFrames: 0, sampleOffset: 12 });
  assert.equal(performer.diagnostics().deferredParameterCount, 1);

  performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
  assert.equal(performer.diagnostics().deferredParameterCount, 1);
  const beforeShortBlock = module.seen.length;
  assert.doesNotThrow(() => performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) }), "deferred offset outside a short quantum must stay deferred instead of throwing event-offset");
  assert.equal(module.seen.length, beforeShortBlock, "out-of-range deferred event must not be encoded into a shorter render block");
  assert.equal(performer.diagnostics().deferredParameterCount, 1);

  const beforeWideBlock = module.seen.length;
  performer.process({ frameCount: 16, left: new Float32Array(16), right: new Float32Array(16) });
  const resumed = module.seen.slice(beforeWideBlock).filter((event) => event.type === abi.EVENT.PARAM_VALUE);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].frameOffset, 12, "deferred event must resume once its stored offset fits the actual render quantum");
  assert.ok(Math.abs(resumed[0].value - 0.75) < 1e-6);
  assert.equal(performer.diagnostics().deferredParameterCount, 0);
  performer.destroy();
}

console.log("BRK Synth ABI-v1 deferred parameter promotion regressions passed");
