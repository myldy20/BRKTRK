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
};
vm.runInNewContext(source, sandbox, { filename: "audio-worklet-runtime.js" });
assert.ok(Processor);

const processor = new Processor();
const sharedInstrumentEvent = { note: 60, wave: 2, gain: 0.2, pan: 0, mute: false };
const identity = Object.freeze({ id: "transport-12", version: 12, mode: "track-plan", scope: "song" });
processor.startPlan({
  tracks: [
    { active: true, events: [sharedInstrumentEvent, { ...sharedInstrumentEvent, note: null }], startIndex: 0 },
    { active: true, events: [sharedInstrumentEvent, { ...sharedInstrumentEvent, note: null }], startIndex: 1 },
  ],
}, 120, identity);

const identityBefore = JSON.stringify(processor.transportIdentity);
const positionsBefore = Array.from(processor.trackPrograms, (program) => program.position);
processor.port.onmessage({ data: { type: "track-mix", revision: 7, tracks: [
  { gain: 0.25, mute: false, pan: -0.5 },
  { gain: 1, mute: true, pan: 0.75 },
] } });

assert.equal(processor.trackMixRevision, 7);
assert.deepEqual({ ...processor.trackMix[0] }, { gain: 0.25, mute: false, pan: -0.5 });
assert.deepEqual({ ...processor.trackMix[1] }, { gain: 1, mute: true, pan: 0.75 });
assert.equal(JSON.stringify(processor.transportIdentity), identityBefore, "Track mix must preserve transport identity");
assert.deepEqual(Array.from(processor.trackPrograms, (program) => program.position), positionsBefore, "Track mix must preserve independent Track positions");
assert.equal(processor.playing, true);

const ack = processor.port.messages.filter((message) => message.type === "track-mix-applied").at(-1);
assert.equal(ack.revision, 7);
assert.deepEqual({ ...ack.tracks[0] }, { gain: 0.25, mute: false, pan: -0.5 });
const track0 = processor.mixTrackSample(0, 1, 0);
assert.ok(track0.left > track0.right, "negative Track pan must move the logical Track bus left");
assert.ok(track0.left < 0.25 && track0.left > 0, "Track gain must apply after Instrument event gain");
assert.deepEqual({ ...processor.mixTrackSample(1, 1, 0) }, { left: 0, right: 0 }, "Track mute must silence only that logical bus");

processor.applyPlanStep();
assert.deepEqual(Array.from(processor.trackPrograms.slice(0, 2), (program) => program.position), [1, 0], "unequal/current Track positions must continue after a live mix update");
assert.equal(processor.transportIdentity.version, 12);

processor.port.onmessage({ data: { type: "track-mix", revision: 8, tracks: [
  { gain: 1.4, mute: false, pan: 3 },
  { gain: -2, mute: false, pan: -3 },
] } });
assert.deepEqual({ ...processor.trackMix[0] }, { gain: 1, mute: false, pan: 1 });
assert.deepEqual({ ...processor.trackMix[1] }, { gain: 0, mute: false, pan: -1 });
assert.equal(processor.transportIdentity.version, 12);

console.log("AudioWorklet logical Track bus tests passed");
