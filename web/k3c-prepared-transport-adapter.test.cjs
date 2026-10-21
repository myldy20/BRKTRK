const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const source = readFileSync(require.resolve("./k3c-transport-adapter.js"), "utf8");
const browserFixture = readFileSync(require.resolve("./k3c-audio-facade-browser-smoke.html"), "utf8");
for (const token of [
  "globalThis.BRKTRKProductionTimelineTemplate",
  "compileRelativeTimeline",
  "globalThis.BRKTRKProductionExecutionTemplate",
  "compilePreparedExecution",
  "context:{sampleRate:48000}",
  "globalThis.audio===undefined",
]) {
  assert.ok(browserFixture.includes(token), `K3C exact lexical-facade fixture must carry the current R2 dependency contract: ${token}`);
}

const posted = [];
const compileCalls = [];
const executionCalls = [];
let legacyTempo = null;
let legacyStop = null;
let onTransport = null;
let appliedProgram = null;
let transportSnapshot = null;

const port = { postMessage(message) { posted.push(message); } };
const timelineDomain = {
  TIMELINE_VERSION: 1,
  createTimelineRequest(program) {
    return Object.freeze({ version: 1, mode: program?.mode === "track-plan" ? "track-plan" : "sequence", tableSources: [] });
  },
};
const templateDomain = {
  compileRelativeTimeline(input) {
    if (input.tempo === 666) throw new Error("fixture preparation failure");
    const mode = input.program?.mode === "track-plan" ? "track-plan" : "sequence";
    const call = {
      sampleRate: input.sampleRate,
      tempo: input.tempo,
      mode,
      sequenceStartIndex: input.program?.startIndex ?? null,
      trackStartIndices: mode === "track-plan"
        ? input.program.tracks.map((track) => track?.active ? (track.startIndex ?? null) : null)
        : null,
    };
    compileCalls.push(call);
    return Object.freeze({ templateVersion: 1, marker: compileCalls.length, mode, sampleRate: input.sampleRate, call });
  },
};
const executionDomain = {
  compilePreparedExecution({ timelineTemplate, program }) {
    if (program?.failExecution === true) throw new Error("fixture execution preparation failure");
    const call = { timelineMarker: timelineTemplate.marker, mode: program?.mode === "track-plan" ? "track-plan" : "sequence" };
    executionCalls.push(call);
    return Object.freeze({ executionVersion: 1, marker: executionCalls.length, call });
  },
};

const audio = {
  ready: true,
  context: { sampleRate: 48000 },
  node: { port },
  tempo(value) { legacyTempo = value; },
  stop(transport) { legacyStop = transport; },
};
const sandbox = {
  __fixtureAudio: audio,
  BRKTRKProductionTimelineDomain: timelineDomain,
  BRKTRKProductionTimelineTemplate: templateDomain,
  BRKTRKProductionExecutionTemplate: executionDomain,
  BRKTRKStores: {
    project: { getState: () => ({ tempo: 120 }) },
    transport: {
      runtime: { getProgram: () => appliedProgram, snapshot: () => transportSnapshot },
      subscribe(channel, listener) { assert.equal(channel, "transport"); onTransport = listener; },
    },
  },
  document: { body: { dataset: {} } },
  console,
  Object,
  Array,
  Number,
  Math,
};
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);
// Match production app-model.js: `audio` is a top-level lexical binding shared
// by later classic scripts, not a globalThis property. This specifically guards
// the exact-browser failure exposed after R1/R2 added prepared dependencies.
vm.runInContext("const audio = globalThis.__fixtureAudio;", context, { filename: "lexical-audio-fixture.js" });
assert.equal(sandbox.audio, undefined, "fixture audio must remain lexical rather than becoming a global property");
vm.runInContext(source, context, { filename: "k3c-transport-adapter.js" });

const sequence = (length, note = 60) => Array.from({ length }, (_, row) => ({ notes: [row === 0 ? note : null] }));
const id1 = { id: "transport-1", version: 1, mode: "sequence", scope: "phrase" };
audio.play(sequence(4), 120, id1);
assert.equal(posted.length, 1);
assert.equal(posted[0].type, "play");
assert.equal(posted[0].timelineTemplate.marker, 1);
assert.equal(posted[0].executionTemplate.marker, 1);
assert.equal(executionCalls[0].timelineMarker, 1);
assert.equal(compileCalls[0].sampleRate, 48000);
assert.equal(compileCalls[0].tempo, 120);
assert.equal(compileCalls[0].mode, "sequence");

const id2 = { id: "transport-2", version: 2, mode: "sequence", scope: "phrase" };
audio.updateSequence(sequence(4, 64), id2);
assert.equal(posted.at(-1).type, "update-sequence");
assert.equal(posted.at(-1).transport.version, 2);
assert.equal(posted.at(-1).timelineTemplate.marker, 2);
assert.equal(posted.at(-1).executionTemplate.marker, 2);
assert.equal(compileCalls[1].tempo, 120);
assert.equal(compileCalls[1].sequenceStartIndex, null, "control-plane update template must not guess the live Worklet row");

// Tempo compiles synchronously against the desired program but likewise does
// not need or request a main-thread position. Exact cycle rotation is deferred
// to Worklet bind where the authoritative next row exists.
audio.tempo(90);
assert.equal(posted.at(-1).type, "tempo");
assert.equal(posted.at(-1).value, 90);
assert.equal(posted.at(-1).timelineTemplate.marker, 3);
assert.equal(posted.at(-1).executionTemplate.marker, 3);
assert.equal(compileCalls[2].tempo, 90);
assert.equal(compileCalls[2].sequenceStartIndex, null);

const plan = {
  mode: "track-plan",
  tracks: [
    { active: true, events: [{ note: 60 }, { note: 61 }, { note: 62 }], startIndex: 2 },
    { active: true, events: [{ note: 70 }, { note: 71 }, { note: 72 }, { note: 73 }], startIndex: 1 },
  ],
};
const id3 = { id: "transport-3", version: 3, mode: "track-plan", scope: "song" };
audio.updatePlan(plan, id3);
assert.equal(posted.at(-1).type, "update-plan");
assert.equal(posted.at(-1).timelineTemplate.marker, 4);
assert.equal(posted.at(-1).executionTemplate.marker, 4);
assert.deepEqual(compileCalls[3].trackStartIndices.slice(0, 2), [2, 1]);

assert.equal(
  posted.some((message) => message.type === "timeline-position-request" || message.type === "timeline-position-snapshot"),
  false,
  "R1/R2 control plane must not introduce a position handshake or second clock",
);

// Control-plane preparation is transactional with respect to desired-program
// ownership. A failed K3 or R2 execution compile sends nothing and must not make
// later Tempo target a program that the Worklet never received.
const desiredBeforeFailure = sandbox.BRKTRKK3CTransportAdapter.desiredProgram();
const postedBeforeFailure = posted.length;
assert.throws(
  () => audio.play(sequence(2, 77), 666, { id: "failed-play", version: 4, mode: "sequence", scope: "phrase" }),
  /fixture preparation failure/,
);
assert.equal(sandbox.BRKTRKK3CTransportAdapter.desiredProgram(), desiredBeforeFailure);
assert.equal(posted.length, postedBeforeFailure);
const executionProgram = { mode: "track-plan", failExecution: true, tracks: [] };
assert.throws(
  () => audio.updatePlan(executionProgram, { id: "failed-r2", version: 5, mode: "track-plan", scope: "song" }),
  /fixture execution preparation failure/,
);
assert.equal(sandbox.BRKTRKK3CTransportAdapter.desiredProgram(), desiredBeforeFailure);
assert.equal(posted.length, postedBeforeFailure);

// After a registry-boundary deferral, Tempo must compile the retained applied
// program rather than a new Instrument/scope which the Worklet never admitted.
for (const retained of [{ mode: "sequence", steps: sequence(3, 72) }, plan]) {
  appliedProgram = retained;
  onTransport({ target: "transport.program.deferred" });
  const desired = sandbox.BRKTRKK3CTransportAdapter.desiredProgram();
  assert.equal(desired.mode, retained.mode);
  if (retained.mode === "sequence") assert.equal(desired.steps, retained.steps);
  else assert.equal(desired, retained);
  audio.tempo(100);
  assert.equal(compileCalls.at(-1).mode, retained.mode);
  assert.equal(posted.at(-1).type, "tempo");
}

// A tempo edit queued before the update's port response must wait for the
// correlated result. Both accepted and deferred updates compile only the final
// applied program; rapid tempo edits collapse to the latest value.
for (const target of ["transport.program.deferred", "transport.program.applied"]) {
  const retained = { mode: "sequence", steps: sequence(3, 72) };
  const requested = { mode: "sequence", steps: sequence(5, 77) };
  const oldId = { id: "tempo-old", version: 20 };
  const newId = { id: "tempo-new", version: 21 };
  appliedProgram = retained;
  transportSnapshot = { playing: true, applied: oldId, requested: newId };
  audio.updateSequence(requested.steps, newId);
  const count = posted.length;
  audio.tempo(88);
  audio.tempo(89);
  assert.equal(posted.length, count, "Tempo waits while the program outcome is unresolved");
  appliedProgram = target.endsWith("deferred") ? retained : requested;
  const resolvedId = target.endsWith("deferred") ? oldId : newId;
  transportSnapshot = { playing: true, applied: resolvedId, requested: resolvedId };
  onTransport({ target });
  assert.equal(posted.length, count + 1);
  assert.equal(posted.at(-1).value, 89);
  assert.equal(sandbox.BRKTRKK3CTransportAdapter.desiredProgram().steps, appliedProgram.steps);
}
transportSnapshot = null;

// STOP drops desired program ownership. A later tempo edit uses the inherited
// compatibility path rather than inventing a prepared playback template.
audio.stop(id3);
assert.equal(legacyStop, id3);
assert.equal(sandbox.BRKTRKK3CTransportAdapter.desiredProgram(), null);
const countAfterStop = posted.length;
audio.tempo(77);
assert.equal(legacyTempo, 77);
assert.equal(posted.length, countAfterStop);

assert.equal(sandbox.document.body.dataset.timelineArchitecture, "k3c");
assert.equal(sandbox.document.body.dataset.timelinePreparation, "r1-prepared-exact-bind");
assert.equal(sandbox.document.body.dataset.executionPreparation, "r2-prepared-lifecycle");
console.log("K3 R2 lexical-facade + transactional Transport timeline/execution preparation tests passed");
