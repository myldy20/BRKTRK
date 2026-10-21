const assert = require("node:assert/strict");
const renderer = require("./mix-context-renderer.js");

const origin = {
  activeWorkspace: "sound",
  view: "sound",
  dock: "sound",
  focus: { pane: "phrase", row: 6, col: 2 },
  songRow: 0,
  track: 3,
  chain: 1,
  chainRow: 2,
  phrase: 7,
  phraseRow: 6,
  instrument: 5,
  soundParam: 4,
};
const mix = { ...origin, activeWorkspace: "mix", view: "mix", dock: "mix" };
const open = renderer.resolveContexts({
  before: { context: origin, returnContext: null },
  after: { context: mix, returnContext: origin },
});
assert.equal(open.before.activeWorkspace, "sound");
assert.equal(open.after.activeWorkspace, "mix");
assert.deepEqual(renderer.dependencies(open.before, open.after), {
  workspace: true,
  dock: true,
  focus: false,
  track: false,
  chain: false,
  phrase: false,
  instrument: false,
});

const returned = renderer.resolveContexts({
  contextBefore: mix,
  contextAfter: origin,
});
assert.equal(returned.after.focus.row, 6);
assert.equal(returned.after.instrument, 5);
assert.equal(returned.after.soundParam, 4);
assert.deepEqual(renderer.dependencies(returned.before, returned.after), {
  workspace: true,
  dock: true,
  focus: false,
  track: false,
  chain: false,
  phrase: false,
  instrument: false,
});
console.log("G5 Mix context dependency tests passed");
