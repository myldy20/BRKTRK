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
assert.ok(Processor, "AudioWorklet processor must register");

const event = (note = null, id = "") => ({ note, wave: 0, gain: 0.1, pan: 0, mute: false, id });
const phrase = (note, prefix) => Array.from({ length: 16 }, (_, row) => event(row === 0 ? note : null, `${prefix}:${row}`));

function tracePlan(tracks, steps) {
  const processor = new Processor();
  const applied = [];
  const originalApply = processor.applyTrackEvent.bind(processor);
  processor.applyTrackEvent = (track, current) => {
    applied.push({ globalStep: processor.globalStep, track, id: current?.id ?? "", note: current?.note ?? null });
    return originalApply(track, current);
  };
  processor.startPlan({ tracks }, 120);
  for (let step = 0; step < steps; step += 1) processor.applyPlanStep();
  return { processor, applied, reports: processor.port.messages.filter((message) => message.type === "step") };
}

const short = phrase(60, "short");
const long = [...phrase(61, "long-a"), ...phrase(62, "long-b")];
const parallel = tracePlan([
  { active: true, events: short, startIndex: 0 },
  { active: true, events: long, startIndex: 0 },
], 64);

assert.equal(parallel.reports.length, 64);
for (let step = 0; step < 64; step += 1) {
  assert.equal(parallel.reports[step].trackSteps[0], step % 16);
  assert.equal(parallel.reports[step].trackSteps[1], step % 32);
}
assert.deepEqual(parallel.applied.filter((entry) => entry.track === 0 && entry.globalStep % 16 === 0).map((entry) => entry.note), [60, 60, 60, 60], "short Track must retrigger directly at every 16-row wrap");
assert.deepEqual(parallel.applied.filter((entry) => entry.track === 1 && entry.globalStep % 16 === 0).map((entry) => entry.note), [61, 62, 61, 62], "long Track must retain its independent 32-row period");

const sequentialEvents = [...phrase(70, "a0"), ...phrase(71, "a1"), ...phrase(72, "b0")];
const sequential = tracePlan([{ active: true, events: sequentialEvents, startIndex: 0 }], 96);
assert.deepEqual(sequential.applied.filter((entry) => entry.track === 0 && entry.globalStep % 16 === 0).map((entry) => entry.note), [70, 71, 72, 70, 71, 72], "sequential 2+1 Phrase program must wrap directly without a fourth silent Phrase");

const update = new Processor();
update.startPlan({ tracks: [{ active: true, events: long, startIndex: 0 }] }, 120);
for (let step = 0; step < 20; step += 1) update.applyPlanStep();
assert.equal(update.trackPrograms[0].position, 20);
update.updatePlan({ tracks: [{ active: true, events: short, startIndex: 0 }] });
assert.equal(update.trackPrograms[0].position, 4, "live shrink must preserve numeric phase modulo the new period");
update.applyPlanStep();
assert.equal(update.port.messages.filter((message) => message.type === "step").at(-1).trackSteps[0], 4);

// #467: a live plan replacement discarded the incoming plan's startIndex.
// normalizeTrackProgram gave the OUTGOING program's position precedence, so a
// Phrase -> Song transition bound the Song plan wherever the Phrase happened to
// be rather than at the entry point song-transport-policy computed for it.
// The transport identity already carries scope, so a replacement is
// distinguishable from a refresh without changing the port protocol.
{
  const phraseEvents = Array.from({ length: 16 }, (_, row) => event(row === 0 ? 60 : null, `ph:${row}`));
  const songEvents = Array.from({ length: 32 }, (_, row) => event(row === 0 ? 70 : row === 16 ? 71 : null, `song:${row}`));
  const phraseIdentity = Object.freeze({ id: "transport-1", version: 1, mode: "track-plan", scope: "phrase" });
  const songIdentity = Object.freeze({ id: "transport-2", version: 2, mode: "track-plan", scope: "song" });

  const transition = new Processor();
  transition.startPlan({ tracks: [{ active: true, events: phraseEvents, startIndex: 0 }] }, 120, phraseIdentity);
  for (let step = 0; step < 17; step += 1) transition.applyPlanStep();
  assert.equal(transition.trackPrograms[0].position, 1, "the Phrase program is one row past its boundary row");

  const staged = [];
  const originalApply = transition.applyTrackEvent.bind(transition);
  transition.applyTrackEvent = (track, current) => {
    staged.push({ track, id: current?.id ?? "", note: current?.note ?? null });
    return originalApply(track, current);
  };

  transition.updatePlan({ tracks: [{ active: true, events: songEvents, startIndex: 16 }] }, songIdentity);
  assert.equal(
    transition.trackPrograms[0].position,
    16,
    "a scope transition must bind the incoming Song plan at its own startIndex, not at the outgoing Phrase position",
  );

  // The re-apply after a replacement exists to re-establish voice state, not to
  // attack a note. Staging the previous row as a TRIGGER put an extra note on
  // at the seam that belongs to no step.
  assert.deepEqual(
    transition.voices.filter((voice) => voice.active).map((voice) => voice.note),
    [60],
    "a plan replacement must not re-attack a note; the sounding voice carries unchanged",
  );

  transition.applyPlanStep();
  const firstSongStep = transition.port.messages.filter((message) => message.type === "step").at(-1);
  assert.equal(firstSongStep.trackSteps[0], 16, "the first step after the transition plays the Song plan's entry row");
  assert.equal(transition.voices[0].note, 71, "and it is the note the Song plan declares there");

  // A same-scope update is an edit to the running program, so phase is still
  // preserved - that is what the live-shrink contract above depends on.
  const refresh = new Processor();
  refresh.startPlan({ tracks: [{ active: true, events: songEvents, startIndex: 0 }] }, 120, songIdentity);
  for (let step = 0; step < 20; step += 1) refresh.applyPlanStep();
  assert.equal(refresh.trackPrograms[0].position, 20);
  refresh.updatePlan(
    { tracks: [{ active: true, events: songEvents, startIndex: 0 }] },
    Object.freeze({ id: "transport-3", version: 3, mode: "track-plan", scope: "song" }),
  );
  assert.equal(refresh.trackPrograms[0].position, 20, "an edit to the running program must preserve its phase");

  // normalizeTransportIdentity defaults an absent or unrecognised scope to
  // "phrase". If the replacement test read the normalized value, an identity
  // that simply omits scope would look like a transition away from Song and
  // jump the playhead on what is really an ordinary edit. Only a declared
  // scope counts.
  for (const [label, identity] of [
    ["an identity omitting scope", { id: "transport-4", version: 4, mode: "track-plan" }],
    ["an identity with an unrecognised scope", { id: "transport-5", version: 5, mode: "track-plan", scope: "pattern" }],
    ["no identity at all", null],
  ]) {
    const quiet = new Processor();
    quiet.startPlan({ tracks: [{ active: true, events: songEvents, startIndex: 0 }] }, 120, songIdentity);
    for (let step = 0; step < 20; step += 1) quiet.applyPlanStep();
    quiet.updatePlan({ tracks: [{ active: true, events: songEvents, startIndex: 0 }] }, identity);
    assert.equal(quiet.trackPrograms[0].position, 20, `${label} must not be treated as a scope transition`);
  }
}

const protocol = new Processor();
assert.equal(protocol.port.messages[0].type, "transport-ready", "Worklet must announce transport readiness");
const firstIdentity = Object.freeze({ id: "transport-7", version: 7, mode: "track-plan", scope: "song" });
protocol.port.onmessage({ data: { type: "play-plan", plan: { tracks: [
  { active: true, events: short, startIndex: 3 },
  { active: true, events: long, startIndex: 17 },
] }, tempo: 123, transport: firstIdentity } });
const firstApplied = protocol.port.messages.find((message) => message.type === "transport-applied");
assert.equal(firstApplied.transport.id, firstIdentity.id);
assert.equal(firstApplied.transport.version, firstIdentity.version);
assert.deepEqual(Array.from(firstApplied.trackPositions).slice(0, 2), [3, 17]);
protocol.applyPlanStep();
const identityStep = protocol.port.messages.filter((message) => message.type === "step").at(-1);
assert.equal(identityStep.transport.id, firstIdentity.id, "every step report must identify the applied plan version");
assert.equal(identityStep.transport.version, firstIdentity.version);
assert.deepEqual(Array.from(identityStep.trackSteps).slice(0, 2), [3, 17]);

const secondIdentity = Object.freeze({ id: "transport-8", version: 8, mode: "track-plan", scope: "song" });
protocol.port.onmessage({ data: { type: "update-plan", plan: { tracks: [{ active: true, events: short, startIndex: 0 }] }, transport: secondIdentity } });
const appliedMessages = protocol.port.messages.filter((message) => message.type === "transport-applied");
assert.equal(appliedMessages.at(-1).transport.id, secondIdentity.id);
assert.equal(appliedMessages.at(-1).transport.version, secondIdentity.version);
assert.equal(appliedMessages.at(-1).trackPositions[0], 4, "update acknowledgement must report the preserved numeric position");
protocol.applyPlanStep();
assert.equal(protocol.port.messages.filter((message) => message.type === "step").at(-1).transport.id, secondIdentity.id);

// G4/#348 reproduction contract: an already-running linear Chain/Phrase program
// can be replaced by a Song track-plan. The Song identity must remain applied
// while unequal Track cycles wrap; only an explicit stop may emit stopped.
const continuation = new Processor();
const chainIdentity = Object.freeze({ id: "transport-chain-20", version: 20, mode: "sequence", scope: "chain" });
const chainSteps = Array.from({ length: 16 }, (_, row) => ({ notes: [row === 0 ? 48 : null] }));
continuation.port.onmessage({ data: { type: "play", sequence: chainSteps, tempo: 300, transport: chainIdentity } });
for (let step = 0; step < 5; step += 1) continuation.applySequenceStep();
const songIdentity = Object.freeze({ id: "transport-song-21", version: 21, mode: "track-plan", scope: "song" });
continuation.port.onmessage({ data: { type: "update-plan", plan: { tracks: [
  { active: true, events: sequentialEvents, startIndex: 0 },
  { active: true, events: short, startIndex: 0 },
] }, transport: songIdentity } });
const songApplied = continuation.port.messages.filter((message) => message.type === "transport-applied").at(-1);
assert.equal(songApplied.transport.id, songIdentity.id, "sequence→Song update must acknowledge the Song identity");
assert.equal(songApplied.transport.scope, "song");
for (let step = 0; step < 55; step += 1) continuation.applyPlanStep();
const songReports = continuation.port.messages.filter((message) => message.type === "step" && message.transport?.id === songIdentity.id);
assert.equal(songReports.length, 55, "Song must continue beyond its 48-row longest Track period");
assert.equal(songReports.some((message) => message.trackSteps[0] === 47 && message.trackSteps[1] === 15), true, "unequal 48/16 Track cycles must reach their shared wrap boundary");
assert.equal(songReports.some((message) => message.trackSteps[0] === 0 && message.trackSteps[1] === 0), true, "unequal Song Tracks must wrap without stopping");
assert.equal(continuation.port.messages.some((message) => message.type === "transport-stopped" || message.type === "stopped"), false, "Song replacement must not emit an unsolicited stop");
assert.equal(continuation.playing, true, "Song replacement must still be playing after wrap");
assert.equal(continuation.transportIdentity.id, songIdentity.id, "Song replacement identity must remain authoritative");

protocol.port.onmessage({ data: { type: "stop", transport: secondIdentity } });
const stopped = protocol.port.messages.filter((message) => message.type === "transport-stopped").at(-1);
assert.equal(stopped.transport.id, secondIdentity.id, "stop acknowledgement must identify the stopped plan version");
assert.equal(stopped.transport.version, secondIdentity.version);
assert.equal(protocol.playing, false);

console.log("AudioWorklet independent Track plan and transport protocol tests passed");
