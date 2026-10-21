const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");
require("./engine-registry-domain.js");
require("./performer-registry-domain.js");
require("./synth-gateway-domain.js");
const abi = require("./brk-synth-abi-v1-worklet.js");
const production = require("./production-audio-runtime.js");

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
abi.registerModuleRuntime({ entry, manifest, module: wasmModule });
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

const runtime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 2 });
runtime.configureInstruments({ 3: instrument });
assert.equal(runtime.diagnostics().traffic.instrumentSnapshotMessages, 1);
runtime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3, -1] }] });
assert.equal(runtime.hasProductionInstruments(), true);
assert.equal(runtime.hasPreparedPerformers(), true);

runtime.beginBlock(1000, 4);
const consumed = runtime.routeTracePacket({
  frame: 1000,
  events: [
    { frame: 1000, phase: 4, track: 0, sourceOrder: 0, ordinal: 17, kind: "note-trigger", source: "fixture", data: { instrumentId: 3, note: 60, velocity: 127 } },
    { frame: 1000, phase: 3, track: 0, sourceOrder: 0, ordinal: 18, kind: "parameter", source: "fixture", data: { instrumentId: 3, wave: 2, gain: 0.2, pan: 0 } },
  ],
});
assert.deepEqual([...consumed].sort((a, b) => a - b), [17, 18], "production note + legacy parameter ordinals must be removed from preview rendering");
const left = new Float32Array(4);
const right = new Float32Array(4);
runtime.renderInto(left, right, [{ gain: 1, pan: 0, mute: false }, { gain: 1, pan: 0, mute: false }]);
runtime.endBlock();
assert.ok(left.every((value) => value > 0));
assert.ok(right.every((value) => value > 0));
assert.ok(left[0] > right[0], "fake stereo engine output must retain channel identity through host Track mix");
assert.equal(runtime.diagnostics().preparedPairs, 1);
assert.equal(runtime.diagnostics().gateway.overrunCount, 0);

assert.equal(runtime.queueParameter({ instrumentId: 3, parameterId: "cutoff", value: 0.2, rampFrames: 192 }), true);
assert.equal(runtime.queueParameter({ instrumentId: 3, parameterId: "cutoff", value: 0.3, rampFrames: 192 }), true, "same Instrument/key updates must coalesce instead of growing the realtime queue");
assert.equal(runtime.diagnostics().pendingLiveParameters, 1);
runtime.beginBlock(1004, 4);
assert.equal(runtime.diagnostics().pendingLiveParameters, 0);
assert.equal(runtime.diagnostics().liveParameterUpdates, 2);
assert.equal(runtime.diagnostics().liveParameterCoalescedUpdates, 1);
assert.equal(runtime.diagnostics().liveParameterDeliveries, 1, "coalesced live value must fan out to the prepared Track×Instrument performer exactly once");
runtime.renderInto(new Float32Array(4), new Float32Array(4), [{ gain: 1, pan: 0, mute: false }, { gain: 1, pan: 0, mute: false }]);
runtime.endBlock();
let liveSlot = runtime.diagnostics().performers.activeSlots.find((slot) => slot.instrumentId === 3);
assert.equal(liveSlot.performer.parameterValues.cutoff, 0.3, "ABI diagnostics must expose the final value encoded for the performer");
assert.equal(liveSlot.performer.parameterEventsEncoded, 2, "initial snapshot plus one coalesced live value must reach the ABI");
assert.equal(liveSlot.performer.parameterRampEventsEncoded, 1);

for (let index = 0; index < 240; index += 1) {
  assert.equal(runtime.queueParameter({ instrumentId: 3, parameterId: "cutoff", value: index / 239, rampFrames: 192 }), true);
}
assert.equal(runtime.diagnostics().pendingLiveParameters, 1, "240 rapid updates for one stable key must remain one pending Worklet command");
assert.equal(runtime.diagnostics().liveParameterCoalescedUpdates, 240, "all but the first command in both bursts must be counted as coalesced");
runtime.beginBlock(1008, 4);
runtime.renderInto(new Float32Array(4), new Float32Array(4), [{ gain: 1, pan: 0, mute: false }, { gain: 1, pan: 0, mute: false }]);
runtime.endBlock();
liveSlot = runtime.diagnostics().performers.activeSlots.find((slot) => slot.instrumentId === 3);
assert.equal(runtime.diagnostics().liveParameterUpdates, 242);
assert.equal(runtime.diagnostics().liveParameterDeliveries, 2, "the second burst must add only one performer delivery");
assert.equal(liveSlot.performer.deferredParameterCount, 1, "an update arriving inside the prior persistent ABI ramp must wait instead of creating an invalid overlap");
let drainFrame = 1012;
for (let block = 0; block < 64 && liveSlot.performer.parameterValues.cutoff !== 1; block += 1) {
  runtime.beginBlock(drainFrame, 4);
  runtime.renderInto(new Float32Array(4), new Float32Array(4), [{ gain: 1, pan: 0, mute: false }, { gain: 1, pan: 0, mute: false }]);
  runtime.endBlock();
  drainFrame += 4;
  liveSlot = runtime.diagnostics().performers.activeSlots.find((slot) => slot.instrumentId === 3);
}
assert.equal(liveSlot.performer.parameterValues.cutoff, 1, "the final rapid-drag value must win at the ABI boundary");
assert.equal(liveSlot.performer.parameterEventsEncoded, 3);
assert.equal(liveSlot.performer.parameterRampEventsEncoded, 2);
runtime.stop();

const deferredSnapshotRuntime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1 });
deferredSnapshotRuntime.configureInstruments({ 3: instrument });
deferredSnapshotRuntime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3] }] });
assert.equal(deferredSnapshotRuntime.configureInstruments({
  3: { ...instrument, name: "Deferred structural successor", parameterSnapshot: { cutoff: 0.4 } },
}), false, "structural Instrument snapshots must defer while transport is active");
assert.equal(deferredSnapshotRuntime.diagnostics().pendingInstrumentSync, true);
assert.equal(deferredSnapshotRuntime.queueParameter({ instrumentId: 3, parameterId: "cutoff", value: 0.9, rampFrames: 192 }), true);
deferredSnapshotRuntime.stop();
assert.equal(deferredSnapshotRuntime.diagnostics().pendingInstrumentSync, false);
deferredSnapshotRuntime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3] }] });
const deferredSnapshotSlot = deferredSnapshotRuntime.diagnostics().performers.activeSlots.find((slot) => slot.instrumentId === 3);
assert.equal(deferredSnapshotSlot.performer.parameterValues.cutoff, 0.9, "live parameters must survive a deferred structural Instrument snapshot across stop/restart");
deferredSnapshotRuntime.stop();

const deferredCreationRuntime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1 });
deferredCreationRuntime.configureInstruments({ 3: instrument });
deferredCreationRuntime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3] }] });
const deferredInstrument = { ...instrument, id: 4, name: "New deferred Instrument", parameterSnapshot: { cutoff: 0.4 } };
assert.equal(deferredCreationRuntime.configureInstruments({ 3: instrument, 4: deferredInstrument }), false);
assert.equal(deferredCreationRuntime.queueParameter({ instrumentId: 4, parameterId: "cutoff", value: 0.85, rampFrames: 192 }), true, "a parameter edit for a newly deferred Instrument must update its pending snapshot");
deferredCreationRuntime.stop();
deferredCreationRuntime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [4] }] });
const deferredCreationSlot = deferredCreationRuntime.diagnostics().performers.activeSlots.find((slot) => slot.instrumentId === 4);
assert.equal(deferredCreationSlot.performer.parameterValues.cutoff, 0.85, "newly deferred Instrument parameters must survive stop/restart");
deferredCreationRuntime.stop();

const parameterMessageDiagnostics = [];
const messageRuntime = production.createProductionAudioRuntime({
  sampleRate: 48000,
  trackCount: 1,
  postMessage: (message) => parameterMessageDiagnostics.push(message),
});
messageRuntime.handleMessage({ type: "production-instruments", instruments: { 3: instrument } });
messageRuntime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3] }] });
const diagnosticCountBeforeParameter = parameterMessageDiagnostics.filter((message) => message.type === "production-diagnostics").length;
messageRuntime.handleMessage({ type: "production-parameter", instrumentId: 3, parameterId: "cutoff", value: 0.7, rampFrames: 192 });
assert.equal(parameterMessageDiagnostics.filter((message) => message.type === "production-diagnostics").length, diagnosticCountBeforeParameter, "parameter messages must not post a complete performer diagnostic graph per edit");
messageRuntime.handleMessage({ type: "production-diagnostics-request" });
assert.equal(parameterMessageDiagnostics.filter((message) => message.type === "production-diagnostics").length, diagnosticCountBeforeParameter + 1, "explicit diagnostics requests must retain detailed parameter evidence");
messageRuntime.stop();

const auditionMessages = [];
const auditionRuntime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 2, postMessage: (message) => auditionMessages.push(message) });
auditionRuntime.configureInstruments({ 3: instrument });
assert.equal(auditionRuntime.hasPreparedPerformers(), false, "audition must not create an eager performer before a request exists");
assert.equal(auditionRuntime.queueAudition({ track: 1, instrumentId: 3, note: 64, velocity: 111, durationFrames: 6 }), true);
assert.equal(auditionRuntime.diagnostics().audition.pending, 1);
assert.equal(auditionRuntime.hasPreparedPerformers(), true, "audition performer must be prepared on the control-plane request path before beginBlock");
assert.equal(auditionRuntime.diagnostics().performers.activePreparedCount, 1, "exactly one performer must exist before the realtime block begins");

auditionRuntime.beginBlock(2000, 4);
assert.equal(auditionRuntime.diagnostics().audition.pending, 0);
assert.equal(auditionRuntime.diagnostics().audition.active, 1);
assert.equal(auditionRuntime.diagnostics().audition.starts, 1);
assert.equal(auditionRuntime.diagnostics().preparedPairs, 1, "audition must use a real Track×Instrument performer");
const auditionLeft = new Float32Array(4);
const auditionRight = new Float32Array(4);
auditionRuntime.renderInto(auditionLeft, auditionRight, [{ gain: 1, pan: 0, mute: false }, { gain: 1, pan: 0, mute: false }]);
auditionRuntime.endBlock();
assert.ok(auditionLeft.some((value) => value > 0) && auditionRight.some((value) => value > 0), "production audition must render through the selected Track mix");

auditionRuntime.beginBlock(2004, 4);
assert.equal(auditionRuntime.diagnostics().audition.active, 0, "absolute release frame must deliver Note Off inside the following render block");
assert.equal(auditionRuntime.diagnostics().audition.completions, 1);
auditionRuntime.renderInto(new Float32Array(4), new Float32Array(4), [{ gain: 1, pan: 0, mute: false }, { gain: 1, pan: 0, mute: false }]);
auditionRuntime.endBlock();
assert.equal(auditionRuntime.hasPreparedPerformers(), false, "audition-only performer must be destroyed after the block that renders its Note Off");
assert.equal(auditionRuntime.diagnostics().performers.activePreparedCount, 0);
assert.equal(auditionRuntime.diagnostics().performers.destroyedCount, 1);
assert.ok(auditionMessages.some((message) => message.type === "production-audition" && message.state === "started"));
assert.ok(auditionMessages.some((message) => message.type === "production-audition" && message.state === "completed"));

auditionRuntime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [-1, 3] }] });
assert.equal(auditionRuntime.queueAudition({ track: 1, instrumentId: 3, note: 67, durationFrames: 128 }), false, "manual audition is deliberately stop-only while sequencer owns the same performer lifecycle");
assert.equal(auditionRuntime.diagnostics().audition.rejections, 1);
auditionRuntime.stop();

const capacityInstruments = {};
for (let id = 20; id < 32; id += 1) {
  capacityInstruments[id] = {
    ...instrument,
    id,
    name: `CAPACITY ${id}`,
  };
}
const capacityRuntime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1 });
capacityRuntime.configureInstruments(capacityInstruments);
let capacityFrame = 3000;
for (let id = 20; id < 32; id += 1) {
  assert.equal(capacityRuntime.queueAudition({ track: 0, instrumentId: id, note: 60 + (id % 12), durationFrames: 1 }), true, `audition ${id} must prepare outside render without exhausting module capacity`);
  assert.equal(capacityRuntime.diagnostics().performers.activePreparedCount, 1, "one audition-only performer may be live before its block");
  capacityRuntime.beginBlock(capacityFrame, 2);
  capacityRuntime.renderInto(new Float32Array(2), new Float32Array(2), [{ gain: 1, pan: 0, mute: false }]);
  capacityRuntime.endBlock();
  assert.equal(capacityRuntime.diagnostics().performers.activePreparedCount, 0, "completed audition performer must be reclaimed before the next distinct Instrument");
  assert.equal(capacityRuntime.diagnostics().audition.ownedPerformers, 0);
  capacityFrame += 2;
}
assert.equal(capacityRuntime.diagnostics().audition.starts, 12, "more sequential auditions than maxModuleInstances must remain available when completed slots are reclaimed");
assert.equal(capacityRuntime.diagnostics().audition.completions, 12);
assert.equal(capacityRuntime.diagnostics().performers.destroyedCount, 12);
capacityRuntime.stop();

const scaledInstruments = {};
for (let id = 40; id < 56; id += 1) scaledInstruments[id] = { ...instrument, id, name: `A5 ${id}` };
const scaledMessages = [];
const scaledRuntime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 8, postMessage: (message) => scaledMessages.push(message) });
scaledRuntime.configureInstruments(scaledInstruments);
const planForCount = (count) => ({
  mode: "sequence",
  steps: Array.from({ length: Math.ceil(count / 8) }, (_, row) => ({
    instrumentIds: Array.from({ length: 8 }, (_, track) => {
      const index = row * 8 + track;
      return index < count ? 40 + index : -1;
    }),
  })),
});

const capacityProfiles = [];
for (const count of [1, 8, 9, 16]) {
  const prepared = scaledRuntime.prepareProgram(planForCount(count));
  const snapshot = scaledRuntime.diagnostics();
  assert.equal(prepared.requiredPairs, count);
  assert.equal(snapshot.performers.activePreparedCount, count, `${count} independent performers must be active`);
  assert.equal(snapshot.program.capacityPlan[0].required, count);
  assert.equal(snapshot.program.capacityPlan[0].capacity, 16, "explicit package capability must override the legacy fallback of 8");
  assert.equal(snapshot.program.capacityPlan[0].capabilitySource, "runtime.maxModuleInstances");
  assert.equal(new Set(snapshot.performers.activeSlots.map((slot) => slot.performer.handle)).size, count, `${count} performers must own separate ABI instance handles`);
  assert.equal(snapshot.performers.activeSlots[0].performer.stagingBytes, 82384, "current per-performer ABI staging shape must remain explicit evidence");
  assert.equal(snapshot.performers.activeSlots[0].performer.wasmMemoryBytes, 4 * 1024 * 1024);
  capacityProfiles.push({ count, stagingBytesTotal: snapshot.performers.activeSlots.reduce((sum, slot) => sum + slot.performer.stagingBytes, 0) });
}
assert.deepEqual(capacityProfiles, [
  { count: 1, stagingBytesTotal: 82384 },
  { count: 8, stagingBytesTotal: 659072 },
  { count: 9, stagingBytesTotal: 741456 },
  { count: 16, stagingBytesTotal: 1318144 },
]);

const events16 = Array.from({ length: 16 }, (_, index) => ({
  frame: 4000,
  phase: 4,
  track: index % 8,
  sourceOrder: index,
  ordinal: 100 + index,
  kind: "note-trigger",
  source: "a5-capacity",
  data: { instrumentId: 40 + index, note: 48 + index, velocity: 100 },
}));
const processStart = wasmModule.processHandles.length;
scaledRuntime.beginBlock(4000, 4);
assert.equal(scaledRuntime.routeTracePacket({ frame: 4000, events: events16 }).size, 16);
scaledRuntime.renderInto(new Float32Array(4), new Float32Array(4), Array.from({ length: 8 }, () => ({ gain: 1, pan: 0, mute: false })));
scaledRuntime.endBlock();
assert.equal(new Set(wasmModule.processHandles.slice(processStart)).size, 16, "real host render path must call all 16 independent ABI handles");
assert.equal(scaledRuntime.diagnostics().gateway.droppedUnavailableEvents, 0);

scaledRuntime.prepareProgram(planForCount(1));
assert.equal(scaledRuntime.diagnostics().performers.activePreparedCount, 1, "obsolete transport performers must retire at the safe program boundary");
assert.equal(scaledRuntime.diagnostics().program.retirements, 15);
scaledRuntime.stop();
assert.equal(scaledRuntime.diagnostics().performers.activePreparedCount, 0, "transport stop must destroy the final program-owned performer");
assert.equal(scaledRuntime.diagnostics().program.ownedPerformers, 0);
assert.equal(scaledRuntime.diagnostics().program.retirements, 16);

const exhaustedInstruments = { ...scaledInstruments, 56: { ...instrument, id: 56, name: "A5 56" } };
const exhaustedRuntime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 8, postMessage: (message) => scaledMessages.push(message) });
exhaustedRuntime.configureInstruments(exhaustedInstruments);
assert.throws(() => exhaustedRuntime.prepareProgram(planForCount(17)), (error) => error?.code === "production-program-capacity" && error?.details?.required === 17 && error?.details?.capacity === 16);
assert.equal(exhaustedRuntime.diagnostics().performers.activePreparedCount, 0, "capacity preflight must reject atomically before creating any performer");
assert.ok(scaledMessages.some((message) => message.type === "production-engine-error" && message.code === "production-program-capacity"), "capacity exhaustion must emit an explicit host diagnostic");

const lateEntry = {
  ...entry,
  engineId: "late-runtime-fixture",
  packageUrl: "fixture://late-runtime-fixture",
  packageSha256: "d".repeat(64),
};
const lateManifest = {
  ...manifest,
  engineId: lateEntry.engineId,
  contentSha256: "e".repeat(64),
};
const lateInstrument = {
  ...instrument,
  id: 70,
  engineRef: { moduleId: lateEntry.moduleId, engineId: lateEntry.engineId, resolvedVersion: lateEntry.version },
};
const lateRuntime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1 });
lateRuntime.configureInstruments({ 70: lateInstrument });
abi.registerModuleRuntime({ entry: lateEntry, manifest: lateManifest, module: fakeModule() });
assert.doesNotThrow(
  () => lateRuntime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [70] }] }),
  "late module registration must refresh the generic EngineRegistry before program preparation",
);
assert.equal(lateRuntime.diagnostics().performers.activePreparedCount, 1);
assert.equal(lateRuntime.diagnostics().program.capacityPlan[0].capacity, 16);
lateRuntime.stop();

const teardownMessages = [];
const teardownRuntime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1, postMessage: (message) => teardownMessages.push(message) });
teardownRuntime.configureInstruments({ 3: instrument });
teardownRuntime.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3] }] });
wasmModule.failNextDestroy();
assert.doesNotThrow(() => teardownRuntime.stop(), "engine destroy failure must not strand transport teardown");
const teardownSnapshot = teardownRuntime.diagnostics();
assert.equal(teardownSnapshot.transportActive, false);
assert.equal(teardownSnapshot.performers.activePreparedCount, 0, "failed physical destroy must still retire the unusable registry slot");
assert.equal(teardownSnapshot.program.ownedPerformers, 0, "failed physical destroy must not retain a stale program-owned pair");
assert.equal(teardownSnapshot.program.retirementFailures, 1);
assert.ok(teardownMessages.some((message) => message.type === "production-engine-error" && message.code === "abi-call-failed"), "destroy failure must remain explicit in diagnostics");


{
  const insertMessages = [];
  const makeRuntime = (gain, enabled = true) => {
    const instance = production.createProductionAudioRuntime({
      sampleRate: 48000,
      trackCount: 1,
      postMessage: (message) => insertMessages.push(message),
    });
    instance.configureInstruments({ 3: instrument });
    if (enabled) {
      instance.handleMessage({
        type: "track-insert-fx",
        revision: 7,
        tracks: [[
          { module: "saturation", bypass: false, values: [255, 255, 128, 255] },
          { module: "off" },
        ]],
      });
    }
    instance.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3] }] });
    instance.beginBlock(9000, 128);
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    instance.renderInto(left, right, [{ gain, pan: 0, mute: false }]);
    instance.endBlock();
    return { instance, left, right };
  };

  const full = makeRuntime(1);
  const half = makeRuntime(0.5);
  const off = makeRuntime(1, false);
  assert.ok(insertMessages.some((message) => message.type === "track-insert-fx-applied" && message.revision === 7),
    "Worklet runtime must acknowledge the exact Track Insert FX revision");
  assert.equal(full.instance.diagnostics().trackInsertFx.activeSlots, 1);
  assert.equal(full.instance.diagnostics().trackInsertFx.tracks[0].slots[0].configuredModule, "saturation");
  assert.notDeepEqual([...full.left], [...off.left], "insert DSP must alter the per-track signal before summing");

  for (let frame = 0; frame < 128; frame += 1) {
    assert.ok(Math.abs(half.left[frame] - full.left[frame] * 0.5) < 1e-6,
      "Track gain must scale already-processed insert FX output");
    assert.ok(Math.abs(half.right[frame] - full.right[frame] * 0.5) < 1e-6,
      "Track gain must remain after insert FX on both channels");
  }

  const muted = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1 });
  muted.configureInstruments({ 3: instrument });
  muted.configureTrackInsertFx([[
    { module: "bitcrusher", values: [0, 31, 255, 255] },
    { module: "phaser" },
  ]]);
  muted.prepareProgram({ mode: "sequence", steps: [{ instrumentIds: [3] }] });
  muted.beginBlock(9200, 128);
  const mutedLeft = new Float32Array(128);
  const mutedRight = new Float32Array(128);
  muted.renderInto(mutedLeft, mutedRight, [{ gain: 1, pan: 0, mute: true }]);
  muted.endBlock();
  assert.ok(mutedLeft.every((value) => value === 0) && mutedRight.every((value) => value === 0),
    "Track mute must remain downstream of both insert slots");
}
console.log("M5A A3/A4A production K4 + A4B2 audition + A5 1/8/9/16 capacity/lifecycle passed");
require("./production-audio-processor-extension.test.cjs");
