const assert = require("node:assert/strict");
const { createSynthGateway } = require("./synth-gateway-domain.js");

const actions = [];
const makeSlot = (track, instrumentId) => ({
  track,
  instrumentId,
  engine: { manifest: { parameters: [{ id: "cutoff" }] } },
  performer: {
    handleEvent(action) { actions.push({ track, instrumentId, ...action }); },
    process() {},
  },
});
const slots = [makeSlot(0, 3), makeSlot(0, 7), makeSlot(1, 3)];
const performerRegistry = {
  prepared(track, instrumentId) {
    return slots.find((slot) => slot.track === track && slot.instrumentId === instrumentId) ?? null;
  },
  forEachTrack(track, visit) {
    for (const slot of slots) if (slot.track === track) visit(slot);
  },
  applyState() { return true; },
  diagnostics() { return { slotCapacity: 2048, preparedCount: slots.length }; },
};

const gateway = createSynthGateway({ performerRegistry, sampleRate: 48000, maxEventsPerBlock: 32 });
gateway.beginBlock(1000, 8);
assert.equal(gateway.applyParameter(0, 3, "cutoff", 0.42, 2, 16), true);
assert.equal(gateway.kill(0, 3, 3), true);
assert.equal(gateway.allNotesOff(0, 7, 4), true);
assert.equal(gateway.reset(1, 3, 5), true);
assert.equal(gateway.allNotesOff(0, null, 6), 2, "track-wide All Notes Off must reach every prepared performer on that Track");
assert.equal(gateway.reset(0, null, 7), 2, "track-wide Reset must reach every prepared performer on that Track");
assert.equal(gateway.kill(7, 99, 0), false, "control action for an unavailable performer must fail silent");
assert.throws(() => gateway.applyParameter(0, 3, "unknown", 1, 0), /unknown stable parameter id/);
assert.throws(() => gateway.applyParameter(0, 3, "cutoff", 1, 8), /outside active block/);
gateway.endBlock();

const parameter = actions.find((action) => action.type === "parameter");
assert.deepEqual(
  { sampleOffset: parameter.sampleOffset, parameterId: parameter.parameterId, value: parameter.value, rampFrames: parameter.rampFrames },
  { sampleOffset: 2, parameterId: "cutoff", value: 0.42, rampFrames: 16 },
  "stable parameter events must preserve value, sample offset and ramp length",
);
assert.ok(actions.some((action) => action.type === "kill" && action.sampleOffset === 3));
assert.ok(actions.some((action) => action.type === "all-notes-off" && action.instrumentId === 7 && action.sampleOffset === 4));
assert.ok(actions.some((action) => action.type === "reset" && action.track === 1 && action.sampleOffset === 5));
assert.equal(actions.filter((action) => action.type === "all-notes-off" && action.sampleOffset === 6).length, 2);
assert.equal(actions.filter((action) => action.type === "reset" && action.sampleOffset === 7).length, 2);

console.log("M5A A2 complete synth control vocabulary passed");
