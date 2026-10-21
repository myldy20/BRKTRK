const assert = require("node:assert/strict");
const timing = require("./timing-domain.js");
const lifecycle = require("./note-lifecycle-domain.js");

assert.equal(lifecycle.classifyIntent(null, false, false), lifecycle.INTENTS.EMPTY);
assert.equal(lifecycle.classifyIntent(-1, false, false), lifecycle.INTENTS.EMPTY);
assert.equal(lifecycle.classifyIntent(-2, false, false), lifecycle.INTENTS.RELEASE);
assert.equal(lifecycle.classifyIntent(60, true, false), lifecycle.INTENTS.RELEASE);
assert.equal(lifecycle.classifyIntent(60, false, true), lifecycle.INTENTS.RELEASE);
assert.equal(lifecycle.classifyIntent(60, false, false), lifecycle.INTENTS.TRIGGER);
assert.equal(lifecycle.parameterModeForIntent(lifecycle.INTENTS.EMPTY), lifecycle.PARAMETER_MODES.CARRY);
assert.equal(lifecycle.parameterModeForIntent(lifecycle.INTENTS.TRIGGER), lifecycle.PARAMETER_MODES.TRIGGER);
assert.equal(lifecycle.parameterModeForIntent(lifecycle.INTENTS.RELEASE), lifecycle.PARAMETER_MODES.NONE);
assert.equal(lifecycle.shouldApplyParameters(lifecycle.INTENTS.EMPTY, false), false);
assert.equal(lifecycle.shouldApplyParameters(lifecycle.INTENTS.EMPTY, true), true);
assert.equal(lifecycle.shouldApplyParameters(lifecycle.INTENTS.TRIGGER, false), true);
assert.equal(lifecycle.shouldApplyParameters(lifecycle.INTENTS.RELEASE, true), false);

const events = [
  { track: 0, note: 60, source: "phrase", sourceOrder: 0 },
  { track: 1, note: -2, source: "phrase", sourceOrder: 0 },
  { track: 2, note: null, source: "table", sourceOrder: 4 },
  { track: 3, note: 64, mute: true, source: "phrase", sourceOrder: 0 },
];
const trace = lifecycle.compileLifecycleTrace({ frame: 12345, events });
const reduced = trace.map((entry) => ({
  frame: entry.frame,
  phase: entry.phase,
  track: entry.track,
  sourceOrder: entry.sourceOrder,
  kind: entry.kind,
  mode: entry.data.mode ?? null,
}));
assert.deepEqual(reduced, [
  { frame: 12345, phase: timing.EVENT_PHASES.NOTE_RELEASE, track: 1, sourceOrder: 0, kind: lifecycle.ACTION_KINDS.NOTE_RELEASE, mode: null },
  { frame: 12345, phase: timing.EVENT_PHASES.NOTE_RELEASE, track: 3, sourceOrder: 0, kind: lifecycle.ACTION_KINDS.NOTE_RELEASE, mode: null },
  { frame: 12345, phase: timing.EVENT_PHASES.PARAMETER, track: 0, sourceOrder: 0, kind: lifecycle.ACTION_KINDS.PARAMETER_UPDATE, mode: lifecycle.PARAMETER_MODES.TRIGGER },
  { frame: 12345, phase: timing.EVENT_PHASES.PARAMETER, track: 2, sourceOrder: 4, kind: lifecycle.ACTION_KINDS.PARAMETER_UPDATE, mode: lifecycle.PARAMETER_MODES.CARRY },
  { frame: 12345, phase: timing.EVENT_PHASES.NOTE_TRIGGER, track: 0, sourceOrder: 0, kind: lifecycle.ACTION_KINDS.NOTE_TRIGGER, mode: null },
  { frame: 12345, phase: timing.EVENT_PHASES.OBSERVE, track: -1, sourceOrder: 0, kind: lifecycle.ACTION_KINDS.ROW_OBSERVE, mode: null },
]);
assert.equal(trace.find((entry) => entry.kind === lifecycle.ACTION_KINDS.NOTE_TRIGGER).data.resetsPhase, false);
assert.equal(trace.find((entry) => entry.track === 2).data.requiresActive, true);
const parameterUpdate = trace.find((entry) => entry.kind === lifecycle.ACTION_KINDS.PARAMETER_UPDATE);
for (const retiredField of ["wave", "gain", "pan"]) {
  assert.equal(Object.hasOwn(parameterUpdate.data, retiredField), false, `K2 parameter phase must not carry retired preview field ${retiredField}`);
}

const first = lifecycle.serializeLifecycleTrace(trace);
const second = lifecycle.serializeLifecycleTrace(lifecycle.compileLifecycleTrace({ frame: 12345, events }));
assert.equal(first, second, "identical lifecycle inputs must serialize byte-identically");
assert.ok(first.endsWith("\n"));

const sameTrack = lifecycle.compileLifecycleTrace({
  frame: 7,
  events: [
    { track: 0, source: "phrase", sourceOrder: 3, note: 60 },
    { track: 0, source: "table", sourceOrder: 1, note: 61 },
  ],
  includeObserve: false,
});
assert.deepEqual(
  sameTrack.map((entry) => [entry.phase, entry.sourceOrder, entry.kind]),
  [
    [timing.EVENT_PHASES.PARAMETER, 1, lifecycle.ACTION_KINDS.PARAMETER_UPDATE],
    [timing.EVENT_PHASES.PARAMETER, 3, lifecycle.ACTION_KINDS.PARAMETER_UPDATE],
    [timing.EVENT_PHASES.NOTE_TRIGGER, 1, lifecycle.ACTION_KINDS.NOTE_TRIGGER],
    [timing.EVENT_PHASES.NOTE_TRIGGER, 3, lifecycle.ACTION_KINDS.NOTE_TRIGGER],
  ],
  "source order must be stable inside one Track and phase",
);

assert.throws(() => lifecycle.compileLifecycleTrace({ frame: -1, events: [] }), /frame/);
assert.throws(() => lifecycle.compileLifecycleTrace({ frame: 0, events: {} }), /events/);

console.log("K2 deterministic production-neutral note lifecycle domain tests passed");
