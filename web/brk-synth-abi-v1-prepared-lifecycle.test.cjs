const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const abi = require("./brk-synth-abi-v1-worklet.js");

const source = readFileSync(require.resolve("./brk-synth-abi-v1-worklet.js"), "utf8");
assert.doesNotMatch(source, /materializePreparedForLegacy/, "prepared musical events must never be materialized back into legacy action objects");
const encodeSource = source.match(/function encodeActions\(frameCount\) \{([\s\S]*?)\n      \}\n\n      function advanceParameterRamps/);
assert.ok(encodeSource, "prepared ABI encodeActions implementation must be inspectable");
assert.doesNotMatch(encodeSource[1], /\.sort\s*\(/, "ABI render-path action ordering must not call Array.sort");
assert.doesNotMatch(encodeSource[1], /materializePrepared/, "ABI render path must merge prepared records directly");

function fakeModule() {
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  let cursor = 4096;
  let nextHandle = 1;
  const seenBlocks = [];
  return {
    HEAPU8,
    HEAPF32,
    seenBlocks,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return abi.ABI_VERSION; },
    _brk_instance_create() { return nextHandle++; },
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
      const eventBytes = dv.getUint32(processPtr + 16, true);
      const eventCount = dv.getUint32(processPtr + 20, true);
      const events = [];
      let offset = eventPtr;
      for (let index = 0; index < eventCount; index += 1) {
        const size = dv.getUint16(offset, true);
        const type = dv.getUint16(offset + 2, true);
        const frameOffset = dv.getUint32(offset + 4, true);
        const noteId = [abi.EVENT.NOTE_ON, abi.EVENT.NOTE_OFF, abi.EVENT.NOTE_CHOKE, abi.EVENT.RETRIGGER].includes(type)
          ? dv.getUint32(offset + 12, true)
          : null;
        const parameterId = [abi.EVENT.PARAM_VALUE, abi.EVENT.PARAM_RAMP].includes(type)
          ? dv.getUint32(offset + 12, true)
          : null;
        events.push({ type, frameOffset, noteId, parameterId });
        offset += size;
      }
      assert.equal(offset - eventPtr, eventBytes);
      seenBlocks.push(events);
      const outputPtr = dv.getUint32(audioSpanPtr + 4, true);
      const stride = dv.getUint32(audioSpanPtr + 16, true);
      const base = outputPtr >>> 2;
      for (let frame = 0; frame < frames; frame += 1) {
        HEAPF32[base + frame] = 0;
        HEAPF32[base + stride + frame] = 0;
      }
      return 0;
    },
  };
}

const wasmModule = fakeModule();
const entry = {
  moduleId: "design.myldy.r2-prepared",
  engineId: "prepared-lifecycle",
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
  parameters: [{ id: "cutoff", abiId: 513, defaultNormalized: 1 }],
};
const record = abi.registerModuleRuntime({ entry, manifest, module: wasmModule });
const factory = abi.createPerformerFactory(record, { maxBlockFrames: 16, maxEventsPerPerformer: 8 });
const performer = factory({ track: 0, instrumentId: 0, sampleRate: 48000, parameterSnapshot: {} });
const render = (frames = 8) => performer.process({ frameCount: frames, left: new Float32Array(frames), right: new Float32Array(frames) });

performer.preflightPreparedLifecycle("note-on", 0, 60, 100);
performer.handlePreparedLifecycle("note-on", 0, 60, 100);
render();
assert.deepEqual(wasmModule.seenBlocks.at(-1).map((event) => event.type), [abi.EVENT.NOTE_ON]);
const firstNoteId = wasmModule.seenBlocks.at(-1)[0].noteId;
assert.ok(firstNoteId > 0);

performer.preflightPreparedLifecycle("note-off", 2, 60, 100);
performer.handlePreparedLifecycle("note-off", 2, 60, 100);
performer.preflightPreparedLifecycle("note-on", 2, 64, 90);
performer.handlePreparedLifecycle("note-on", 2, 64, 90);
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.5, rampFrames: 0, sampleOffset: 2 });
render();
const mixed = wasmModule.seenBlocks.at(-1);
assert.deepEqual(mixed.map((event) => event.type), [abi.EVENT.NOTE_OFF, abi.EVENT.PARAM_VALUE, abi.EVENT.NOTE_ON]);
assert.deepEqual(mixed.map((event) => event.frameOffset), [2, 2, 2]);
assert.equal(mixed[0].noteId, firstNoteId, "prepared release must target the active BRK note ID");
const secondNoteId = mixed[2].noteId;
assert.ok(secondNoteId > firstNoteId, "prepared trigger must allocate the next deterministic BRK note ID");

performer.preflightPreparedLifecycle("retrigger", 3, 64, 90);
performer.handlePreparedLifecycle("retrigger", 3, 64, 90);
render();
const retrigger = wasmModule.seenBlocks.at(-1)[0];
assert.equal(retrigger.type, abi.EVENT.RETRIGGER);
assert.equal(retrigger.frameOffset, 3);
assert.equal(retrigger.noteId, secondNoteId, "prepared RET must preserve the active note identity");

const bounded = factory({ track: 1, instrumentId: 0, sampleRate: 48000, parameterSnapshot: {} });
bounded.handlePreparedLifecycle("note-on", 1, 60, 100);
bounded.handlePreparedLifecycle("retrigger", 2, 60, 100);
assert.throws(() => bounded.handlePreparedLifecycle("note-off", 1, 60, 100), /non-decreasing sampleOffset\/priority order/);
assert.equal(bounded.diagnostics().preparedLifecyclePending, 2);

const tinyFactory = abi.createPerformerFactory(record, { maxBlockFrames: 16, maxEventsPerPerformer: 2 });
const tiny = tinyFactory({ track: 2, instrumentId: 0, sampleRate: 48000, parameterSnapshot: {} });
tiny.handlePreparedLifecycle("note-on", 0, 60, 100);
tiny.handlePreparedLifecycle("retrigger", 1, 60, 100);
assert.throws(() => tiny.handlePreparedLifecycle("retrigger", 2, 60, 100), /capacity 2 exceeded/);
assert.equal(tiny.diagnostics().preparedLifecyclePending, 2, "capacity overflow must not partially mutate the typed queue");

console.log("K3 R2 BRK ABI primitive lifecycle direct-merge + release/parameter/trigger ordering tests passed");
