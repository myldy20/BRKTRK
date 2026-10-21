const assert = require("node:assert/strict");
const transactions = require("./prepared-entry-transaction.js");

const record = transactions.create({
  phrase: 0x2A,
  row: 7,
  before: { note: -1, velocity: 41, instrument: 3 },
  note: 60,
  velocity: 96,
  instrument: 10,
});

assert.equal(record.kind, "prepared-note-entry");
assert.equal(record.target, "phrase.step");
assert.equal(record.phrase, 0x2A);
assert.equal(record.row, 7);
assert.deepEqual(record.fields, ["note", "velocity", "instrument"]);
assert.deepEqual(record.before, { note: -1, velocity: 41, instrument: 3 });
assert.deepEqual(record.after, { note: 60, velocity: 96, instrument: 10 });
assert(Object.isFrozen(record));
assert(Object.isFrozen(record.before));
assert(Object.isFrozen(record.after));

const fallback = transactions.create({
  phrase: 0,
  row: 0,
  before: { note: 48, velocity: 100, instrument: 1 },
  note: 49,
  velocity: 300,
  instrument: -1,
});
assert.deepEqual(fallback.after, { note: 49, velocity: 127, instrument: -1 });

console.log("P3.4 prepared entry transaction tests passed");
