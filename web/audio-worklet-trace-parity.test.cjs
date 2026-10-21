const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const timingDomain = require("./timing-domain.js");
const noteLifecycleDomain = require("./note-lifecycle-domain.js");
const productionTimelineDomain = require("./production-timeline-domain.js");
const eventTraceDomain = require("./event-trace-domain.js");
const realtimeEventWindowDomain = require("./realtime-event-window-domain.js");

let Processor = null;
class AudioWorkletProcessorStub {
  constructor() {
    const messages = [];
    this.port = { onmessage: null, messages, postMessage(message) { messages.push(message); } };
  }
}
const sandbox = {
  BRKTRKTimingDomain: timingDomain,
  BRKTRKNoteLifecycleDomain: noteLifecycleDomain,
  BRKTRKProductionTimelineDomain: productionTimelineDomain,
  BRKTRKEventTraceDomain: eventTraceDomain,
  BRKTRKRealtimeEventWindowDomain: realtimeEventWindowDomain,
  AudioWorkletProcessor: AudioWorkletProcessorStub,
  registerProcessor(name, candidate) { assert.equal(name, "brktrk-audio"); Processor = candidate; },
  sampleRate: 48000,
  currentFrame: 0,
  console,
  Math,
  Array,
  Number,
  Object,
  Symbol,
};
vm.runInNewContext(readFileSync(require.resolve("./audio-worklet-runtime.js"), "utf8"), sandbox);
assert.ok(Processor);

const emptyFx = () => [{ command: 0, value: 0 }, { command: 0, value: 0 }, { command: 0, value: 0 }];
const step = (note, trackFx = emptyFx()) => ({
  notes: [note, null, null, null, null, null, null, null],
  waves: Array(8).fill(0),
  gains: Array(8).fill(0.1),
  pans: Array(8).fill(0),
  mutes: Array(8).fill(false),
  fx: [trackFx, emptyFx(), emptyFx(), emptyFx(), emptyFx(), emptyFx(), emptyFx(), emptyFx()],
});
const program = {
  mode: "sequence",
  steps: [
    step(60, [{ command: 0x05, value: 0x20 }, { command: 0, value: 0 }, { command: 0, value: 0 }]),
    step(-2),
    step(64),
  ],
};
const request = productionTimelineDomain.createTimelineRequest(program, {
  version: 1,
  mode: "sequence",
  diagnostics: true,
  sequence: { groove: { ppqn: 24, rows: [6, 0, 6] } },
});
const timeline = productionTimelineDomain.compileProductionTimeline({
  sampleRate: 48000,
  startFrame: 0,
  tempo: 120,
  program,
  request,
});
const offline = eventTraceDomain.compileOfflineEventTrace({ timeline, program, endFrame: 12000 });
assert.ok(offline.packets.some((packet) => packet.frame === 2000), "single RET must create a host-scheduled packet between tracker rows");
const offlineRetrigger = offline.events.find((event) => event.kind === "note-trigger" && event.data?.fx === "retrigger");
assert.equal(offlineRetrigger?.frame, 2000);
assert.equal(offlineRetrigger?.data.resetsPhase, true);

const processor = new Processor();
processor.startSequence(program.steps, 120, { id: "k4a", version: 22, mode: "sequence", scope: "phrase" }, request);
processor.armStepSchedule(0);
for (const packet of offline.packets) processor.processTimelineUntil(packet.frame);
const realtime = processor.port.messages.filter((message) => message.type === "timeline-frame");
assert.equal(realtime.length, offline.packets.length);
for (let index = 0; index < offline.packets.length; index += 1) {
  assert.equal(realtime[index].frame, offline.packets[index].frame);
  assert.equal(realtime[index].traceVersion, eventTraceDomain.TRACE_VERSION);
  assert.deepEqual(
    JSON.parse(JSON.stringify(realtime[index].traceEvents)),
    JSON.parse(JSON.stringify(offline.packets[index].events)),
  );
}
const realtimeRetrigger = realtime.flatMap((packet) => packet.traceEvents)
  .find((event) => event.kind === "note-trigger" && event.data?.fx === "retrigger");
assert.equal(realtimeRetrigger?.frame, 2000, "AudioWorklet must consume the same host-scheduled RET frame as offline trace");
assert.equal(realtimeRetrigger?.data.resetsPhase, true, "AudioWorklet trace must preserve explicit RET phase-reset intent");

const applied = processor.port.messages.find((message) => message.type === "event-trace-applied");
assert.equal(applied.trace.version, eventTraceDomain.TRACE_VERSION);
assert.equal(applied.trace.runtimeVersion, 3);
assert.equal(applied.trace.windowVersion, realtimeEventWindowDomain.WINDOW_VERSION);
assert.equal(processor.lastEventTracePacket.version, eventTraceDomain.TRACE_VERSION);
console.log("K4A direct AudioWorklet/offline trace parity tests passed through K4B and M4.1C scheduled FX delivery");
