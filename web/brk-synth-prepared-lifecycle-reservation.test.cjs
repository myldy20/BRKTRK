const assert = require("node:assert/strict");

class BrkSynthAbiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const handled = [];
let fakePending = 0;
const capacity = 2;
const fakeModule = {
  HEAPU8: new Uint8Array(128),
  _malloc() { return 16; },
  _free() {},
  _brk_instance_deactivate() { return 0; },
  _brk_instance_state_read() { return 0; },
  _brk_instance_activate() { return 0; },
};
const record = {
  module: fakeModule,
  manifest: { stateBytes: 4, stateSchemaVersion: 1 },
};

const fakeBaseRuntime = Object.freeze({
  DEFAULT_MAX_EVENTS_PER_PERFORMER: capacity,
  BrkSynthAbiError,
  createPerformerFactory() {
    function makePerformer() {
      return Object.freeze({
        preflightPreparedLifecycle(type, sampleOffset, pitch) {
          if (!["note-off", "note-on", "retrigger"].includes(type)) throw new RangeError("type");
          if (!Number.isInteger(Number(sampleOffset)) || Number(sampleOffset) < 0) throw new RangeError("offset");
          if (!Number.isFinite(Number(pitch))) throw new RangeError("pitch");
          if (fakePending >= capacity) throw new BrkSynthAbiError("event-capacity", `base capacity ${capacity} exceeded`);
          return true;
        },
        handlePreparedLifecycle(type, sampleOffset, pitch, velocity) {
          this.preflightPreparedLifecycle(type, sampleOffset, pitch, velocity);
          fakePending += 1;
          handled.push({ type, sampleOffset, pitch, velocity });
          return true;
        },
        process() { fakePending = 0; return true; },
        reset() { fakePending = 0; return true; },
        destroy() {},
        diagnostics() { return Object.freeze({ handle: 1, preparedLifecyclePending: fakePending }); },
      });
    }
    makePerformer.diagnostics = () => Object.freeze({ livePerformers: 1 });
    return Object.freeze(makePerformer);
  },
});

globalThis.BRKTRKBrkSynthAbiV1Runtime = fakeBaseRuntime;
const extended = require("./brk-synth-prepared-state-extension.js");
const factory = extended.createPerformerFactory(record, { maxEventsPerPerformer: capacity });
const performer = factory({ track: 0, instrumentId: 0 });

// Leave exactly one slot free, then demand a two-event replacement pair.
performer.handlePreparedLifecycle("note-on", 10, 48, 100);
assert.equal(handled.length, 1);
assert.throws(
  () => performer.reservePreparedLifecyclePair(
    "note-off", 20, 48, 100,
    "note-on", 20, 60, 100,
  ),
  /prepared lifecycle capacity 2 exceeded by bounded reservation/,
);
assert.equal(handled.length, 1, "aggregate capacity rejection must not commit NOTE_OFF");
assert.equal(performer.diagnostics().preparedLifecycleReserved, 0);
assert.equal(performer.diagnostics().preparedLifecyclePending, 1);

// With two free slots the same reservation commits in deterministic OFF→ON
// order through the existing primitive performer lifecycle methods.
performer.reset();
handled.length = 0;
const token = performer.reservePreparedLifecyclePair(
  "note-off", 20, 48, 100,
  "note-on", 20, 60, 90,
);
assert.equal(performer.diagnostics().preparedLifecycleReserved, 2);
assert.equal(handled.length, 0, "reservation phase must not mutate performer lifecycle state");
assert.equal(performer.commitPreparedLifecycleReservation(token), 2);
assert.deepEqual(handled, [
  { type: "note-off", sampleOffset: 20, pitch: 48, velocity: 100 },
  { type: "note-on", sampleOffset: 20, pitch: 60, velocity: 90 },
]);
assert.equal(performer.diagnostics().preparedLifecyclePending, 2);
assert.equal(performer.diagnostics().preparedLifecycleReserved, 0);

performer.reset();
handled.length = 0;
assert.throws(
  () => performer.reservePreparedLifecyclePair(
    "note-on", 30, 60, 90,
    "note-off", 30, 60, 90,
  ),
  /non-decreasing sampleOffset\/priority order/,
);
assert.deepEqual(handled, []);

console.log("BRK prepared lifecycle bounded reservation tests passed");
