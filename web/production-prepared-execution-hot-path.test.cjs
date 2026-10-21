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

for (const forbidden of ["buildFramePacket(", "takeScheduledEvents(", "enqueueScheduledEvents(", "routeTracePacket("]) {
  assert.equal(r2Source.includes(forbidden), false, `R2 prepared Worklet extension must not call ${forbidden}`);
}
for (const forbidden of ["const trackEvents = []", "const sequenceEvents = []", "trackEvents.push(", "sequenceEvents.push(", "[...this.timelineTrackPositions]"]) {
  assert.equal(r2Source.includes(forbidden), false, `R2 non-diagnostic step path must not allocate ${forbidden}`);
}
assert.match(r2Source, /routePreparedLifecycle\(/, "R2 production lifecycle must use the primitive lower-layer route");
assert.match(r2Source, /r2StepMessage/, "R2 step observability must reuse a preallocated MessagePort source object");

const slot = (command, value) => ({ command, value });
const step = (note = null, fx = []) => ({
  notes: Array.from({ length: 8 }, (_, track) => track === 0 ? note : null),
  velocities: Array(8).fill(100),
  instrumentIds: Array(8).fill(0),
  fx: Array.from({ length: 8 }, (_, track) => track === 0 ? fx : []),
});
const program = {
  mode: "sequence",
  steps: [
    step(60, [slot("delay", 2), slot("cut", 2)]),
    step(null),
    step(64, [slot("retrigger", 0x20)]),
    step(-2),
  ],
  contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })),
};
const request = productionTimelineDomain.createTimelineRequest(program);
const relative = templateDomain.compileRelativeTimeline({ sampleRate: 48000, tempo: 120, program, request });
const execution = executionDomain.compilePreparedExecution({ timelineTemplate: relative, program });

let poisonBuild = 0;
let poisonTake = 0;
let poisonEnqueue = 0;
const poisonedTraceDomain = Object.freeze({
  ...eventTraceDomain,
  buildFramePacket() { poisonBuild += 1; throw new Error("POISON: buildFramePacket reached R2 hot path"); },
  takeScheduledEvents() { poisonTake += 1; throw new Error("POISON: takeScheduledEvents reached R2 hot path"); },
  enqueueScheduledEvents() { poisonEnqueue += 1; throw new Error("POISON: enqueueScheduledEvents reached R2 hot path"); },
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
    const messages = [];
    this.port = { onmessage: null, messages, postMessage(message) { messages.push(structuredClone(message)); } };
  }
}
const sandbox = {
  BRKTRKTimingDomain: timingDomain,
  BRKTRKNoteLifecycleDomain: noteLifecycleDomain,
  BRKTRKProductionTimelineDomain: productionTimelineDomain,
  BRKTRKProductionTimelineTemplate: workletTemplateDomain,
  BRKTRKProductionExecutionTemplate: executionDomain,
  BRKTRKRealtimeExecutionQueue: queueDomain,
  BRKTRKEventTraceDomain: poisonedTraceDomain,
  BRKTRKRealtimeEventWindowDomain: realtimeEventWindowDomain,
  BRKTRKProductionAudioProcessorExtension: Object.freeze({ extendProcessor: (BaseProcessor) => BaseProcessor }),
  AudioWorkletProcessor: AudioWorkletProcessorStub,
  registerProcessor(name, candidate) { assert.equal(name, "brktrk-audio"); Processor = candidate; },
  sampleRate: 48000,
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
assert.ok(Processor, "R2 composed processor must register");

const identity = { id: "r2-hot", version: 1, mode: "sequence", scope: "phrase" };
const play = (processor, id = identity) => processor.port.onmessage({ data: {
  type: "play",
  sequence: program.steps,
  tempo: 120,
  transport: id,
  timeline: request,
  timelineTemplate: relative,
  executionTemplate: execution,
} });
const renderAt = (processor, frame, length = 1) => {
  sandbox.currentFrame = frame;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  processor.process([], [[left, right]]);
};

const processor = new Processor();
play(processor);
assert.equal(processor.playing, true);
assert.equal(processor.timelineDiagnostics, false, "ordinary Transport preparation must remain non-diagnostic by default");

let snapshotCalls = 0;
let rowMaterializationCalls = 0;
const originalSnapshot = processor.timelineProgramSnapshot.bind(processor);
processor.timelineProgramSnapshot = () => { snapshotCalls += 1; return originalSnapshot(); };
processor.timelineRowEvents = () => { rowMaterializationCalls += 1; throw new Error("POISON: timelineRowEvents reached R2 hot path"); };
processor.realtimeWindow.push = () => { throw new Error("POISON: object K4B push reached R2 hot path"); };

renderAt(processor, 0);
assert.equal(processor.voices[0].active, false, "DLY must defer Note On beyond the source row frame");
assert.equal(processor.timelineNextFrame, 2000, "prepared delayed lifecycle must become the next authoritative due frame");
renderAt(processor, 2000);
assert.equal(processor.voices[0].active, true);
assert.equal(processor.voices[0].note, 60);
renderAt(processor, 4000);
assert.equal(processor.voices[0].active, false, "CUT must release through the prepared execution heap");
renderAt(processor, 6000);
renderAt(processor, 12000);
assert.equal(processor.voices[0].note, 64);
assert.equal(processor.voices[0].active, true);
renderAt(processor, 14000);
assert.equal(processor.voices[0].note, 64, "RET must preserve the active note through prepared retrigger delivery");

assert.equal(poisonBuild, 0);
assert.equal(poisonTake, 0);
assert.equal(poisonEnqueue, 0);
assert.equal(snapshotCalls, 0, "steady-state R2 render must not materialize a program snapshot");
assert.equal(rowMaterializationCalls, 0, "steady-state R2 render must not materialize row event objects");
assert.equal(processor.timelinePendingEvents.length, 0, "legacy scheduled-event array must stay empty on the prepared path");
assert.ok(processor.executionQueue.diagnostics().highWater > 0, "prepared heap must carry delayed K4 events");
assert.equal(processor.realtimeWindow.diagnosticSnapshot().eventCount > 0, true, "primitive K4B budget accounting must remain active");

const steps = processor.port.messages.filter((message) => message.type === "step");
assert.deepEqual(steps.map((message) => message.frame), [0, 6000, 12000], "source-row step protocol must remain on exact bound row frames");
assert.ok(steps.every((message) => message.trackSteps === null), "sequence step observability must not materialize row-detail arrays");

const routed = [];
const productionProcessor = new Processor();
productionProcessor.productionAudio = {
  hasInstrument(instrumentId) { return instrumentId === 0; },
  routeTracePacket() { throw new Error("POISON: production trace packet routing reached R2 prepared path"); },
  routePreparedLifecycle(frame, track, instrumentId, type, note, velocity) {
    routed.push([frame, track, instrumentId, type, note, velocity]);
    return true;
  },
};
play(productionProcessor, { id: "r2-production-hot", version: 2, mode: "sequence", scope: "phrase" });
for (const frame of [0, 2000, 4000, 6000, 12000, 14000]) renderAt(productionProcessor, frame);
assert.deepEqual(routed, [
  [2000, 0, 0, "note-on", 60, 100],
  [4000, 0, 0, "note-off", 60, 100],
  [12000, 0, 0, "note-on", 64, 100],
  [14000, 0, 0, "retrigger", 64, 100],
], "production NOTE_ON/OFF/RET must route as primitives at exact prepared frames");
assert.equal(productionProcessor.voices[0].active, false, "package-backed lifecycle must not also hit the fallback voice");

console.log("K3 R2 registered Worklet allocation-hardened step + primitive production hot-path poison + DEL/CUT/RET tests passed");
