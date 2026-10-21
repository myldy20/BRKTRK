const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const timingDomain = require("./timing-domain.js");
const noteLifecycleDomain = require("./note-lifecycle-domain.js");
const productionTimelineDomain = require("./production-timeline-domain.js");
const eventTraceDomain = require("./event-trace-domain.js");
const realtimeEventWindowDomain = require("./realtime-event-window-domain.js");

const source = readFileSync(require.resolve("./audio-worklet-runtime.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
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
};
vm.runInNewContext(source, sandbox, { filename: "audio-worklet-runtime.js" });
assert.ok(Processor, "AudioWorklet processor must register");

const sequenceStep = (notes = []) => ({
  notes: Array.from({ length: 8 }, (_, track) => notes[track] ?? null),
  waves: Array(8).fill(0),
  gains: Array(8).fill(0.1),
  pans: Array(8).fill(0),
  mutes: Array(8).fill(false),
});
const event = (note = null, id = "") => ({ note, wave: 0, gain: 0.1, pan: 0, mute: false, id });
const identity = Object.freeze({ id: "transport-k3c", version: 21, mode: "sequence", scope: "phrase" });

const parityProgram = {
  mode: "sequence",
  steps: Array.from({ length: 4 }, (_, row) => sequenceStep([row === 0 ? 60 : null])),
  contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })),
};
const parity = new Processor();
parity.startSequence(parityProgram.steps, 120, identity, productionTimelineDomain.createTimelineRequest(parityProgram));
assert.equal(parity.timelineMode, true);
assert.equal(parity.armStepSchedule(1000), true);
for (const frame of [1000, 7000, 13000, 19000, 25000]) parity.processTimelineUntil(frame);
assert.deepEqual(
  plain(parity.port.messages.filter((message) => message.type === "step").map((message) => message.frame)),
  [1000, 7000, 13000, 19000, 25000],
  "default K3C sequence must preserve K1 frame parity across the cycle wrap",
);
assert.equal(parity.port.messages.filter((message) => message.type === "timeline-applied").length, 1);

const plan = {
  mode: "track-plan",
  tracks: [
    { active: true, events: [event(60, "a0"), event(61, "a1"), event(62, "a2"), event(63, "a3")], contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })), startIndex: 0 },
    { active: true, events: [event(70, "b0"), event(71, "b1"), event(72, "b2"), event(73, "b3")], contexts: Array.from({ length: 4 }, (_, row) => ({ phraseRow: row })), startIndex: 1 },
  ],
};
const planRequest = productionTimelineDomain.createTimelineRequest(plan, {
  version: 1,
  mode: "track-plan",
  diagnostics: true,
  tracks: [
    { track: 0, groove: { ppqn: 24, rows: [6, 6] } },
    { track: 1, groove: { ppqn: 24, rows: [8, 8] } },
  ],
});
const independent = new Processor();
independent.startPlan({ ...plan, timeline: planRequest }, 120, { ...identity, mode: "track-plan", scope: "song" });
independent.armStepSchedule(0);
for (const frame of [0, 6000, 8000, 12000, 16000, 18000, 24000]) independent.processTimelineUntil(frame);
const independentSteps = independent.port.messages.filter((message) => message.type === "step");
assert.deepEqual(plain(independentSteps.map((message) => message.frame)), [0, 6000, 8000, 12000, 16000, 18000, 24000]);
assert.deepEqual(plain(independentSteps[0].trackEvents.map((entry) => [entry.track, entry.row])), [[0, 0], [1, 1]]);
assert.deepEqual(plain(independentSteps[1].trackEvents.map((entry) => [entry.track, entry.row])), [[0, 1]]);
assert.deepEqual(plain(independentSteps[2].trackEvents.map((entry) => [entry.track, entry.row])), [[1, 2]]);
assert.equal(independent.trackPrograms[0].position, 1);
assert.equal(independent.trackPrograms[1].position, 1);

const skipProgram = {
  mode: "sequence",
  steps: [sequenceStep([60]), sequenceStep([-2]), sequenceStep([64])],
};
const skipRequest = productionTimelineDomain.createTimelineRequest(skipProgram, {
  version: 1,
  mode: "sequence",
  diagnostics: true,
  sequence: { groove: { ppqn: 24, rows: [6, 0, 6] } },
});
const skipped = new Processor();
const lifecycleOrder = [];
const originalRelease = skipped.voices[0].release.bind(skipped.voices[0]);
const originalTrigger = skipped.voices[0].triggerNote.bind(skipped.voices[0]);
skipped.voices[0].release = () => { lifecycleOrder.push("release"); originalRelease(); };
skipped.voices[0].triggerNote = (note) => { lifecycleOrder.push(`trigger:${note}`); originalTrigger(note); };
skipped.startSequence(skipProgram.steps, 120, identity, skipRequest);
skipped.armStepSchedule(0);
skipped.processTimelineUntil(0);
lifecycleOrder.length = 0;
skipped.processTimelineUntil(6000);
const sameFrame = skipped.port.messages.filter((message) => message.type === "step").at(-1);
assert.equal(sameFrame.frame, 6000);
assert.deepEqual(plain(sameFrame.sequenceEvents.map((entry) => entry.row)), [1, 2]);
assert.deepEqual(lifecycleOrder, ["release", "trigger:64"], "same-frame rows must keep K2 release before trigger ordering");
assert.equal(skipped.voices[0].note, 64);
assert.equal(skipped.timelineNextFrame, 12000, "same-frame rows must be drained before advancing to the next cycle");

const tableProgram = { mode: "sequence", steps: [sequenceStep([60]), sequenceStep([null])] };
const tableRequest = productionTimelineDomain.createTimelineRequest(tableProgram, {
  version: 1,
  mode: "sequence",
  diagnostics: true,
  tableSources: [{
    track: 0,
    sourceKind: "instrument",
    sourceId: 0,
    table: 1,
    startOffsetFrames: 0,
    endOffsetFrames: 1000,
    columns: {
      noteVolume: {
        tic: "00",
        cursorRows: [0, 1],
        initialCursor: 0,
        emissionPolicy: "emit-then-advance",
        triggerOffsets: [0],
      },
    },
  }],
});
const tableProcessor = new Processor();
tableProcessor.startSequence(tableProgram.steps, 120, identity, tableRequest);
tableProcessor.armStepSchedule(0);
const executionOrder = [];
let tableIndex = tableProcessor.timelineTableIndex;
Object.defineProperty(tableProcessor, "timelineTableIndex", {
  configurable: true,
  get: () => tableIndex,
  set: (value) => {
    if (value > tableIndex) executionOrder.push("table");
    tableIndex = value;
  },
});
const originalLifecycle = tableProcessor.processTimelineLifecycle.bind(tableProcessor);
tableProcessor.processTimelineLifecycle = (frame, packet) => {
  executionOrder.push("lifecycle");
  return originalLifecycle(frame, packet);
};
tableProcessor.processTimelineUntil(0);
assert.deepEqual(executionOrder, ["table", "table", "lifecycle"], "source start and Table row must execute before note lifecycle");
const tableFrame = tableProcessor.port.messages.find((message) => message.type === "timeline-frame" && message.frame === 0);
assert.deepEqual(plain(tableFrame.tableEvents.map((entry) => entry.phase)), [
  timingDomain.EVENT_PHASES.SOURCE_CONTROL,
  timingDomain.EVENT_PHASES.TABLE,
]);

tableProcessor.setTempo(90);
assert.equal(tableProcessor.tempo, 120, "live tempo mutation with active Table sources must be rejected");
assert.match(tableProcessor.port.messages.filter((message) => message.type === "timeline-error").at(-1).message, /active Table sources/);

const rebuilt = new Processor();
rebuilt.startSequence(parityProgram.steps, 120, identity, productionTimelineDomain.createTimelineRequest(parityProgram));
rebuilt.armStepSchedule(0);
rebuilt.processTimelineUntil(0);
assert.equal(rebuilt.timelineNextFrame, 6000);
rebuilt.setTempo(60);
assert.equal(rebuilt.timelineRebuildPending, true);
rebuilt.processTimelineUntil(6000);
assert.equal(rebuilt.timelineGeneration, 2);
assert.equal(rebuilt.port.messages.filter((message) => message.type === "step").at(-1).frame, 6000);
assert.equal(rebuilt.timelineNextFrame, 18000, "tempo rebuild must preserve the scheduled boundary and apply the new following interval");

console.log("K3C AudioWorklet production timeline tests passed");
