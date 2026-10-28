import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const [moduleArgument, goldenArgument, stateArgument] = process.argv.slice(2);
if (!moduleArgument || !goldenArgument || !stateArgument) {
  throw new Error("usage: test_wasm_module.mjs <module.js> <native-golden.bin> <state.bin>");
}

const modulePath = resolve(moduleArgument);
const goldenPath = resolve(goldenArgument);
const statePath = resolve(stateArgument);
const wasmPath = resolve(dirname(modulePath), "brk_modal_module.wasm");
const require = createRequire(import.meta.url);
const createModule = require(modulePath);
const wasmBinary = await readFile(wasmPath);
const Module = await createModule({
  wasmBinary,
  locateFile(file) {
    return resolve(dirname(modulePath), file);
  },
});

const BRK_OK = 0;
const ABI_VERSION = 0x00010000;
const STATE_SCHEMA = 0x00010000;
const EVENT_NOTE_ON = 1;
const EVENT_NOTE_OFF = 2;
const EVENT_PARAM_VALUE = 5;
const EVENT_PARAM_RAMP = 6;
const PARAM_A_DECAY = 0x1003;
const PARAM_OUTPUT_GAIN = 0x0014;
const PROCESS_REALTIME = 1;
const FRAMES = 64;
const WORKSPACE_BYTES = 2 * 1024 * 1024;

if (Module._brk_abi_version() !== ABI_VERSION) {
  throw new Error(`unexpected ABI ${Module._brk_abi_version()}`);
}

const workspace = Module._malloc(WORKSPACE_BYTES);
if (!workspace) throw new Error("WASM workspace allocation failed");
const at = (relative) => workspace + relative;
const offsets = {
  create: at(0x1000),
  prepare: at(0x1100),
  process: at(0x1200),
  audioSpan: at(0x1300),
  events: at(0x2000),
  audio: at(0x4000),
  state: at(0x10000),
  descriptor: at(0x12000),
};

const view = () => new DataView(Module.HEAPU8.buffer);
const clear = (offset, size) => Module.HEAPU8.fill(0, offset, offset + size);
const u16 = (offset, value) => view().setUint16(offset, value, true);
const i16 = (offset, value) => view().setInt16(offset, value, true);
const u32 = (offset, value) => view().setUint32(offset, value >>> 0, true);
const f32 = (offset, value) => view().setFloat32(offset, value, true);
const f64 = (offset, value) => view().setFloat64(offset, value, true);

function writeHeader(offset, size, type, frame) {
  u16(offset, size);
  u16(offset + 2, type);
  u32(offset + 4, frame);
  u32(offset + 8, 0);
}

function writeParameterValue(offset, frame, parameterId, value) {
  writeHeader(offset, 24, EVENT_PARAM_VALUE, frame);
  u32(offset + 12, parameterId);
  f32(offset + 16, value);
  u32(offset + 20, 0);
  return 24;
}

function writeNote(offset, type, frame, noteId, key = 0, velocity = 0, tuning = 0) {
  writeHeader(offset, 28, type, frame);
  u32(offset + 12, noteId);
  i16(offset + 16, key);
  i16(offset + 18, -1);
  f32(offset + 20, velocity);
  f32(offset + 24, tuning);
  return 28;
}

function writeRamp(offset, frame, parameterId, start, end, duration) {
  writeHeader(offset, 32, EVENT_PARAM_RAMP, frame);
  u32(offset + 12, parameterId);
  f32(offset + 16, start);
  f32(offset + 20, end);
  u32(offset + 24, duration);
  u32(offset + 28, 0);
  return 32;
}

function writeCreateInfo() {
  clear(offsets.create, 48);
  u32(offsets.create, 48);
  u32(offsets.create + 8, 0);
}

function writePrepareInfo(seedLow, seedHigh) {
  clear(offsets.prepare, 72);
  u32(offsets.prepare, 72);
  f64(offsets.prepare + 8, 48000);
  u32(offsets.prepare + 16, FRAMES);
  u32(offsets.prepare + 20, 32);
  u32(offsets.prepare + 24, 2);
  u32(offsets.prepare + 28, 768 * 1024);
  u32(offsets.prepare + 32, seedLow);
  u32(offsets.prepare + 36, seedHigh);
}

function processBlock(handle, eventBytes, eventCount) {
  clear(offsets.audio, FRAMES * 2 * 4);
  clear(offsets.events, 512);
  if (eventBytes) eventBytes();

  clear(offsets.audioSpan, 24);
  u32(offsets.audioSpan, 24);
  u32(offsets.audioSpan + 4, offsets.audio);
  u32(offsets.audioSpan + 8, 2);
  u32(offsets.audioSpan + 12, FRAMES);
  u32(offsets.audioSpan + 16, FRAMES);

  clear(offsets.process, 64);
  u32(offsets.process, 64);
  u32(offsets.process + 4, FRAMES);
  u32(offsets.process + 8, offsets.audioSpan);
  u32(offsets.process + 12, offsets.events);
  u32(offsets.process + 16, eventBytes?.byteSize ?? 0);
  u32(offsets.process + 20, eventCount);
  u32(offsets.process + 28, PROCESS_REALTIME);

  const result = Module._brk_instance_process(handle, offsets.process);
  if (result !== BRK_OK) throw new Error(`process failed ${result}`);
  const floats = new Float32Array(Module.HEAPF32.buffer, offsets.audio, FRAMES * 2);
  return {
    left: Array.from(floats.slice(0, FRAMES)),
    right: Array.from(floats.slice(FRAMES, FRAMES * 2)),
  };
}

const moduleRequired = Module._brk_module_descriptor(0, 0);
if (moduleRequired <= 64 || Module._brk_module_descriptor(offsets.descriptor, moduleRequired) !== moduleRequired) {
  throw new Error("module descriptor export failed");
}

writeCreateInfo();
const handle = Module._brk_instance_create(0, offsets.create);
const secondHandle = Module._brk_instance_create(0, offsets.create);
if (handle <= 0 || secondHandle <= 0 || handle === secondHandle) {
  throw new Error("multi-instance create failed");
}

writePrepareInfo(0x44554c45, 0x50344d4f);
if (Module._brk_instance_prepare(handle, offsets.prepare) !== BRK_OK) {
  throw new Error("prepare failed");
}

const state = await readFile(statePath);
if (state.byteLength !== 768) throw new Error(`bad state fixture size ${state.byteLength}`);
Module.HEAPU8.set(state, offsets.state);
if (Module._brk_instance_state_read(handle, offsets.state, state.byteLength, STATE_SCHEMA) !== BRK_OK) {
  throw new Error("state read failed");
}

const memoryBytesBeforeActivation = Module.HEAPU8.buffer.byteLength;
if (Module._brk_instance_activate(handle) !== BRK_OK) throw new Error("activate failed");

let cursor = offsets.events;
const block0Writer = () => {
  cursor = offsets.events;
  cursor += writeParameterValue(cursor, 0, PARAM_A_DECAY, 0.4);
  cursor += writeNote(cursor, EVENT_NOTE_ON, 0, 1, 52, 0.72, 0);
  cursor += writeRamp(cursor, 13, PARAM_OUTPUT_GAIN, 0.2, 0.8, 96);
};
block0Writer.byteSize = 24 + 28 + 32;
const block2Writer = () => {
  cursor = offsets.events;
  cursor += writeNote(cursor, EVENT_NOTE_OFF, 10, 1);
};
block2Writer.byteSize = 28;

const rendered = [
  processBlock(handle, block0Writer, 3),
  processBlock(handle, null, 0),
  processBlock(handle, block2Writer, 1),
];

const memoryBytesAfterProcessing = Module.HEAPU8.buffer.byteLength;
if (memoryBytesAfterProcessing !== memoryBytesBeforeActivation) {
  throw new Error("WASM memory grew after activation");
}
if (Module._brk_instance_state_size(handle) !== 768) throw new Error("state size export failed");
if (Module._brk_instance_state_write(handle, offsets.state, 768) !== BRK_OK) {
  throw new Error("state write failed");
}

const golden = await readFile(goldenPath);
const goldenView = new DataView(golden.buffer, golden.byteOffset, golden.byteLength);
if (goldenView.getUint32(0, true) !== 0x474b5242) throw new Error("bad golden magic");
const goldenFrames = goldenView.getUint32(4, true);
const goldenChannels = goldenView.getUint32(8, true);
if (goldenFrames !== 192 || goldenChannels !== 2 || golden.byteLength !== 16 + 192 * 2 * 4) {
  throw new Error(`bad golden layout frames=${goldenFrames} channels=${goldenChannels} bytes=${golden.byteLength}`);
}

let maximumAbsoluteError = 0;
let squaredError = 0;
let sampleCount = 0;
let goldenOffset = 16;
for (const block of rendered) {
  for (let frame = 0; frame < FRAMES; frame += 1) {
    for (const actual of [block.left[frame], block.right[frame]]) {
      const expected = goldenView.getFloat32(goldenOffset, true);
      goldenOffset += 4;
      const error = Math.abs(actual - expected);
      maximumAbsoluteError = Math.max(maximumAbsoluteError, error);
      squaredError += error * error;
      sampleCount += 1;
    }
  }
}
const rmsError = Math.sqrt(squaredError / sampleCount);
if (maximumAbsoluteError > 1e-4 || rmsError > 1e-5) {
  throw new Error(`native/WASM mismatch max=${maximumAbsoluteError} rms=${rmsError}`);
}

if (Module._brk_instance_deactivate(handle) !== BRK_OK
  || Module._brk_instance_destroy(handle) !== BRK_OK
  || Module._brk_instance_destroy(secondHandle) !== BRK_OK) {
  throw new Error("destroy lifecycle failed");
}
Module._free(workspace);

console.log(`wasm_memory_bytes=${memoryBytesAfterProcessing}`);
console.log(`wasm_golden_samples=${sampleCount}`);
console.log(`wasm_max_absolute_error=${maximumAbsoluteError}`);
console.log(`wasm_rms_error=${rmsError}`);
