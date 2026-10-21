const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");
require("./engine-registry-domain.js");
require("./performer-registry-domain.js");
require("./synth-gateway-domain.js");
const abi = require("./brk-synth-abi-v1-worklet.js");
const production = require("./production-audio-runtime.js");

function fakeModule() {
  const buffer = new ArrayBuffer(8 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  let cursor = 8192;
  let nextHandle = 20;
  const blocks = [];
  const liveHandles = new Set();
  return {
    HEAPU8,
    HEAPF32,
    blocks,
    liveHandles,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return abi.ABI_VERSION; },
    _brk_instance_create() { const handle = ++nextHandle; liveHandles.add(handle); return handle; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate() { return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset() { return 0; },
    _brk_instance_destroy(handle) { liveHandles.delete(handle); return 0; },
    _brk_instance_state_read() { return 0; },
    _brk_instance_process(handle, processPtr) {
      const dv = new DataView(buffer);
      const frames = dv.getUint32(processPtr + 4, true);
      const audioSpanPtr = dv.getUint32(processPtr + 8, true);
      const eventPtr = dv.getUint32(processPtr + 12, true);
      const eventCount = dv.getUint32(processPtr + 20, true);
      const events = [];
      let offset = eventPtr;
      for (let index = 0; index < eventCount; index += 1) {
        const size = dv.getUint16(offset, true);
        events.push({
          type: dv.getUint16(offset + 2, true),
          frameOffset: dv.getUint32(offset + 4, true),
          noteId: dv.getUint32(offset + 12, true),
        });
        offset += size;
      }
      blocks.push({ handle, frames, events });
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

const hostContract = { id: packageDomain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const entry = {
  moduleId: "design.myldy.r2-capacity",
  engineId: "primitive-capacity",
  version: "1.0.0",
  channel: "stable",
  hostContract,
  abiVersion: abi.ABI_VERSION,
  packageUrl: "fixture://r2-capacity",
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
  abiVersion: abi.ABI_VERSION,
  stateSchemaVersion: 1,
  stateBytes: 64,
  parameterSchemaVersion: 1,
  contentSha256: "e".repeat(64),
  files: [{ path: "runtime/module.wasm", bytes: 1, sha256: "f".repeat(64) }],
  runtime: { maxModuleInstances: 16, wasmInitialMemoryBytes: 8 * 1024 * 1024, memoryGrowth: false },
  parameters: [],
};
const wasmModule = fakeModule();
abi.registerModuleRuntime({ entry, manifest, module: wasmModule });

const instrument = {
  id: 3,
  engineRef: { moduleId: entry.moduleId, engineId: entry.engineId, resolvedVersion: entry.version },
  patchState: { schemaVersion: 1, encoding: "opaque", data: null },
  parameterSnapshot: {},
};
const firstBlockFrames = new Map([[1, 1], [8, 17], [9, 63], [16, 127]]);
const secondBlockFrames = new Map([[1, 7], [8, 31], [9, 128], [16, 255]]);
let origin = 1000;

for (const count of [1, 8, 9, 16]) {
  const runtime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: count });
  runtime.configureInstruments({ 3: instrument });
  runtime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: Array(count).fill(3) }] });
  assert.equal(runtime.diagnostics().performers.activePreparedCount, count, `${count} primitive performers must be prepared before render`);
  assert.equal(wasmModule.liveHandles.size, count, `${count} independent ABI handles must be live`);

  const firstFrames = firstBlockFrames.get(count);
  const firstOffset = firstFrames - 1;
  const firstStart = origin;
  const blockStart = wasmModule.blocks.length;
  runtime.beginBlock(firstStart, firstFrames);
  for (let track = 0; track < count; track += 1) {
    assert.equal(runtime.routePreparedLifecycle(firstStart + firstOffset, track, 3, "note-on", 48 + (track % 24), 100), true);
  }
  runtime.renderInto(new Float32Array(firstFrames), new Float32Array(firstFrames), Array.from({ length: count }, () => ({ gain: 1, pan: 0, mute: false })));
  runtime.endBlock();
  const noteOnBlocks = wasmModule.blocks.slice(blockStart, blockStart + count);
  assert.equal(noteOnBlocks.length, count);
  assert.ok(noteOnBlocks.every((block) => block.frames === firstFrames));
  assert.ok(noteOnBlocks.every((block) => block.events.length === 1 && block.events[0].type === abi.EVENT.NOTE_ON));
  assert.ok(noteOnBlocks.every((block) => block.events[0].frameOffset === firstOffset), `${count} Note On offsets must use the actual variable render quantum`);
  assert.equal(new Set(noteOnBlocks.map((block) => block.handle)).size, count, `${count} primitive deliveries must use distinct performer handles`);

  const secondFrames = secondBlockFrames.get(count);
  const secondOffset = secondFrames - 1;
  const secondStart = firstStart + firstFrames;
  const releaseBlockStart = wasmModule.blocks.length;
  runtime.beginBlock(secondStart, secondFrames);
  for (let track = 0; track < count; track += 1) {
    assert.equal(runtime.routePreparedLifecycle(secondStart + secondOffset, track, 3, "note-off", -2, 1), true);
  }
  runtime.renderInto(new Float32Array(secondFrames), new Float32Array(secondFrames), Array.from({ length: count }, () => ({ gain: 1, pan: 0, mute: false })));
  runtime.endBlock();
  const noteOffBlocks = wasmModule.blocks.slice(releaseBlockStart, releaseBlockStart + count);
  assert.equal(noteOffBlocks.length, count);
  assert.ok(noteOffBlocks.every((block) => block.frames === secondFrames));
  assert.ok(noteOffBlocks.every((block) => block.events.length === 1 && block.events[0].type === abi.EVENT.NOTE_OFF));
  assert.ok(noteOffBlocks.every((block) => block.events[0].frameOffset === secondOffset), `${count} Note Off offsets must use the next variable render quantum`);
  assert.equal(runtime.diagnostics().gateway.overrunCount, 0);

  runtime.stop();
  assert.equal(wasmModule.liveHandles.size, 0, `${count} performer run must retire all ABI handles at Stop`);
  origin = secondStart + secondFrames + 1000;
}

console.log("K3 R2 primitive ProductionAudio 1/8/9/16 performer + variable-block lifecycle tests passed");
