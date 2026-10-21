const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const timingDomain = require("./timing-domain.js");
const noteLifecycleDomain = require("./note-lifecycle-domain.js");
const productionTimelineDomain = require("./production-timeline-domain.js");
const eventTraceDomain = require("./event-trace-domain.js");
const realtimeEventWindowDomain = require("./realtime-event-window-domain.js");

function loadProcessor() {
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
    Float32Array,
  };
  vm.runInNewContext(readFileSync(require.resolve("./audio-worklet-runtime.js"), "utf8"), sandbox);
  assert.ok(Processor);
  return { Processor, sandbox };
}

function step(note = 60) {
  return {
    notes: [note, null, null, null, null, null, null, null],
    waves: Array(8).fill(0),
    gains: Array(8).fill(0.1),
    pans: Array(8).fill(0),
    mutes: Array(8).fill(false),
  };
}

function requestFor(program, rows = [6]) {
  return productionTimelineDomain.createTimelineRequest(program, {
    version: 1,
    mode: "sequence",
    diagnostics: true,
    sequence: { groove: { ppqn: 24, rows } },
  });
}

function render(processor, sandbox, frameCount, startFrame) {
  sandbox.currentFrame = startFrame;
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  assert.equal(processor.process([], [[left, right]]), true);
  return { left, right };
}

{
  const { Processor, sandbox } = loadProcessor();
  const program = { mode: "sequence", steps: [step(60)] };
  const processor = new Processor();
  processor.startSequence(program.steps, 120, { id: "k4b-variable", version: 23, mode: "sequence", scope: "phrase" }, requestFor(program));
  let startFrame = 0;
  for (const frameCount of [64, 128, 257, 512, 1024]) {
    render(processor, sandbox, frameCount, startFrame);
    assert.equal(processor.realtimeWindow.frameCount, frameCount);
    assert.equal(processor.realtimeWindow.startFrame, startFrame);
    assert.equal(processor.realtimeWindow.endFrame, startFrame + frameCount);
    startFrame += frameCount;
  }
  assert.equal(processor.realtimeWindow.underrunCount, 0);
  assert.equal(processor.realtimeWindow.renderOverlapCount, 0);
  const budget = processor.port.messages.find((message) => message.type === "realtime-budget-applied");
  assert.deepEqual(JSON.parse(JSON.stringify(budget.budget)), JSON.parse(JSON.stringify(realtimeEventWindowDomain.DEFAULT_BUDGET)));
}

{
  const { Processor, sandbox } = loadProcessor();
  const program = { mode: "sequence", steps: [step(60), step(62), step(64)] };
  const processor = new Processor();
  processor.startSequence(program.steps, 120, { id: "k4b-dense", version: 23, mode: "sequence", scope: "phrase" }, requestFor(program, [0, 0, 6]));
  render(processor, sandbox, 64, 0);
  const frames = processor.port.messages.filter((message) => message.type === "timeline-frame");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].frame, 0);
  assert.ok(frames[0].traceEvents.length >= 3);
  assert.equal(processor.realtimeWindow.packetCount, 1);
  assert.equal(processor.realtimeWindow.packetAt(0), processor.lastEventTracePacket);
  assert.equal(processor.realtimeWindow.overrunCount, 0);
}

{
  const { Processor, sandbox } = loadProcessor();
  const program = { mode: "sequence", steps: [step(60)] };
  const processor = new Processor();
  processor.startSequence(program.steps, 120, { id: "k4b-overrun", version: 23, mode: "sequence", scope: "phrase" }, requestFor(program));
  processor.realtimeWindow = realtimeEventWindowDomain.createRealtimeEventWindow({
    packetCapacity: 1,
    eventCapacity: 1,
    sameFrameEventCapacity: 1,
    qualityTier: "stress",
  });
  render(processor, sandbox, 64, 0);
  const error = processor.port.messages.find((message) => message.type === "realtime-window-error");
  assert.ok(error);
  assert.equal(error.code, "same-frame-overrun");
  assert.equal(processor.playing, false);
  assert.equal(processor.voices[0].active, false);
  assert.equal(processor.lastEventTracePacket, null);
}

{
  const { Processor, sandbox } = loadProcessor();
  const program = { mode: "sequence", steps: [step(60)] };
  const processor = new Processor();
  processor.startSequence(program.steps, 120, { id: "k4b-gap", version: 23, mode: "sequence", scope: "phrase" }, requestFor(program));
  render(processor, sandbox, 64, 0);
  render(processor, sandbox, 64, 96);
  const diagnostic = processor.port.messages.find((message) => message.type === "realtime-window-diagnostic" && message.reason === "underrun");
  assert.ok(diagnostic);
  assert.equal(diagnostic.diagnostics.lastUnderrunFrames, 32);
}

console.log("K4B AudioWorklet bounded realtime window tests passed");
