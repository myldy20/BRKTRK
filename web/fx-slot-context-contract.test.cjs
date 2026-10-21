const assert = require("node:assert/strict");
const fx = require("./phrase-fx-domain.js");
const storage = require("./project-storage.js");

const phraseSlots = storage.normalizeFxSlots([
  { command: 4, value: 0x20 },
  { command: 5, value: 0x10 },
  { command: 0xE1, value: 0xA0 },
]);
const futureTableSlots = storage.normalizeFxSlots([
  { command: 1, value: 0x08 },
  { command: 0xE2, value: 0xB1 },
  { command: 0, value: 0xFF },
]);

assert.deepEqual(phraseSlots, [
  { command: 4, value: 0x20 },
  { command: 5, value: 0x10 },
  { command: 0xE1, value: 0xA0 },
]);
assert.deepEqual(futureTableSlots, [
  { command: 1, value: 0x08 },
  { command: 0xE2, value: 0xB1 },
  { command: 0, value: 0 },
]);

for (const slot of [...phraseSlots, ...futureTableSlots]) {
  assert.deepEqual(fx.serializeSlot(slot), slot, "the semantic registry and persisted slot codec must agree on command/value shape");
}

assert.equal(storage.FX_SLOTS, fx.SLOT_COUNT);
assert.ok(
  Number.isInteger(storage.CURRENT_SCHEMA_VERSION) && storage.CURRENT_SCHEMA_VERSION >= 2,
  "context-neutral compound FX slots must remain supported by the current Project schema after later schema evolution",
);
console.log(`M4.1B context-neutral Phrase/Table FX slot contract tests passed on Project schema v${storage.CURRENT_SCHEMA_VERSION}`);
