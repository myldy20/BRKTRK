const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const timingDomain = require("./timing-domain.js");
const noteLifecycleDomain = require("./note-lifecycle-domain.js");
require("./phrase-fx-domain.js");
require("./phrase-fx-runtime-domain.js");
const eventTraceDomain = require("./event-trace-domain.js");
const productionTimelineDomain = require("./production-timeline-domain.js");
const templateDomain = require("./production-timeline-template.js");
const executionDomain = require("./production-execution-template.js");
const queueDomain = require("./realtime-execution-queue.js");
const realtimeEventWindowDomain = require("./realtime-event-window-domain.js");

const r1Source = readFileSync(require.resolve("./production-prepared-timeline-processor-extension.js"), "utf8");
const r2Source = readFileSync(require.resolve("./production-prepared-execution-processor-extension.js"), "utf8");
const runtimeSource = readFileSync(require.resolve("./audio-worklet-runtime.js"), "utf8");

const SAMPLE_RATE = 48000;
const TEMPO = 120;
const TRACKS = 8;
const ROWS = 16;
const CYCLE_FRAMES = 24000;
const CYCLES = 64;
const WARMUP_CYCLES = 8;
const STRESS_END = CYCLE_FRAMES * CYCLES;
const WARMUP_END = CYCLE_FRAMES * WARMUP_CYCLES;
const QUANTA = Object.freeze([1, 17, 63, 127, 128, 31, 97]);

const fx = (...entries) => entries.map(([command, value]) => ({ command, value }));
const rowFx = [
  fx([0x04, 0x01], [0x01, 0x01], [0x05, 0x20]),
  fx([0x01, 0x01], [0x05, 0x20]),
  [],
  fx([0x01, 0x02], [0x05, 0x30], [0xa7, 0x22]),
];

function sequenceStep(row) {
  const lane = row % 4;
  return {
    notes: Array.from({ length: TRACKS }, (_, track) => {
      if (lane === 2) return -2;
      if (lane === 1) return 60 + ((row + track) % 12);
      if (lane === 3) return 72 + ((row + track) % 12);
      return 48 + ((row + track) % 12);
    }),
    velocities: Array.from({ length: TRACKS }, (_, track) => 80 + ((row * 7 + track * 5) % 47)),
    instrumentIds: Array(TRACKS).fill(0),
    waves: Array(TRACKS).fill(0),
    gains: Array(TRACKS).fill(0.1),
    pans: Array(TRACKS).fill(0),
    mutes: Array(TRACKS).fill(false),
    fx: Array.from({ length: TRACKS }, () => rowFx[lane]),
  };
}

const program = Object.freeze({
  mode: "sequence",
  steps: Object.freeze(Array.from({ length: ROWS }, (_, row) => sequenceStep(row))),
  contexts: Object.freeze(Array.from({ length: ROWS }, (_, phraseRow) => Object.freeze({ phraseRow }))),
});

const denseRowFrames = [];
for (let cycle = 0; cycle < CYCLES; cycle += 1) {
  for (let group = 0; group < 4; group += 1) denseRowFrames.push(cycle * CYCLE_FRAMES + group * 6000);
}
const triggerOffsets = Object.freeze(denseRowFrames.flatMap((frame) => [frame, frame]));
const cursorRows = Object.freeze(Array.from({ length: 16 }, (_, row) => row));
const triggerColumn = () => ({
  tic: "00",
  cursorRows,
  initialCursor: 0,
  emissionPolicy: "emit-then-advance",
  triggerOffsets,
});
const tableSources = Object.freeze(Array.from({ length: TRACKS }, (_, track) => Object.freeze({
  track,
  sourceKind: "instrument",
  sourceId: track,
  table: track,
  instance: 0,
  sourceOrder: track,
  startOffsetFrames: 0,
  endOffsetFrames: STRESS_END,
  columns: Object.freeze({
    noteVolume: triggerColumn(),
    fx1: triggerColumn(),
    fx2: triggerColumn(),
    fx3: triggerColumn(),
  }),
})));

const request = productionTimelineDomain.createTimelineRequest(program, {
  version: 1,
  mode: "sequence",
  diagnostics: false,
  sequence: { groove: { ppqn: 24, rows: [0, 0, 0, 6, 0, 0, 0, 6, 0, 0, 0, 6, 0, 0, 0, 6] } },
  tableSources,
});
const compiled = productionTimelineDomain.compileProductionTimeline({
  sampleRate: SAMPLE_RATE,
  startFrame: 0,
  tempo: TEMPO,
  program,
  request,
});
assert.equal(compiled.sequence.cycleFrames, CYCLE_FRAMES);
const relative = templateDomain.compileRelativeTimeline({ sampleRate: SAMPLE_RATE, tempo: TEMPO, program, request });
const execution = executionDomain.compilePreparedExecution({ timelineTemplate: relative, program });
executionDomain.validatePreparedExecution(execution, { timelineTemplate: relative, mode: "sequence", program });

const offline = eventTraceDomain.compileOfflineEventTrace({
  timeline: compiled,
  program,
  endFrame: STRESS_END - 1,
  maxPackets: 65536,
});
const expectedDemand = offline.packets.map((packet) => [packet.frame, packet.events.length]);
const maxSameFrameDemand = Math.max(...expectedDemand.map(([, count]) => count));
assert.ok(maxSameFrameDemand >= 100, `R3 fixture must remain dense enough to stress same-frame accounting, got ${maxSameFrameDemand}`);
assert.ok(offline.packets.length > 1000, "R3 fixture must remain long-running rather than a one-cycle parity check");

const KIND_BY_NAME = new Map([
  ["note-release", executionDomain.KIND.NOTE_RELEASE],
  ["parameter", executionDomain.KIND.PARAMETER],
  ["note-trigger", executionDomain.KIND.NOTE_TRIGGER],
  ["fx-inert", executionDomain.KIND.FX_INERT],
  ["observe-row", executionDomain.KIND.OBSERVE_ROW],
]);
const expectedExecution = offline.events
  .filter((event) => KIND_BY_NAME.has(event.kind))
  .map((event) => ({
    frame: event.frame,
    phase: event.phase,
    track: event.track,
    sourceOrder: event.sourceOrder,
    kind: KIND_BY_NAME.get(event.kind),
    instrumentId: Number.isInteger(Number(event.data?.instrumentId)) && Number(event.data.instrumentId) >= 0 && Number(event.data.instrumentId) <= 255
      ? Number(event.data.instrumentId)
      : -1,
    note: Number.isFinite(Number(event.data?.note)) ? Number(event.data.note) : -1,
    velocity: Number.isFinite(Number(event.data?.velocity)) ? Number(event.data.velocity) : 100,
    fxLane: Number.isInteger(Number(event.data?.fxLane)) ? Number(event.data.fxLane) : -1,
    retrigger: event.data?.retrigger === true,
    resetsPhase: event.data?.resetsPhase === true,
  }));
assert.ok(expectedExecution.length > 10000, "R3 compact execution parity must cover a substantial repeated event stream");

let poisonCompile = 0;
let poisonBuild = 0;
let poisonTake = 0;
let poisonEnqueue = 0;
const poisonedTimelineDomain = Object.freeze({
  ...productionTimelineDomain,
  compileProductionTimeline() {
    poisonCompile += 1;
    throw new Error("POISON: full production timeline compiler reached R3 Worklet path");
  },
});
const poisonedTraceDomain = Object.freeze({
  ...eventTraceDomain,
  buildFramePacket() { poisonBuild += 1; throw new Error("POISON: buildFramePacket reached R3 Worklet path"); },
  takeScheduledEvents() { poisonTake += 1; throw new Error("POISON: takeScheduledEvents reached R3 Worklet path"); },
  enqueueScheduledEvents() { poisonEnqueue += 1; throw new Error("POISON: enqueueScheduledEvents reached R3 Worklet path"); },
});
const workletTemplateDomain = Object.freeze({
  ...templateDomain,
  bindRelativeTimeline(template, startFrame, position = null) {
    const transferredPosition = position === null ? null : JSON.parse(JSON.stringify(position));
    return templateDomain.bindRelativeTimeline(template, startFrame, transferredPosition);
  },
});

let Processor = null;
class AudioWorkletProcessorStub {
  constructor() {
    const stats = {
      total: 0,
      stepCount: 0,
      meterCount: 0,
      firstStepSource: null,
      lastStep: null,
      errors: [],
    };
    const port = {
      onmessage: null,
      stats,
      postMessage(message) {
        stats.total += 1;
        if (message?.type === "step") {
          if (stats.firstStepSource === null) stats.firstStepSource = message;
          else assert.strictEqual(message, stats.firstStepSource, "R3 Worklet must reuse one step source object throughout steady-state playback");
          stats.stepCount += 1;
          stats.lastStep = structuredClone(message);
        } else if (message?.type === "meter") stats.meterCount += 1;
        else if (String(message?.type ?? "").includes("error") || message?.type === "production-transport-rejected") {
          stats.errors.push(structuredClone(message));
        }
      },
    };
    this.port = port;
  }
}

const sandbox = {
  BRKTRKTimingDomain: timingDomain,
  BRKTRKNoteLifecycleDomain: noteLifecycleDomain,
  BRKTRKProductionTimelineDomain: poisonedTimelineDomain,
  BRKTRKProductionTimelineTemplate: workletTemplateDomain,
  BRKTRKProductionExecutionTemplate: executionDomain,
  BRKTRKRealtimeExecutionQueue: queueDomain,
  BRKTRKEventTraceDomain: poisonedTraceDomain,
  BRKTRKRealtimeEventWindowDomain: realtimeEventWindowDomain,
  BRKTRKProductionAudioProcessorExtension: Object.freeze({ extendProcessor: (BaseProcessor) => BaseProcessor }),
  AudioWorkletProcessor: AudioWorkletProcessorStub,
  registerProcessor(name, candidate) { assert.equal(name, "brktrk-audio"); Processor = candidate; },
  sampleRate: SAMPLE_RATE,
  currentFrame: 0,
  console,
  Math,
  Array,
  Number,
  Object,
  Set,
  Map,
  Float32Array,
  Float64Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int16Array,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(r1Source, sandbox, { filename: "production-prepared-timeline-processor-extension.js" });
vm.runInNewContext(r2Source, sandbox, { filename: "production-prepared-execution-processor-extension.js" });
vm.runInNewContext(runtimeSource, sandbox, { filename: "audio-worklet-runtime.js" });
assert.ok(Processor, "R3 stress must execute the registered R1+R2 composite Worklet processor");

const processor = new Processor();
processor.port.onmessage({ data: {
  type: "play",
  sequence: program.steps,
  tempo: TEMPO,
  transport: { id: "k3-r3-stress", version: 1, mode: "sequence", scope: "song" },
  timeline: request,
  timelineTemplate: relative,
  executionTemplate: execution,
} });
assert.equal(processor.playing, true);
assert.equal(processor.timelineDiagnostics, false);
processor.realtimeWindow.push = () => { throw new Error("POISON: object K4B packet push reached R3 Worklet path"); };
processor.timelineRowEvents = () => { throw new Error("POISON: row object materialization reached R3 Worklet path"); };

const actualDemand = [];
const originalReserve = processor.realtimeWindow.reserveFrame.bind(processor.realtimeWindow);
processor.realtimeWindow.reserveFrame = (frame, count) => {
  actualDemand.push([frame, count]);
  return originalReserve(frame, count);
};
const actualExecution = [];
const originalApply = processor.applyPreparedExecutionEvent.bind(processor);
processor.applyPreparedExecutionEvent = (frame, phase, track, sourceOrder, kind, instrumentId, note, velocity, fxLane, retrigger, resetsPhase) => {
  actualExecution.push({ frame, phase, track, sourceOrder, kind, instrumentId, note, velocity, fxLane, retrigger, resetsPhase });
  return originalApply(frame, phase, track, sourceOrder, kind, instrumentId, note, velocity, fxLane, retrigger, resetsPhase);
};

const outputCache = new Map();
function outputFor(length) {
  if (!outputCache.has(length)) outputCache.set(length, [new Float32Array(length), new Float32Array(length)]);
  return outputCache.get(length);
}
function runRange(startFrame, endFrame, quantumIndex = 0) {
  let frame = startFrame;
  let index = quantumIndex;
  while (frame < endFrame) {
    const length = Math.min(QUANTA[index % QUANTA.length], endFrame - frame);
    sandbox.currentFrame = frame;
    processor.process([], [outputFor(length)]);
    frame += length;
    index += 1;
  }
  return index;
}

let quantumIndex = runRange(0, WARMUP_END, 0);
const stableIdentity = {
  executionQueue: processor.executionQueue,
  timelineRows: processor.timelineRows,
  timelineRow0: processor.timelineRows[0],
  timelineRowLast: processor.timelineRows.at(-1),
  timelineSequenceCursor: processor.timelineSequenceCursor,
  realtimeWindow: processor.realtimeWindow,
  stepMessage: processor.r2StepMessage,
  executionTemplate: processor.preparedExecutionTemplate,
  executionRows: processor.preparedExecutionSequenceRows,
  timelineCompiled: processor.timelineCompiled,
};
const warmQueue = processor.executionQueue.diagnostics();
const warmWindow = processor.realtimeWindow.diagnosticSnapshot();
assert.ok(warmQueue.highWater > 0);
assert.ok(warmWindow.highWaterEvents >= maxSameFrameDemand);

quantumIndex = runRange(WARMUP_END, STRESS_END, quantumIndex);
assert.ok(quantumIndex > 10000, "R3 stress must span many actual render quanta");

assert.strictEqual(processor.executionQueue, stableIdentity.executionQueue);
assert.strictEqual(processor.timelineRows, stableIdentity.timelineRows);
assert.strictEqual(processor.timelineRows[0], stableIdentity.timelineRow0);
assert.strictEqual(processor.timelineRows.at(-1), stableIdentity.timelineRowLast);
assert.strictEqual(processor.timelineSequenceCursor, stableIdentity.timelineSequenceCursor);
assert.strictEqual(processor.realtimeWindow, stableIdentity.realtimeWindow);
assert.strictEqual(processor.r2StepMessage, stableIdentity.stepMessage);
assert.strictEqual(processor.preparedExecutionTemplate, stableIdentity.executionTemplate);
assert.strictEqual(processor.preparedExecutionSequenceRows, stableIdentity.executionRows);
assert.strictEqual(processor.timelineCompiled, stableIdentity.timelineCompiled);

const finalQueue = processor.executionQueue.diagnostics();
const finalWindow = processor.realtimeWindow.diagnosticSnapshot();
assert.equal(finalQueue.capacity, warmQueue.capacity);
assert.equal(finalQueue.highWater, warmQueue.highWater, "repeating steady-state workload must not grow typed execution demand after warmup");
assert.equal(finalQueue.overrunCount, 0);
assert.equal(finalWindow.highWaterPackets, warmWindow.highWaterPackets, "render-window packet high-water must stabilize during warmup");
assert.equal(finalWindow.highWaterEvents, warmWindow.highWaterEvents, "render-window event high-water must stabilize during warmup");
assert.equal(finalWindow.overrunCount, 0);
assert.equal(finalWindow.lateEventCount, 0);
assert.equal(finalWindow.underrunCount, 0);
assert.equal(finalWindow.renderOverlapCount, 0);
assert.equal(processor.port.stats.errors.length, 0, JSON.stringify(processor.port.stats.errors));
assert.equal(poisonCompile, 0);
assert.equal(poisonBuild, 0);
assert.equal(poisonTake, 0);
assert.equal(poisonEnqueue, 0);

assert.deepEqual(actualDemand, expectedDemand, "R3 realtime K4B frame/event demand must match the complete long-running offline reference including dense Table events");
assert.deepEqual(actualExecution, expectedExecution, "R3 prepared realtime execution must remain event-for-event equal to the long-running K4 reference trace");
assert.equal(processor.port.stats.stepCount, denseRowFrames.length, "same-frame source rows must collapse only at the transport-observability boundary, not in K4 execution parity");
assert.equal(processor.port.stats.lastStep.frame, STRESS_END - 6000, "last repeated source-row frame must remain exact");
assert.equal(processor.timelineGeneration, 1, "steady-state R3 stress must not hide a timeline rebuild/recompile");

console.log(`K3 R3 long-running realtime/reference + dense FX/Table + variable-quantum + stable-high-water stress passed: ${STRESS_END} frames, ${offline.packets.length} packets, ${expectedExecution.length} compact events, maxSameFrame=${maxSameFrameDemand}`);
