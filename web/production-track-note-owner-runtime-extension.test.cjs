const assert = require("node:assert/strict");

const calls = [];
let stopped = 0;
let pairFailure = null;
let activeSlots = [
  { track: 0, instrumentId: 0 },
  { track: 0, instrumentId: 1 },
  { track: 1, instrumentId: 1 },
];

const fakeBaseDomain = Object.freeze({
  DEFAULT_TRACK_COUNT: 8,
  MAX_BLOCK_FRAMES: 2048,
  createProductionAudioRuntime() {
    return Object.freeze({
      marker: "base-runtime",
      hasInstrument(id) { return id === 0 || id === 1; },
      beginBlock(_startFrame, frameCount) { return frameCount; },
      endBlock() { return calls.length; },
      routePreparedLifecycle(frame, track, instrumentId, type, note, velocity) {
        calls.push({ frame, track, instrumentId, type, note, velocity });
        return true;
      },
      routePreparedLifecyclePair(
        frame,
        track,
        releaseInstrumentId,
        releasePitch,
        releaseVelocity,
        triggerInstrumentId,
        triggerPitch,
        triggerVelocity,
      ) {
        if (pairFailure) throw pairFailure;
        calls.push({ frame, track, instrumentId: releaseInstrumentId, type: "note-off", note: releasePitch, velocity: releaseVelocity });
        calls.push({ frame, track, instrumentId: triggerInstrumentId, type: "note-on", note: triggerPitch, velocity: triggerVelocity });
        return true;
      },
      routeTracePacket() { throw new Error("owner extension must own legacy note routing"); },
      prepareProgram(program) { return { program }; },
      diagnostics() {
        return Object.freeze({
          performers: Object.freeze({ activeSlots: Object.freeze(activeSlots.map((slot) => Object.freeze({ ...slot }))) }),
        });
      },
      stop() { stopped += 1; },
    });
  },
});

globalThis.BRKTRKProductionAudioRuntime = fakeBaseDomain;
const extendedDomain = require("./production-track-note-owner-runtime-extension.js");
const runtime = extendedDomain.createProductionAudioRuntime({ trackCount: 2 });

assert.equal(runtime.marker, "base-runtime");
assert.equal(runtime.beginBlock(0, 2048), 2048);
assert.equal(runtime.routePreparedLifecycle(100, 0, 0, "note-on", 48, 110), true);
assert.deepEqual(calls.splice(0), [
  { frame: 100, track: 0, instrumentId: 0, type: "note-on", note: 48, velocity: 110 },
]);

// P1 owner regression: an upstream bounded-pair preflight rejection must occur
// before either primitive mutation and must leave the previous Track owner
// unchanged. The gateway/performer capacity boundary itself is covered by the
// dedicated reservation tests executed by the K2 gate.
pairFailure = new RangeError("prepared lifecycle capacity 2 exceeded by bounded reservation");
assert.throws(
  () => runtime.routePreparedLifecycle(150, 0, 0, "note-on", 59, 95),
  /capacity 2 exceeded/,
);
assert.deepEqual(calls, [], "pair rejection must happen before NOTE_OFF is committed");
assert.deepEqual(runtime.diagnostics().trackNoteOwnership.active, [
  { track: 0, instrumentId: 0, note: 48, velocity: 110 },
], "pair rejection must leave the previous Track active-note owner unchanged");
pairFailure = null;

assert.equal(runtime.routePreparedLifecycle(200, 0, 0, "note-on", 60, 90), true);
assert.deepEqual(calls.splice(0), [
  { frame: 200, track: 0, instrumentId: 0, type: "note-off", note: 48, velocity: 110 },
  { frame: 200, track: 0, instrumentId: 0, type: "note-on", note: 60, velocity: 90 },
], "a new tracker NOTE must release the prior Track note before the replacement NOTE_ON at the same sample");

assert.equal(runtime.routePreparedLifecycle(300, 0, 1, "note-on", 67, 70), true);
assert.deepEqual(calls.splice(0), [
  { frame: 300, track: 0, instrumentId: 0, type: "note-off", note: 60, velocity: 90 },
  { frame: 300, track: 0, instrumentId: 1, type: "note-on", note: 67, velocity: 70 },
], "changing Instrument on one Track must release the previous Track×Instrument performer without killing its release tail");

assert.equal(runtime.routePreparedLifecycle(340, 0, 0, "retrigger", 12, 1), true);
assert.deepEqual(calls.splice(0), [
  { frame: 340, track: 0, instrumentId: 1, type: "retrigger", note: 67, velocity: 70 },
], "RET must target the actual active Track note owner rather than a stale row Instrument");

assert.equal(runtime.routePreparedLifecycle(400, 0, 0, "note-off", -2, 1), true);
assert.deepEqual(calls.splice(0), [
  { frame: 400, track: 0, instrumentId: 1, type: "note-off", note: 67, velocity: 70 },
], "explicit OFF must release the actual active Track note owner");
assert.equal(runtime.routePreparedLifecycle(401, 0, 0, "note-off", -2, 1), false);
assert.deepEqual(calls, []);

const traceConsumed = runtime.routeTracePacket({
  events: [
    { ordinal: 1, frame: 500, track: 0, kind: "parameter", data: { instrumentId: 0 } },
    { ordinal: 2, frame: 500, track: 0, kind: "note-trigger", data: { instrumentId: 0, note: 55, velocity: 100 } },
    { ordinal: 3, frame: 600, track: 0, kind: "note-release", data: { instrumentId: -1, note: -2, velocity: 100 } },
  ],
});
assert.deepEqual([...traceConsumed], [1, 2, 3]);
assert.deepEqual(calls.splice(0), [
  { frame: 500, track: 0, instrumentId: 0, type: "note-on", note: 55, velocity: 100 },
  { frame: 600, track: 0, instrumentId: 0, type: "note-off", note: 55, velocity: 100 },
], "legacy/diagnostic K4 routing must share the same Track note-owner semantics");

runtime.routePreparedLifecycle(700, 0, 0, "note-on", 64, 80);
calls.length = 0;
activeSlots = [{ track: 0, instrumentId: 1 }, { track: 1, instrumentId: 1 }];
runtime.prepareProgram({ mode: "sequence", steps: [] });
assert.deepEqual(runtime.diagnostics().trackNoteOwnership.active, [], "program retirement must clear stale note ownership");

runtime.routePreparedLifecycle(800, 1, 1, "note-on", 72, 100);
assert.equal(runtime.diagnostics().trackNoteOwnership.active.length, 1);
runtime.stop();
assert.equal(stopped, 1);
assert.deepEqual(runtime.diagnostics().trackNoteOwnership.active, [], "Stop must clear Track note ownership");

assert.throws(() => runtime.routePreparedLifecycle(900, 2, 0, "note-on", 60, 100), /Track note owner/);
console.log("Production Track note-owner replacement lifecycle tests passed");
