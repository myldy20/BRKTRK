const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const timingDomain = require("./timing-domain.js");
const noteLifecycleDomain = require("./note-lifecycle-domain.js");
const eventTraceDomain = require("./event-trace-domain.js");
const realtimeEventWindowDomain = require("./realtime-event-window-domain.js");

const source = readFileSync(require.resolve("./audio-worklet-runtime.js"), "utf8");
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
  Error,
};
vm.runInNewContext(source, sandbox, { filename: "audio-worklet-runtime.js" });
assert.ok(Processor, "AudioWorklet processor must register");

const row = (note, extra = {}) => ({ note, velocity: 100, instrumentId: 0, fx: [], ...extra });
const processor = new Processor();
processor.startPlan({
  tracks: [
    { active: true, events: [row(60)], startIndex: 0 },
    { active: true, events: [row(-2)], startIndex: 0 },
    { active: true, events: [row(null)], startIndex: 0 },
    { active: true, events: [row(null)], startIndex: 0 },
  ],
}, 120, { id: "lifecycle", version: 1, scope: "song" });

processor.voices[1].active = true;
processor.voices[1].note = 55;
processor.voices[2].active = true;
processor.voices[2].note = 57;
processor.voices[3].active = false;
processor.voices[3].note = -1;

const calls = [];
for (let track = 0; track < 4; track += 1) {
  const voice = processor.voices[track];
  for (const method of ["release", "triggerNote"]) {
    const original = voice[method].bind(voice);
    voice[method] = (...args) => {
      calls.push(`${method}:${track}`);
      return original(...args);
    };
  }
}
const originalPost = processor.port.postMessage.bind(processor.port);
processor.port.postMessage = (message) => {
  if (message.type === "step") calls.push("observe:step");
  originalPost(message);
};

processor.applyPlanStep(2048);
assert.deepEqual(calls, [
  "release:1",
  "triggerNote:0",
  "observe:step",
], "base realtime lifecycle must execute release before trigger and publish observe after lifecycle mutation");
assert.equal(processor.lastLifecycleFrame, 2048);
assert.equal(processor.port.messages.filter((message) => message.type === "step").at(-1).frame, 2048);

assert.equal(processor.voices[0].active, true);
assert.equal(processor.voices[0].note, 60);
assert.equal(processor.voices[1].active, false, "Note Off must release an active lifecycle gate");
assert.equal(processor.voices[1].note, -1);
assert.equal(processor.voices[2].active, true, "Empty row must retain an active lifecycle gate");
assert.equal(processor.voices[2].note, 57);
assert.equal(processor.voices[3].active, false, "Empty row must not activate an inactive lifecycle gate");

for (const voice of processor.voices) {
  for (const retiredField of ["phase", "frequency", "wave", "targetGain", "pan"]) {
    assert.equal(Object.hasOwn(voice, retiredField), false, `timing-only lifecycle voice must not retain preview field ${retiredField}`);
  }
  assert.equal(typeof voice.prepareTrigger, "undefined", "timing-only lifecycle voice must not retain preview prepareTrigger");
  assert.equal(typeof voice.update, "undefined", "timing-only lifecycle voice must not retain preview parameter update method");
}

const slots = processor.lifecycleSlots;
assert.equal(slots.length, 8, "K2 must use one bounded preallocated lifecycle slot per Track");
const slotIdentities = Array.from(slots);
processor.applyPlanStep(4096);
assert.deepEqual(Array.from(processor.lifecycleSlots), slotIdentities, "row processing must reuse lifecycle slots rather than allocate a new action graph");

console.log("K2 realtime production timing-shell lifecycle tests passed");
