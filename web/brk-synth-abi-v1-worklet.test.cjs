const assert = require("node:assert/strict");
const abi = require("./brk-synth-abi-v1-worklet.js");

function fakeModule() {
  const buffer = new ArrayBuffer(4 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  let cursor = 4096;
  const seen = [];
  let destroyed = 0;
  let nextHandle = 6;
  const liveHandles = new Set();
  return {
    HEAPU8,
    HEAPF32,
    seen,
    get destroyed() { return destroyed; },
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return 0x00010000; },
    liveHandles,
    _brk_instance_create() { const handle = ++nextHandle; liveHandles.add(handle); return handle; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_activate() { return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset() { return 0; },
    _brk_instance_destroy(handle) { liveHandles.delete(handle); destroyed += 1; return 0; },
    _brk_instance_state_read() { return 0; },
    _brk_instance_process(_handle, processPtr) {
      const dv = new DataView(buffer);
      const frames = dv.getUint32(processPtr + 4, true);
      const audioSpanPtr = dv.getUint32(processPtr + 8, true);
      const eventPtr = dv.getUint32(processPtr + 12, true);
      const eventBytes = dv.getUint32(processPtr + 16, true);
      const eventCount = dv.getUint32(processPtr + 20, true);
      let offset = eventPtr;
      for (let index = 0; index < eventCount; index += 1) {
        const size = dv.getUint16(offset, true);
        const type = dv.getUint16(offset + 2, true);
        const frameOffset = dv.getUint32(offset + 4, true);
        const noteId = [1, 2, 3, 4].includes(type) ? dv.getUint32(offset + 12, true) : null;
        const parameterId = [5, 6].includes(type) ? dv.getUint32(offset + 12, true) : null;
        const durationFrames = type === 6 ? dv.getUint32(offset + 24, true) : null;
        seen.push({ type, size, frameOffset, noteId, parameterId, durationFrames });
        offset += size;
      }
      assert.equal(offset - eventPtr, eventBytes);
      const outputPtr = dv.getUint32(audioSpanPtr + 4, true);
      const stride = dv.getUint32(audioSpanPtr + 16, true);
      const base = outputPtr >>> 2;
      for (let frame = 0; frame < frames; frame += 1) {
        HEAPF32[base + frame] = 0.1;
        HEAPF32[base + stride + frame] = 0.2;
      }
      return 0;
    },
  };
}

const wasmModule = fakeModule();
const entry = {
  moduleId: "design.myldy.fixture",
  engineId: "abi-v1-fixture",
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
  runtime: { maxModuleInstances: 8 },
  parameters: [
    { id: "cutoff", abiId: 513, defaultNormalized: 1 },
    { id: "filter_mode", abiId: 514, defaultNormalized: 0 },
  ],
};

const record = abi.registerModuleRuntime({ entry, manifest, module: wasmModule });
const factory = abi.createPerformerFactory(record, { maxBlockFrames: 16, maxEventsPerPerformer: 16 });
const performer = factory({ track: 2, instrumentId: 3, sampleRate: 48000, parameterSnapshot: { cutoff: 0.5 } });

assert.deepEqual([...abi.base64Bytes("AQIDBA==")], [1, 2, 3, 4]);
assert.equal(abi.parameterMap(manifest).get("cutoff").abiId, 513);

performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.25, rampFrames: 8, sampleOffset: 0 });
performer.handleEvent({ type: "note-on", pitch: 60, velocity: 100, sampleOffset: 0 });
const left = new Float32Array(8);
const right = new Float32Array(8);
performer.process({ frameCount: 8, left, right });
assert.deepEqual(wasmModule.seen.slice(0, 3).map((event) => event.type), [abi.EVENT.PARAM_VALUE, abi.EVENT.PARAM_RAMP, abi.EVENT.NOTE_ON]);
const noteOn = wasmModule.seen[2];
assert.ok(noteOn.noteId > 0, "BRK Note On must use a deterministic non-zero note ID");
assert.ok(left.every((value) => Math.abs(value - 0.1) < 1e-6));
assert.ok(right.every((value) => Math.abs(value - 0.2) < 1e-6));

const scheduledParameterStart = wasmModule.seen.length;
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.2, rampFrames: 0, sampleOffset: 1 });
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.7, rampFrames: 0, sampleOffset: 5 });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
const scheduledParameters = wasmModule.seen.slice(scheduledParameterStart);
assert.deepEqual(scheduledParameters.map((event) => event.type), [abi.EVENT.PARAM_VALUE, abi.EVENT.PARAM_VALUE]);
assert.deepEqual(scheduledParameters.map((event) => event.frameOffset), [1, 5], "same-parameter events at distinct sample offsets must both reach the ABI");

performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.3, rampFrames: 14, sampleOffset: 0 });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(performer.diagnostics().activeParameterRampCount, 1);
const activeRampOffsetStart = wasmModule.seen.length;
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.35, rampFrames: 0, sampleOffset: 1 });
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.7, rampFrames: 0, sampleOffset: 3 });
assert.equal(performer.diagnostics().deferredParameterCount, 2, "active-ramp queue must preserve distinct sample offsets");
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(wasmModule.seen.length, activeRampOffsetStart, "overlapping deferred offsets must wait until the active ramp completes");
assert.equal(performer.diagnostics().pendingEvents, 0, "deferred offsets must not enter pending before the next render quantum is known");
assert.equal(performer.diagnostics().deferredParameterCount, 2, "completed-ramp offsets remain deferred until the next block validates their stored offsets");
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
const activeRampScheduled = wasmModule.seen.slice(activeRampOffsetStart);
assert.deepEqual(activeRampScheduled.map((event) => event.type), [abi.EVENT.PARAM_VALUE, abi.EVENT.PARAM_VALUE]);
assert.deepEqual(activeRampScheduled.map((event) => event.frameOffset), [1, 3]);

performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.25, rampFrames: 12, sampleOffset: 0 });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
const afterRampOffsetStart = wasmModule.seen.length;
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.4, rampFrames: 0, sampleOffset: 1 });
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.75, rampFrames: 0, sampleOffset: 5 });
assert.equal(performer.diagnostics().deferredParameterCount, 1);
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
const afterRampScheduled = wasmModule.seen.slice(afterRampOffsetStart);
assert.deepEqual(afterRampScheduled.map((event) => event.frameOffset), [5], "after-ramp offset must stay in the current block");
assert.equal(performer.diagnostics().deferredParameterCount, 0, "later valid parameter event must discard stale deferred target");
assert.equal(performer.diagnostics().pendingEvents, 0);
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(wasmModule.seen.length, afterRampOffsetStart + 1, "superseded deferred target must not reappear in the next block");

const staleSameBlockStart = wasmModule.seen.length;
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.5, rampFrames: 4, sampleOffset: 0 });
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.55, rampFrames: 0, sampleOffset: 2 });
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.9, rampFrames: 0, sampleOffset: 5 });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
const staleSameBlockEvents = wasmModule.seen.slice(staleSameBlockStart);
assert.deepEqual(staleSameBlockEvents.map((event) => event.type), [abi.EVENT.PARAM_RAMP, abi.EVENT.PARAM_VALUE]);
assert.deepEqual(staleSameBlockEvents.map((event) => event.frameOffset), [0, 5]);
assert.equal(performer.diagnostics().deferredParameterCount, 0);
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(wasmModule.seen.length, staleSameBlockStart + 2, "later same-block value must supersede an earlier overlapping deferred value");

const sameBlockRampStart = wasmModule.seen.filter((event) => event.type === abi.EVENT.PARAM_RAMP).length;
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.45, rampFrames: 12, sampleOffset: 0 });
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.65, rampFrames: 12, sampleOffset: 4 });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(wasmModule.seen.filter((event) => event.type === abi.EVENT.PARAM_RAMP).length, sameBlockRampStart + 1, "same-block overlapping ramp must be deferred");
assert.equal(performer.diagnostics().deferredParameterCount, 1);
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(wasmModule.seen.filter((event) => event.type === abi.EVENT.PARAM_RAMP).length, sameBlockRampStart + 2, "deferred ramp must resume in the first block where its offset no longer overlaps");
assert.equal(performer.diagnostics().pendingEvents, 0);
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });

performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.4, rampFrames: 8, sampleOffset: 0 });
performer.handleEvent({ type: "parameter", parameterId: "filter_mode", value: 1, rampFrames: 0, sampleOffset: 0 });
const mixedParameterStart = wasmModule.seen.length;
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.deepEqual(wasmModule.seen.slice(mixedParameterStart).map((event) => event.type), [abi.EVENT.PARAM_VALUE, abi.EVENT.PARAM_RAMP], "ABI v1 direct values must sort before ramps even when the ramp arrived first");

const rampsBeforeOverlap = wasmModule.seen.filter((event) => event.type === abi.EVENT.PARAM_RAMP).length;
const parameterDeferralsBeforeOverlap = performer.diagnostics().parameterEventsDeferred;
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.6, rampFrames: 12, sampleOffset: 0 });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(performer.diagnostics().activeParameterRampCount, 1);
performer.handleEvent({ type: "parameter", parameterId: "cutoff", value: 0.8, rampFrames: 12, sampleOffset: 0 });
assert.equal(performer.diagnostics().deferredParameterCount, 1, "a replacement target must wait while the prior ABI ramp is active");
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(wasmModule.seen.filter((event) => event.type === abi.EVENT.PARAM_RAMP).length, rampsBeforeOverlap + 1, "the adapter must not encode an overlapping ramp rejected by ABI v1");
assert.equal(performer.diagnostics().pendingEvents, 0, "a completed-ramp replacement must stay deferred until the next render block supplies its actual size");
assert.equal(performer.diagnostics().deferredParameterCount, 1, "the final target remains deferred until next-block promotion");
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
assert.equal(wasmModule.seen.filter((event) => event.type === abi.EVENT.PARAM_RAMP).length, rampsBeforeOverlap + 2);
assert.equal(performer.diagnostics().parameterValues.cutoff, 0.8, "the last deferred target must win at the ABI boundary");
assert.equal(performer.diagnostics().parameterEventsDeferred, parameterDeferralsBeforeOverlap + 1);

performer.handleEvent({ type: "retrigger", sampleOffset: 3, resetPhase: true });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
const retrigger = wasmModule.seen.at(-1);
assert.equal(retrigger.type, abi.EVENT.RETRIGGER, "production RET must encode the BRK ABI retrigger event");
assert.equal(retrigger.frameOffset, 3);
assert.equal(retrigger.noteId, noteOn.noteId, "RET must retrigger the performer's active BRK note ID rather than allocate a preview voice");

performer.handleEvent({ type: "note-off", sampleOffset: 2 });
performer.process({ frameCount: 8, left: new Float32Array(8), right: new Float32Array(8) });
const release = wasmModule.seen.at(-1);
assert.equal(release.type, abi.EVENT.NOTE_OFF);
assert.equal(release.frameOffset, 2);
assert.equal(release.noteId, noteOn.noteId, "tracker release must resolve to the performer's active BRK note ID");

performer.reset();
performer.destroy();
assert.equal(wasmModule.destroyed, 1);

const legacyModule = fakeModule();
const legacyManifest = { ...manifest, moduleId: "design.myldy.legacy-fixture", engineId: "legacy-fixture", runtime: undefined };
const legacyRecord = { entry: { ...entry, moduleId: legacyManifest.moduleId, engineId: legacyManifest.engineId }, manifest: legacyManifest, module: legacyModule };
const legacyFactory = abi.createPerformerFactory(legacyRecord, { maxBlockFrames: 16, maxEventsPerPerformer: 16 });
const legacyPerformers = Array.from({ length: 8 }, (_, index) => legacyFactory({ track: 0, instrumentId: 20 + index, sampleRate: 48000 }));
assert.equal(new Set(legacyPerformers.map((candidate) => candidate.diagnostics().handle)).size, 8);
assert.throws(() => legacyFactory({ track: 0, instrumentId: 28, sampleRate: 48000 }), (error) => error?.code === "module-instance-capacity" && error?.details?.capacity === 8 && error?.details?.capabilitySource === "legacy-host-fallback");
assert.equal(legacyFactory.diagnostics().capabilityExplicit, false);
for (const candidate of legacyPerformers) candidate.destroy();

const failingModule = fakeModule();
failingModule._brk_instance_prepare = () => 5;
const failingFactory = abi.createPerformerFactory({ ...legacyRecord, module: failingModule }, { maxBlockFrames: 16, maxEventsPerPerformer: 16 });
assert.throws(() => failingFactory({ track: 0, instrumentId: 40, sampleRate: 48000 }), (error) => error?.code === "abi-call-failed");
assert.equal(failingModule.liveHandles.size, 0, "failed performer preparation must destroy its physical module handle");
assert.equal(failingModule.destroyed, 1);
assert.equal(failingFactory.diagnostics().livePerformers, 0);


function fakeAssetModule() {
  const buffer = new ArrayBuffer(16 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  const arenaOffset = 4 * 1024 * 1024;
  const arenaBytes = 8 * 1024 * 1024;
  let cursor = 4096;
  let nextHandle = 100;
  const liveHandles = new Set();
  const bindings = [];
  const unbound = [];
  const activations = [];
  return {
    HEAPU8,
    HEAPF32,
    arenaOffset,
    arenaBytes,
    bindings,
    unbound,
    activations,
    liveHandles,
    _malloc(size) { const ptr = cursor; cursor += Number(size); return ptr; },
    _free() {},
    _brk_abi_version() { return 0x00010000; },
    _brk_asset_ext_version() { return 0x00010000; },
    _brk_asset_arena_descriptor(ptr, capacity) {
      if (capacity < 48) return 48;
      const dv = new DataView(buffer);
      for (let i = 0; i < 48; i += 1) HEAPU8[ptr + i] = 0;
      dv.setUint32(ptr + 0, 48, true);
      dv.setUint32(ptr + 4, arenaOffset, true);
      dv.setUint32(ptr + 8, arenaBytes, true);
      dv.setUint32(ptr + 12, 16, true);
      dv.setUint32(ptr + 16, 3, true);
      return 48;
    },
    _brk_instance_create() { const handle = ++nextHandle; liveHandles.add(handle); return handle; },
    _brk_instance_prepare() { return 0; },
    _brk_instance_asset_bind(handle, ptr) {
      const dv = new DataView(buffer);
      bindings.push({
        handle,
        structSize: dv.getUint32(ptr + 0, true),
        slot: dv.getUint32(ptr + 4, true),
        format: dv.getUint32(ptr + 8, true),
        offset: dv.getUint32(ptr + 16, true),
        byteSize: dv.getUint32(ptr + 20, true),
        frames: dv.getUint32(ptr + 24, true),
        channels: dv.getUint32(ptr + 28, true),
        sampleRate: dv.getUint32(ptr + 32, true),
      });
      return 0;
    },
    _brk_instance_asset_unbind(handle, slot) { unbound.push({ handle, slot }); return 0; },
    _brk_instance_activate(handle) { activations.push({ handle, bindings: bindings.length }); return 0; },
    _brk_instance_deactivate() { return 0; },
    _brk_instance_reset() { return 0; },
    _brk_instance_destroy(handle) { liveHandles.delete(handle); return 0; },
    _brk_instance_state_read() { return 0; },
    _brk_instance_process(_handle, processPtr) {
      const dv = new DataView(buffer);
      const frames = dv.getUint32(processPtr + 4, true);
      const audioSpanPtr = dv.getUint32(processPtr + 8, true);
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

{
  const assetModule = fakeAssetModule();
  const assetEntry = {
    ...entry,
    moduleId: "design.myldy.asset-fixture",
    engineId: "asset-fixture",
    packageSha256: "c".repeat(64),
  };
  const assetManifest = {
    ...manifest,
    moduleId: assetEntry.moduleId,
    engineId: assetEntry.engineId,
    stateBytes: 184,
    runtime: {
      maxModuleInstances: 8,
      wasmInitialMemoryBytes: 16 * 1024 * 1024,
      wasmMaximumMemoryBytes: 16 * 1024 * 1024,
      memoryGrowth: false,
      assetExtensionVersion: 65536,
      assetArenaBytes: 8 * 1024 * 1024,
      assetSlots: 1,
    },
  };
  const assetFactory = abi.createPerformerFactory(
    { entry: assetEntry, manifest: assetManifest, module: assetModule },
    { maxBlockFrames: 16, maxEventsPerPerformer: 16 },
  );
  const pcmBytes = Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const assetRef = {
    schema: "brktrk-pcm-asset-ref-v1",
    format: "pcm-s16-interleaved",
    sha256: "d".repeat(64),
    sampleRateHz: 48000,
    channelCount: 1,
    frameCount: 4,
    byteSize: 8,
    sourceName: "fixture.wav",
  };
  const asset = { ref: assetRef, pcmBytes };

  const first = assetFactory({ track: 0, instrumentId: 1, sampleRate: 48000, assetRef, asset });
  assert.equal(assetModule.bindings.length, 1);
  assert.equal(assetModule.activations[0].bindings, 1, "Asset Extension bind must happen before instance activation");
  assert.deepEqual(assetModule.bindings[0], {
    handle: first.diagnostics().handle,
    structSize: 64,
    slot: 0,
    format: 1,
    offset: assetModule.arenaOffset,
    byteSize: 8,
    frames: 4,
    channels: 1,
    sampleRate: 48000,
  });
  assert.deepEqual([...assetModule.HEAPU8.slice(assetModule.arenaOffset, assetModule.arenaOffset + 8)], [...pcmBytes]);
  assert.equal(first.diagnostics().assetSha256, assetRef.sha256);
  assert.equal(first.diagnostics().assetBytes, 8);

  const second = assetFactory({ track: 0, instrumentId: 2, sampleRate: 48000, assetRef, asset });
  assert.equal(assetModule.bindings.length, 2);
  assert.equal(assetModule.bindings[1].offset, assetModule.bindings[0].offset, "same SHA must reuse one module arena span");
  assert.equal(assetFactory.diagnostics().assetSpanCount, 1);
  assert.equal(assetFactory.diagnostics().assetBytesStored, 8);
  assert.equal(assetFactory.diagnostics().assetArenaBytes, 8 * 1024 * 1024);

  assert.throws(
    () => assetFactory({ track: 0, instrumentId: 3, sampleRate: 48000, assetRef, asset: null }),
    (error) => error?.code === "asset-unavailable",
  );
  assert.equal(assetModule.liveHandles.size, 2, "failed asset prepare must destroy its physical module handle");

  first.destroy();
  second.destroy();
  assert.equal(assetModule.unbound.length, 2);
  assert.deepEqual(assetModule.unbound.map((row) => row.slot), [0, 0]);
}

console.log("M5A A3 generic BRK Synth ABI-v1 Worklet adapter + A5 explicit/legacy capacity passed");