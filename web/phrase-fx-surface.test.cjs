const assert = require('node:assert/strict');
const surface = require('./phrase-fx-surface.js');

assert.equal(surface.FX_SLOTS, 3);
assert.equal(surface.FIRST_FX_COL, 3);
assert.equal(surface.PHRASE_COLS, 9);

const expected = [
  [3, 0, 'command'],
  [4, 0, 'value'],
  [5, 1, 'command'],
  [6, 1, 'value'],
  [7, 2, 'command'],
  [8, 2, 'value'],
];
for (const [col, slotIndex, component] of expected) {
  assert.deepEqual(surface.describePhraseColumn(col), { slotIndex, component });
}

assert.equal(surface.describePhraseColumn(2), null);
assert.equal(surface.describePhraseColumn(9), null);
assert.equal(surface.commandColumn(0), 3);
assert.equal(surface.valueColumn(0), 4);
assert.equal(surface.commandColumn(2), 7);
assert.equal(surface.valueColumn(2), 8);

console.log('M4.1B explicit Phrase FX command/value surface mapping tests passed');
