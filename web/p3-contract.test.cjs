const assert = require("node:assert/strict");
const contract = require("./p3-contract.js");

assert.deepEqual(contract.editIntent("ArrowRight"), { delta: 1, magnitude: "small" });
assert.deepEqual(contract.editIntent("ArrowLeft"), { delta: -1, magnitude: "small" });
assert.deepEqual(contract.editIntent("ArrowUp"), { delta: 1, magnitude: "large" });
assert.deepEqual(contract.editIntent("ArrowDown"), { delta: -1, magnitude: "large" });

assert.equal(contract.fieldStep("song", 0, "small"), 1);
assert.equal(contract.fieldStep("song", 0, "large"), 16);
assert.equal(contract.fieldStep("chain", 1, "large"), 12);
assert.equal(contract.fieldStep("phrase", 0, "large"), 12);
assert.equal(contract.fieldStep("phrase", 1, "large"), 10);
assert.equal(contract.fieldStep("phrase", 2, "large"), 16);
assert.equal(contract.fieldStep("phrase", 3, "large"), 4);

assert.deepEqual(
  contract.moveWithin("phrase", 0, 0, "ArrowLeft", { rows: 16, cols: 6 }),
  { pane: "phrase", row: 0, col: 0 },
);
assert.deepEqual(
  contract.moveWithin("chain", 15, 1, "ArrowDown", { rows: 16, cols: 2 }),
  { pane: "chain", row: 15, col: 1 },
);

assert.equal(contract.nextNoteSpecial(60, -1, -2), -1);
assert.equal(contract.nextNoteSpecial(-1, -1, -2), -2);
assert.equal(contract.nextNoteSpecial(-2, -1, -2), -1);
assert.equal(contract.noteFromPitchClass(4, 0), 60);
assert.equal(contract.noteFromPitchClass(4, 11), 71);

console.log("P3 contract tests passed");
