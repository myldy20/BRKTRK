const assert = require("node:assert/strict");

const commits = [];

function createReservationPerformer(name, initialCapacity = 8) {
  let capacity = initialCapacity;
  let pending = 0;
  let token = 0;
  let reserved = null;

  return Object.freeze({
    setCapacity(value) { capacity = value; },
    setPending(value) { pending = value; },
    resetPrepared() { pending = 0; reserved = null; },
    reservationCount() { return reserved?.events.length ?? 0; },
    preflightPreparedLifecycle() {
      if (pending >= capacity) throw new RangeError(`${name} primitive capacity ${capacity} exceeded`);
      return true;
    },
    handlePreparedLifecycle(type, sampleOffset, pitch, velocity) {
      if (pending >= capacity) throw new RangeError(`${name} primitive capacity ${capacity} exceeded`);
      pending += 1;
      commits.push({ performer: name, type, sampleOffset, pitch, velocity });
      return true;
    },
    reservePreparedLifecyclePair(type0, offset0, pitch0, velocity0, type1 = null, offset1 = 0, pitch1 = 0, velocity1 = 100) {
      if (reserved) throw new Error(`${name} reservation already active`);
      const events = [{ type: type0, sampleOffset: offset0, pitch: pitch0, velocity: velocity0 }];
      if (type1 !== null && type1 !== undefined) events.push({ type: type1, sampleOffset: offset1, pitch: pitch1, velocity: velocity1 });
      if (pending + events.length > capacity) throw new RangeError(`${name} pair capacity ${capacity} exceeded`);
      token += 1;
      reserved = { token, events };
      return token;
    },
    cancelPreparedLifecycleReservation(activeToken) {
      if (!reserved || reserved.token !== activeToken) throw new Error(`${name} reservation token mismatch`);
      reserved = null;
      return true;
    },
    commitPreparedLifecycleReservation(activeToken) {
      if (!reserved || reserved.token !== activeToken) throw new Error(`${name} reservation token mismatch`);
      const events = reserved.events;
      reserved = null;
      for (const event of events) {
        if (pending >= capacity) throw new RangeError(`${name} unexpected commit capacity failure`);
        pending += 1;
        commits.push({ performer: name, ...event });
      }
      return events.length;
    },
  });
}

const performer0 = createReservationPerformer("p0", 8);
const performer1 = createReservationPerformer("p1", 8);
const performerRegistry = Object.freeze({
  prepared(track, instrumentId) {
    if (track !== 0) return null;
    if (instrumentId === 0) return Object.freeze({ track, instrumentId, performer: performer0 });
    if (instrumentId === 1) return Object.freeze({ track, instrumentId, performer: performer1 });
    return null;
  },
  forEachTrack() {},
  diagnostics() { return Object.freeze({}); },
});

globalThis.BRKTRKSynthGatewayDomain = undefined;
const gatewayDomain = require("./synth-gateway-domain.js");
const gateway = gatewayDomain.createSynthGateway({ performerRegistry, maxEventsPerBlock: 2 });

// Performer boundary: the same performer has only one free prepared lifecycle
// slot, but replacement demands two. Gateway budget must remain untouched and
// no NOTE_OFF may commit.
gateway.beginBlock(0, 128);
performer0.setCapacity(1);
performer0.setPending(0);
assert.throws(
  () => gateway.routePreparedLifecyclePair(10, 0, 0, 48, 100, 0, 60, 90),
  /p0 pair capacity 1 exceeded/,
);
assert.deepEqual(commits, []);
assert.equal(gateway.diagnostics().eventCount, 0);
assert.equal(performer0.reservationCount(), 0);
gateway.endBlock();

// Cross-performer boundary: release reservation succeeds, destination trigger
// reservation fails, and the first reservation is cancelled before any commit.
performer0.setCapacity(8);
performer0.resetPrepared();
performer1.setCapacity(1);
performer1.setPending(1);
gateway.beginBlock(128, 128);
assert.throws(
  () => gateway.routePreparedLifecyclePair(140, 0, 0, 48, 100, 1, 67, 80),
  /p1 pair capacity 1 exceeded/,
);
assert.deepEqual(commits, []);
assert.equal(gateway.diagnostics().eventCount, 0);
assert.equal(performer0.reservationCount(), 0, "release performer reservation must be cancelled when trigger preflight fails");
assert.equal(performer1.reservationCount(), 0);
gateway.endBlock();

// Gateway boundary: consume one of two event slots first. Both performer
// reservations can succeed, but aggregate gateway reserve(2) must fail and
// cancel them without committing the release.
performer0.resetPrepared();
performer1.resetPrepared();
performer1.setCapacity(8);
gateway.beginBlock(256, 128);
assert.equal(gateway.routePreparedLifecycle(260, 0, 0, "note-on", 48, 100), 1);
commits.length = 0;
assert.throws(
  () => gateway.routePreparedLifecyclePair(270, 0, 0, 48, 100, 1, 67, 80),
  /SynthGateway event demand exceeded 2/,
);
assert.deepEqual(commits, [], "gateway capacity rejection must happen before replacement NOTE_OFF commit");
assert.equal(gateway.diagnostics().eventCount, 1, "failed pair must not consume partial gateway budget");
assert.equal(performer0.reservationCount(), 0);
assert.equal(performer1.reservationCount(), 0);
gateway.endBlock();

// Success path: cross-Instrument replacement commits addressable release first,
// then trigger, and consumes exactly two gateway events.
performer0.resetPrepared();
performer1.resetPrepared();
commits.length = 0;
gateway.beginBlock(384, 128);
assert.equal(gateway.routePreparedLifecyclePair(400, 0, 0, 48, 100, 1, 67, 80), true);
assert.deepEqual(commits, [
  { performer: "p0", type: "note-off", sampleOffset: 16, pitch: 48, velocity: 100 },
  { performer: "p1", type: "note-on", sampleOffset: 16, pitch: 67, velocity: 80 },
]);
assert.equal(gateway.diagnostics().eventCount, 2);
gateway.endBlock();

console.log("SynthGateway prepared lifecycle pair atomic-capacity tests passed");
