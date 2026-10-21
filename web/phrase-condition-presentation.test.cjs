const assert = require("node:assert/strict");
const presentation = require("./phrase-condition-presentation.js");

assert.deepEqual(presentation.normalize(), { probability: 100, every: 1, offset: 0 });
assert.equal(presentation.active(), false);
assert.equal(presentation.badge(), "");
assert.equal(presentation.title(), "Condition · always");
assert.deepEqual(
  presentation.normalize({ probability: -5, every: 99, offset: 99 }),
  { probability: 0, every: 16, offset: 15 },
);
assert.equal(presentation.badge({ probability: 73, every: 1, offset: 0 }), "73%");
assert.equal(presentation.badge({ probability: 100, every: 4, offset: 2 }), "3/4");
assert.equal(presentation.badge({ probability: 73, every: 4, offset: 2 }), "73%·3/4");
assert.match(presentation.title({ probability: 73, every: 4, offset: 2 }), /iteration 3 of every 4/);
assert.equal(Object.isFrozen(presentation.normalize({})), true);
console.log("Phrase condition compact presentation tests passed");
