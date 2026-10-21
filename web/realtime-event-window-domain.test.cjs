const assert = require("node:assert/strict");
const test = require("node:test");
const domain = require("./realtime-event-window-domain.js");

function packet(frame, count) {
  return Object.freeze({
    frame,
    events: Object.freeze(Array.from({ length: count }, (_, ordinal) => Object.freeze({ frame, ordinal }))),
  });
}

test("K4B accepts exact packet/event capacities and retains packet identity", () => {
  const window = domain.createRealtimeEventWindow({ packetCapacity: 2, eventCapacity: 4, sameFrameEventCapacity: 3 });
  const first = packet(100, 1);
  const second = packet(101, 3);
  window.begin(100, 64);
  assert.equal(window.push(first), first);
  assert.equal(window.push(second), second);
  assert.equal(window.packetCount, 2);
  assert.equal(window.eventCount, 4);
  assert.equal(window.packetAt(0), first);
  assert.equal(window.packetAt(1), second);
  window.finish();
});

test("K4B rejects a whole offending packet deterministically above capacity", () => {
  const window = domain.createRealtimeEventWindow({ packetCapacity: 2, eventCapacity: 3, sameFrameEventCapacity: 3 });
  const first = packet(200, 2);
  const overflow = packet(201, 2);
  window.begin(200, 64);
  window.push(first);
  assert.throws(() => window.push(overflow), (error) => error.code === "event-overrun");
  assert.equal(window.packetCount, 1);
  assert.equal(window.eventCount, 2);
  assert.equal(window.packetAt(0), first);
  assert.equal(window.overrunCount, 1);
});

test("K4B enforces same-frame and packet capacities without partial insertion", () => {
  const sameFrame = domain.createRealtimeEventWindow({ packetCapacity: 4, eventCapacity: 8, sameFrameEventCapacity: 2 });
  sameFrame.begin(300, 64);
  assert.throws(() => sameFrame.push(packet(300, 3)), (error) => error.code === "same-frame-overrun");
  assert.equal(sameFrame.packetCount, 0);
  assert.equal(sameFrame.eventCount, 0);

  const packets = domain.createRealtimeEventWindow({ packetCapacity: 1, eventCapacity: 8, sameFrameEventCapacity: 8 });
  packets.begin(400, 64);
  packets.push(packet(400, 1));
  assert.throws(() => packets.push(packet(401, 1)), (error) => error.code === "packet-overrun");
  assert.equal(packets.packetCount, 1);
});

test("K4B records late, underrun and overlap diagnostics without changing packet order", () => {
  const window = domain.createRealtimeEventWindow({ packetCapacity: 4, eventCapacity: 8, sameFrameEventCapacity: 8 });
  window.begin(500, 64);
  assert.throws(() => window.push(packet(499, 1)), (error) => error.code === "late-event");
  assert.equal(window.lateEventCount, 1);
  window.finish();

  window.begin(600, 32);
  assert.equal(window.underrunCount, 1);
  assert.equal(window.lastUnderrunFrames, 36);
  window.finish();

  window.begin(620, 16);
  assert.equal(window.renderOverlapCount, 1);
  assert.equal(window.lastRenderOverlapFrames, 12);
});

test("K4B uses actual variable render-block lengths", () => {
  const window = domain.createRealtimeEventWindow();
  let start = 0;
  for (const frameCount of [64, 128, 257, 512, 1024]) {
    window.begin(start, frameCount);
    assert.equal(window.startFrame, start);
    assert.equal(window.endFrame, start + frameCount);
    assert.equal(window.frameCount, frameCount);
    window.finish();
    start += frameCount;
  }
  assert.equal(window.underrunCount, 0);
  assert.equal(window.renderOverlapCount, 0);
});

test("K4B budget is declarative and validated", () => {
  const budget = domain.normalizeBudget({ qualityTier: "eco", packetCapacity: 7, eventCapacity: 11, sameFrameEventCapacity: 5 });
  assert.deepEqual(budget, {
    windowVersion: 1,
    qualityTier: "eco",
    packetCapacity: 7,
    eventCapacity: 11,
    sameFrameEventCapacity: 5,
  });
  assert.ok(Object.isFrozen(budget));
  assert.throws(() => domain.normalizeBudget({ packetCapacity: 0 }), RangeError);
  assert.throws(() => domain.normalizeBudget({ eventCapacity: 1.5 }), RangeError);
});
