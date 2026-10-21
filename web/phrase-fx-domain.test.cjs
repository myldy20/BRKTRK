const assert = require("node:assert/strict");
const fx = require("./phrase-fx-domain.js");

assert.equal(fx.SLOT_COUNT, 3);
assert.equal(fx.SLOT_VERSION, 1);
assert.equal(fx.assertRegistry(), true);

{
  const entries = fx.registry();
  assert.deepEqual(entries.map(({ id, code }) => [id, code]), [
    ["none", 0x00],
    ["cut", 0x01],
    ["delay", 0x04],
    ["retrigger", 0x05],
  ]);
  assert.ok(entries.every(Object.isFrozen));
  assert.equal(fx.commandDescriptor("cut").runtimeStatus, "active");
  assert.equal(fx.commandDescriptor("delay").runtimeStatus, "active");
  assert.equal(fx.commandDescriptor("retrigger").runtimeStatus, "partial");
}

{
  const none = fx.createSlot("none", 0x7F);
  assert.deepEqual(none, {
    slotVersion: 1,
    commandCode: 0,
    commandId: "none",
    value: 0,
    known: true,
    runtimeStatus: "empty",
  });
  assert.ok(Object.isFrozen(none));
}

{
  const delay = fx.createSlot("delay", 0xAB);
  assert.equal(delay.commandCode, 0x04);
  assert.equal(delay.commandId, "delay");
  assert.equal(delay.value, 0xAB);
  assert.equal(delay.runtimeStatus, "active");
  assert.deepEqual(fx.serializeSlot(delay), { command: 0x04, value: 0xAB });
}

{
  const legacy = fx.migrateLegacySlots([0x01, 0x04, 0xA7]);
  assert.equal(legacy.lossy, false);
  assert.equal(legacy.slots.length, 3);
  assert.deepEqual(legacy.slots.map((slot) => slot.commandCode), [0x01, 0x04, 0xA7]);
  assert.deepEqual(legacy.slots.map((slot) => slot.value), [0, 0, 0]);
  assert.equal(legacy.slots[2].known, false);
  assert.equal(legacy.slots[2].runtimeStatus, "unknown-inert");
  assert.deepEqual(legacy.issues, [{
    kind: "unknown-legacy-command",
    slot: 2,
    commandCode: 0xA7,
    preserved: true,
  }]);
}

{
  const normalized = fx.normalizeSlots([
    { commandId: "cut", value: 0x12 },
    { command: 0x05, value: 0x34 },
  ]);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].commandCode, 0x01);
  assert.equal(normalized[0].value, 0x12);
  assert.equal(normalized[1].commandId, "retrigger");
  assert.equal(normalized[1].runtimeStatus, "partial");
  assert.equal(normalized[1].value, 0x34);
  assert.equal(normalized[2].commandId, "none");
  assert.ok(Object.isFrozen(normalized));
}

assert.throws(() => fx.createSlot("missing", 0), /Unknown FX command id/);
assert.throws(() => fx.createSlot(0x100, 0), /00-FF/);
assert.throws(() => fx.createSlot("cut", -1), /00-FF/);
assert.throws(() => fx.normalizeSlot({ value: 1 }), /requires command/);

console.log("M4.1A typed Phrase FX registry tests passed through M4.1C runtime-status convergence");
