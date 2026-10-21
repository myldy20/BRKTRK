const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const timingDomain = require("./timing-domain.js");
const noteLifecycleDomain = require("./note-lifecycle-domain.js");
const productionTimelineDomain = require("./production-timeline-domain.js");
const templateDomain = require("./production-timeline-template.js");
const eventTraceDomain = require("./event-trace-domain.js");
const realtimeEventWindowDomain = require("./realtime-event-window-domain.js");

const extensionSource = readFileSync(require.resolve("./production-prepared-timeline-processor-extension.js"), "utf8");
const runtimeSource = readFileSync(require.resolve("./audio-worklet-runtime.js"), "utf8");
assert.doesNotMatch(extensionSource, /compileProductionTimeline\s*\(/, "R1 registered processor extension must not full-compile a production timeline");
assert.doesNotMatch(extensionSource, /timeline-position-(?:request|snapshot)/, "R1 must not introduce a position handshake or second clock");

const step = (note = null) => ({
  notes: Array.from({ length: 8 }, (_, track) => track === 0 ? note : null),
  velocities: Array(8).fill(100),
  instrumentIds: Array(8).fill(0),
  fx: Array.from({ length: 8 }, () => []),
});
const sequenceProgram = (notes, startIndex = 0) => ({
  mode: "sequence",
  steps: notes.map(step),
  startIndex,
  contexts: notes.map((_, row) => ({ phraseRow: row })),
});
const prepare = (program, tempo) => {
  const request = productionTimelineDomain.createTimelineRequest(program);
  return {
    request,
    template: templateDomain.compileRelativeTimeline({ sampleRate: 48000, tempo, program, request }),
  };
};

const initialProgram = sequenceProgram([60, null, 64, null], 0);
const initialPrepared = prepare(initialProgram, 120);
// Deliberately compile live-update/retempo templates from row 0. The Worklet is
// already at rows 1/2 when those commands arrive. R1 must rotate only at exact
// bind time from the authoritative processor position, without recompiling K3.
const updatedProgram = sequenceProgram([67, null, 69, null], 0);
const updatedPrepared = prepare(updatedProgram, 120);
const tempoProgram = sequenceProgram([67, null, 69, null], 0);
const tempoPrepared = prepare(tempoProgram, 60);

let poisonCalls = 0;
const poisonedTimelineDomain = Object.freeze({
  ...productionTimelineDomain,
  compileProductionTimeline() {
    poisonCalls += 1;
    throw new Error("POISON: full production timeline compile reached Worklet realtime path");
  },
});

// The production Worklet loads the template domain and processor extension in
// one realm. This test prepares fixtures in Node and executes the Worklet in a
// vm realm, so transfer the bind-position object back into the domain realm to
// model the receiving-side structured-clone boundary accurately.
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
    this.port = {
      onmessage: null,
      messages,
      postMessage(message) { messages.push(message); },
    };
  }
}

const sandbox = {
  BRKTRKTimingDomain: timingDomain,
  BRKTRKNoteLifecycleDomain: noteLifecycleDomain,
  BRKTRKProductionTimelineDomain: poisonedTimelineDomain,
  BRKTRKProductionTimelineTemplate: workletTemplateDomain,
  BRKTRKEventTraceDomain: eventTraceDomain,
  BRKTRKRealtimeEventWindowDomain: realtimeEventWindowDomain,
  BRKTRKProductionAudioProcessorExtension: Object.freeze({ extendProcessor: (BaseProcessor) => BaseProcessor }),
  AudioWorkletProcessor: AudioWorkletProcessorStub,
  registerProcessor(name, candidate) {
    assert.equal(name, "brktrk-audio");
    Processor = candidate;
  },
  sampleRate: 48000,
  currentFrame: 1000,
  console,
  Math,
  Array,
  Number,
  Object,
  Set,
  Map,
  Float32Array,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(extensionSource, sandbox, { filename: "production-prepared-timeline-processor-extension.js" });
vm.runInNewContext(runtimeSource, sandbox, { filename: "audio-worklet-runtime.js" });
assert.ok(Processor, "R1 composed processor must register");

const identity1 = { id: "transport-r1-1", version: 1, mode: "sequence", scope: "phrase" };
const processor = new Processor();
processor.port.onmessage({ data: {
  type: "play",
  sequence: initialProgram.steps,
  tempo: 120,
  transport: identity1,
  timeline: initialPrepared.request,
  timelineTemplate: initialPrepared.template,
} });
assert.equal(processor.playing, true);
assert.equal(processor.schedulePending, true);

const renderAt = (frame, length = 1) => {
  sandbox.currentFrame = frame;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  processor.process([], [[left, right]]);
};
renderAt(1000);
assert.equal(poisonCalls, 0, "Play bind must not reach full production timeline compile");
assert.equal(processor.timelineGeneration, 1);
assert.equal(processor.port.messages.filter((message) => message.type === "step").at(-1).frame, 1000);
assert.equal(processor.stepIndex, 1);
assert.equal(processor.timelineNextFrame, 7000);
assert.equal(processor.port.messages.filter((message) => message.type === "timeline-applied").at(-1).timeline.prepared, true);
assert.equal(processor.port.messages.filter((message) => message.type === "timeline-applied").at(-1).timeline.sequence.startIndex, 0);

const identity2 = { id: "transport-r1-2", version: 2, mode: "sequence", scope: "phrase" };
processor.port.onmessage({ data: {
  type: "update-sequence",
  sequence: updatedProgram.steps,
  transport: identity2,
  timeline: updatedPrepared.request,
  timelineTemplate: updatedPrepared.template,
} });
assert.equal(processor.transportIdentity.version, 2);
assert.equal(processor.timelineRebuildPending, true);
renderAt(7000);
assert.equal(poisonCalls, 0, "Update rebuild must bind the prepared template without full compile");
assert.equal(processor.timelineGeneration, 2);
const updateStep = processor.port.messages.filter((message) => message.type === "step").at(-1);
assert.equal(updateStep.frame, 7000);
assert.deepEqual(JSON.parse(JSON.stringify(updateStep.sequenceEvents.map((event) => event.row))), [1]);
assert.equal(processor.stepIndex, 2);
assert.equal(processor.timelineNextFrame, 13000);
assert.equal(
  processor.port.messages.filter((message) => message.type === "timeline-applied").at(-1).timeline.sequence.startIndex,
  1,
  "prepared row-0 update template must rotate to the exact live next row only in Worklet bind",
);

processor.port.onmessage({ data: {
  type: "tempo",
  value: 60,
  timelineTemplate: tempoPrepared.template,
} });
assert.equal(processor.tempo, 60);
assert.equal(processor.timelineRebuildPending, true);
renderAt(13000);
assert.equal(poisonCalls, 0, "Tempo rebuild must bind the prepared template without full compile");
assert.equal(processor.timelineGeneration, 3);
const tempoStep = processor.port.messages.filter((message) => message.type === "step").at(-1);
assert.equal(tempoStep.frame, 13000, "tempo rebuild must preserve the already scheduled exact boundary");
assert.deepEqual(JSON.parse(JSON.stringify(tempoStep.sequenceEvents.map((event) => event.row))), [2]);
assert.equal(processor.timelineNextFrame, 25000, "60 BPM must double the following 120 BPM row interval from the exact rebuild boundary");
assert.equal(
  processor.port.messages.filter((message) => message.type === "timeline-applied").at(-1).timeline.sequence.startIndex,
  2,
  "prepared row-0 tempo template must rotate to the exact live next row only in Worklet bind",
);

// Prepared timing identity is part of fail-before-mutation. A structurally valid
// template compiled for another BPM must never mutate the program or tempo and
// then get bound under a different runtime tempo.
const beforeTempoMismatchSequence = processor.sequence;
const beforeTempoMismatchIdentity = processor.transportIdentity;
processor.pendingPreparedTimelineTemplate = initialPrepared.template;
assert.throws(
  () => processor.updateSequence([step(72), step(null), step(74), step(null)], { id: "bad-tempo-update", version: 98, mode: "sequence", scope: "phrase" }, initialPrepared.request),
  /prepared tempo 120 does not match runtime tempo 60/,
);
assert.equal(processor.sequence, beforeTempoMismatchSequence);
assert.equal(processor.transportIdentity, beforeTempoMismatchIdentity);
const beforeTempoValue = processor.tempo;
processor.pendingPreparedTimelineTemplate = initialPrepared.template;
assert.throws(
  () => processor.setTempo(90),
  /prepared tempo 120 does not match runtime tempo 90/,
);
assert.equal(processor.tempo, beforeTempoValue);
processor.pendingPreparedTimelineTemplate = null;

// Validation is executed before the message-specific BaseProcessor mutation.
// Exercise the method directly so the rejection wrapper cannot hide a partial update.
const beforeSequence = processor.sequence;
const beforeIdentity = processor.transportIdentity;
processor.pendingPreparedTimelineTemplate = { templateVersion: 999 };
assert.throws(
  () => processor.updateSequence([step(72), step(null)], { id: "bad", version: 99, mode: "sequence", scope: "phrase" }, initialPrepared.request),
  /templateVersion/,
);
assert.equal(processor.sequence, beforeSequence);
assert.equal(processor.transportIdentity, beforeIdentity);
processor.pendingPreparedTimelineTemplate = null;

// The actual MessagePort wrapper must reject an invalid live Update without
// stopping or otherwise mutating the already-valid transport.
const liveBeforeSequence = processor.sequence;
const liveBeforeIdentity = processor.transportIdentity;
const liveBeforeTempo = processor.tempo;
const rejectionCountBefore = processor.port.messages.filter((message) => message.type === "production-transport-rejected").length;
processor.port.onmessage({ data: {
  type: "update-sequence",
  sequence: [step(75), step(null)],
  transport: { id: "bad-live", version: 100, mode: "sequence", scope: "phrase" },
  timeline: initialPrepared.request,
  timelineTemplate: { templateVersion: 999 },
} });
assert.equal(processor.playing, true);
assert.equal(processor.sequence, liveBeforeSequence);
assert.equal(processor.transportIdentity, liveBeforeIdentity);
assert.equal(processor.tempo, liveBeforeTempo);
assert.equal(
  processor.port.messages.filter((message) => message.type === "production-transport-rejected").length,
  rejectionCountBefore + 1,
);

const invalidStart = new Processor();
invalidStart.port.onmessage({ data: {
  type: "play",
  sequence: initialProgram.steps,
  tempo: 120,
  transport: identity1,
  timeline: initialPrepared.request,
  timelineTemplate: { templateVersion: 999 },
} });
assert.equal(invalidStart.playing, false);
assert.equal(invalidStart.transportIdentity, null);
const rejection = invalidStart.port.messages.find((message) => message.type === "production-transport-rejected");
assert.equal(rejection.code, "invalid-prepared-timeline");
assert.equal(poisonCalls, 0, "invalid prepared data must fail before any full compile fallback");

console.log("K3 R1 prepared Worklet exact-position bind + tempo-identity + pre-mutation rejection + poisoned-compiler tests passed");
