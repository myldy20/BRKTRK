const assert = require("node:assert/strict");
const gatewayDomain = require("./synth-gateway-domain.js");

function fixture(maxEventsPerBlock = 4) {
  const calls = [];
  let accepted = 0;
  const performer = {
    preflightPreparedLifecycle(type, sampleOffset, pitch, velocity) {
      calls.push(["preflight", type, sampleOffset, pitch, velocity]);
      if (accepted >= 3) throw new RangeError("performer prepared capacity exceeded");
      return true;
    },
    handlePreparedLifecycle(type, sampleOffset, pitch, velocity) {
      calls.push(["commit", type, sampleOffset, pitch, velocity]);
      accepted += 1;
      return accepted;
    },
  };
  const slot = { track: 2, instrumentId: 3, performer };
  const performerRegistry = {
    prepared(track, instrumentId) { return track === 2 && instrumentId === 3 ? slot : null; },
    forEachTrack() {},
    diagnostics() { return null; },
  };
  const gateway = gatewayDomain.createSynthGateway({ performerRegistry, sampleRate: 48000, maxEventsPerBlock });
  return { gateway, calls, accepted: () => accepted };
}

const normal = fixture(4);
normal.gateway.beginBlock(1000, 64);
assert.equal(normal.gateway.routePreparedLifecycle(1005, 2, 3, "note-on", 64, 73), 1);
assert.equal(normal.gateway.routePreparedLifecycle(1010, 2, 3, "retrigger", 64, 73), 2);
assert.equal(normal.gateway.routePreparedLifecycle(1020, 2, 3, "note-off", -2, 1), 3);
assert.deepEqual(normal.calls, [
  ["preflight", "note-on", 5, 64, 73],
  ["commit", "note-on", 5, 64, 73],
  ["preflight", "retrigger", 10, 64, 73],
  ["commit", "retrigger", 10, 64, 73],
  ["preflight", "note-off", 20, -2, 1],
  ["commit", "note-off", 20, -2, 1],
]);
assert.equal(normal.gateway.diagnostics().eventCount, 3);
normal.gateway.endBlock();

const gatewayBounded = fixture(1);
gatewayBounded.gateway.beginBlock(2000, 64);
gatewayBounded.gateway.routePreparedLifecycle(2001, 2, 3, "note-on", 60, 100);
const committedBeforeGatewayOverflow = gatewayBounded.accepted();
assert.throws(
  () => gatewayBounded.gateway.routePreparedLifecycle(2002, 2, 3, "note-off", -2, 1),
  /event demand exceeded 1/,
);
assert.equal(gatewayBounded.accepted(), committedBeforeGatewayOverflow, "gateway overflow must fail before performer commit");
assert.equal(gatewayBounded.gateway.diagnostics().eventCount, 1);

const performerBounded = fixture(8);
performerBounded.gateway.beginBlock(3000, 64);
performerBounded.gateway.routePreparedLifecycle(3001, 2, 3, "note-on", 60, 100);
performerBounded.gateway.routePreparedLifecycle(3002, 2, 3, "retrigger", 60, 100);
performerBounded.gateway.routePreparedLifecycle(3003, 2, 3, "note-off", -2, 1);
const gatewayEventsBeforePerformerOverflow = performerBounded.gateway.diagnostics().eventCount;
assert.throws(
  () => performerBounded.gateway.routePreparedLifecycle(3004, 2, 3, "note-on", 61, 100),
  /performer prepared capacity exceeded/,
);
assert.equal(performerBounded.gateway.diagnostics().eventCount, gatewayEventsBeforePerformerOverflow, "performer preflight rejection must happen before gateway reserve");
assert.equal(performerBounded.accepted(), 3);

const unavailable = fixture(4);
unavailable.gateway.beginBlock(4000, 64);
assert.throws(
  () => unavailable.gateway.routePreparedLifecycle(4001, 1, 3, "note-on", 60, 100),
  /prepared lifecycle is unavailable/,
);
assert.equal(unavailable.gateway.diagnostics().eventCount, 0);

console.log("K3 R2 SynthGateway primitive prepared lifecycle preflight/commit tests passed");
