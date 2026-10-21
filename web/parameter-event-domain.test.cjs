const assert = require("node:assert/strict");
const events = require("./parameter-event-domain.js");

assert.deepEqual(events.serializeParameterEvents(), []);
assert.deepEqual(events.serializeParameterEvents([
  { instrumentId: 9, parameterId: "filter.cutoff", value: 0.7, interpolationOut: "linear" },
  { instrumentId: 2, parameterId: "amp.gain", value: true },
]), [
  { instrumentId: 2, parameterId: "amp.gain", value: true, interpolationOut: "step" },
  { instrumentId: 9, parameterId: "filter.cutoff", value: 0.7, interpolationOut: "linear" },
], "ParameterEvents must serialize in stable target order");

assert.equal(events.parameterTargetKey(2, " amp.gain "), "2\u0000amp.gain");
assert.throws(() => events.serializeParameterEvents({}), /must be an array/);
assert.throws(() => events.serializeParameterEvents([
  { instrumentId: 2, parameterId: "amp.gain", value: 0.4 },
  { instrumentId: 2, parameterId: "amp.gain", value: 0.5 },
]), /duplicate target/);
assert.throws(() => events.serializeParameterEvents([
  { instrumentId: 256, parameterId: "amp.gain", value: 0.4 },
]), /0 and 255/);
for (const missing of [undefined, null, "", "  "]) {
  assert.throws(() => events.serializeParameterEvents([
    { instrumentId: missing, parameterId: "amp.gain", value: 0.4 },
  ]), /instrumentId must be an integer between 0 and 255/,
  "a missing target must never silently point at Instrument 00");
}
assert.throws(() => events.parameterTargetKey(null, "amp.gain"), /instrumentId must be an integer/);
assert.throws(() => events.serializeParameterEvents([
  { instrumentId: 2, parameterId: "", value: 0.4 },
]), /must not be empty/);
assert.throws(() => events.serializeParameterEvents([
  { instrumentId: 2, parameterId: "amp.gain", value: { nested: true } },
]), /JSON scalar/);
assert.throws(() => events.serializeParameterEvents([
  { instrumentId: 2, parameterId: "amp.gain", value: 0.4, interpolationOut: "curve" },
]), /step or linear/);
assert.throws(() => events.serializeParameterEvents(
  Array.from({ length: 9 }, (_, index) => ({ instrumentId: index, parameterId: "p", value: index })),
), /maximum of 8/);

console.log("PE0 ParameterEvent durable-domain tests passed");
