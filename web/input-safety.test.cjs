const assert = require("node:assert/strict");
const { shouldIgnoreKeyDown } = require("./input-safety.js");

const held = new Set(["KeyZ"]);
assert.equal(shouldIgnoreKeyDown("ArrowRight", true, held), true, "held hierarchy arrows must not auto-repeat through workspaces");
assert.equal(shouldIgnoreKeyDown("ArrowRight", false, held), false);
assert.equal(shouldIgnoreKeyDown("ArrowRight", true, new Set(["KeyS"])), false, "field editing repeat remains available");
assert.equal(shouldIgnoreKeyDown("KeyX", true, held), false);
console.log("P3.2 input-safety tests passed");
