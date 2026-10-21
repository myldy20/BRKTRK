const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const source = readFileSync(require.resolve("./audio-worklet-runtime.js"), "utf8");
const timingDomain = require("./timing-domain.js");
const noteLifecycleDomain = require("./note-lifecycle-domain.js");
const eventTraceDomain = require("./event-trace-domain.js");
const realtimeEventWindowDomain = require("./realtime-event-window-domain.js");

function load(sampleRate) {
  let Processor;
  class Stub {
    constructor() {
      const messages = [];
      this.port = { onmessage: null, messages, postMessage(message) { messages.push(message); } };
    }
  }
  const sandbox = {
    BRKTRKTimingDomain: timingDomain,
    BRKTRKNoteLifecycleDomain: noteLifecycleDomain,
    BRKTRKEventTraceDomain: eventTraceDomain,
    BRKTRKRealtimeEventWindowDomain: realtimeEventWindowDomain,
    AudioWorkletProcessor: Stub,
    registerProcessor(name, value) {
      assert.equal(name, "brktrk-audio");
      Processor = value;
    },
    sampleRate,
    currentFrame: 0,
    console,
    Math,
    Array,
    Number,
    Object,
    Error,
  };
  vm.runInNewContext(source, sandbox, { filename: "audio-worklet-runtime.js" });
  assert.ok(Processor, "AudioWorklet processor must register");
  return { Processor, sandbox };
}

const sequence = [{ notes: [60], waves: [0], gains: [0.1], pans: [0], mutes: [false] }];

function processBlock(processor, sandbox, start, length) {
  sandbox.currentFrame = start;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  processor.process([], [[left, right]]);
}

function runTrace(sampleRate, tempo, blockSizes, rows = 64, startFrame = 997) {
  const { Processor, sandbox } = load(sampleRate);
  const processor = new Processor();
  processor.startSequence(sequence, tempo, { id: "trace", version: 1, scope: "phrase" });
  const clock = timingDomain.createMusicalFrameClock({ sampleRate, tempo, stepUnits: timingDomain.TRACKER_ROW_UNITS, startFrame });
  const end = clock.frameAt(rows - 1) + 1;
  let frame = startFrame;
  let block = 0;
  while (frame < end) {
    const length = Math.min(blockSizes[block % blockSizes.length], end - frame);
    processBlock(processor, sandbox, frame, length);
    frame += length;
    block += 1;
  }
  return processor.port.messages.filter((message) => message.type === "step").slice(0, rows).map((message) => message.frame);
}

for (const rate of [44100, 48000, 96000]) {
  for (const tempo of [30, 120, 300]) {
    const expectedClock = timingDomain.createMusicalFrameClock({ sampleRate: rate, tempo, stepUnits: timingDomain.TRACKER_ROW_UNITS, startFrame: 997 });
    const expected = Array.from({ length: 64 }, (_, index) => expectedClock.frameAt(index));
    assert.deepEqual(runTrace(rate, tempo, [128]), expected, `fixed render blocks must follow K0 at ${rate} Hz / ${tempo} BPM`);
    assert.deepEqual(runTrace(rate, tempo, [1, 63, 257, 17, 128]), expected, `variable render blocks must follow K0 at ${rate} Hz / ${tempo} BPM`);
  }
}

function legacyBoundaryTrace(sampleRate, tempo, rows) {
  const step = sampleRate * 60 / tempo / 4;
  const result = [];
  let frame = 0;
  let countdown = 0;
  for (let row = 0; row < rows; row += 1) {
    result.push(frame);
    countdown += step;
    const advance = Math.ceil(countdown);
    frame += advance;
    countdown -= advance;
  }
  return result;
}

for (const rate of [44100, 48000, 96000]) {
  for (const tempo of [30, 120, 300]) {
    const clock = timingDomain.createMusicalFrameClock({ sampleRate: rate, tempo, stepUnits: timingDomain.TRACKER_ROW_UNITS, startFrame: 0 });
    const absolute = Array.from({ length: 4096 }, (_, index) => clock.frameAt(index));
    assert.deepEqual(absolute, legacyBoundaryTrace(rate, tempo, 4096), `absolute clock must preserve accepted row boundaries at ${rate} Hz / ${tempo} BPM`);
  }
}

{
  const { Processor, sandbox } = load(48000);
  const processor = new Processor();
  const events = Array.from({ length: 16 }, (_, index) => ({ note: index === 0 ? 60 : null, id: `a${index}` }));
  processor.startPlan({ tracks: [{ active: true, events, startIndex: 0 }] }, 120, { id: "plan-a", version: 1, scope: "song" });
  processBlock(processor, sandbox, 0, 3000);
  const before = processor.nextStepFrame;
  processor.updatePlan({ tracks: [{ active: true, events: events.slice(0, 8), startIndex: 0 }] }, { id: "plan-b", version: 2, scope: "song" });
  assert.equal(processor.nextStepFrame, before, "live plan update must preserve the current row boundary");
  processBlock(processor, sandbox, 3000, 3001);
  const frames = processor.port.messages.filter((message) => message.type === "step").map((message) => message.frame);
  assert.deepEqual(frames.slice(0, 2), [0, 6000]);
}

{
  const { Processor, sandbox } = load(48000);
  const processor = new Processor();
  processor.startSequence(sequence, 120, { id: "tempo", version: 1, scope: "phrase" });
  processBlock(processor, sandbox, 0, 3000);
  processor.port.onmessage({ data: { type: "tempo", value: 60 } });
  processBlock(processor, sandbox, 3000, 15001);
  const frames = processor.port.messages.filter((message) => message.type === "step").map((message) => message.frame);
  assert.deepEqual(frames.slice(0, 3), [0, 6000, 18000], "tempo change must preserve the scheduled current row and affect the following interval");
}

{
  const { Processor, sandbox } = load(48000);
  const processor = new Processor();
  processor.startSequence(sequence, 120, { id: "one", version: 1, scope: "phrase" });
  processBlock(processor, sandbox, 0, 128);
  processor.stop({ id: "one", version: 1, scope: "phrase" });
  processor.startSequence(sequence, 120, { id: "two", version: 2, scope: "phrase" });
  processBlock(processor, sandbox, 10000, 1);
  const frames = processor.port.messages.filter((message) => message.type === "step").map((message) => message.frame);
  assert.deepEqual(frames, [0, 10000], "Stop and Play must arm at the first frame of the new render block");
}

console.log("K1 absolute-frame AudioWorklet timing tests passed");
