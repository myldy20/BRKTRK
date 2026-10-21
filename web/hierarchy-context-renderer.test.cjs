const assert = require("node:assert/strict");
const renderer = require("./hierarchy-context-renderer.js");

const mutation = {
  before: { context: { activeWorkspace: "song", view: "song", dock: "mix", chain: 0, phrase: 0, instrument: 0, track: 0, songRow: 0, focus: { pane: "song", row: 0, col: 0 } } },
  after: { context: { activeWorkspace: "chain", view: "chain", dock: "mix", chain: 1, phrase: 2, instrument: 0, track: 1, songRow: 4, focus: { pane: "chain", row: 3, col: 0 } } },
};
const contexts = renderer.resolveContexts(mutation);
assert.equal(contexts.before.activeWorkspace, "song");
assert.equal(contexts.after.activeWorkspace, "chain");
const changed = renderer.dependencies(contexts.before, contexts.after);
assert.deepEqual(changed, {
  chain: true,
  phrase: true,
  instrument: false,
  workspace: true,
  focus: true,
  track: true,
});

const sound = renderer.dependencies(
  { activeWorkspace: "phrase", view: "phrase", dock: "mix", chain: 1, phrase: 2, instrument: 0, track: 1, songRow: 4, focus: { pane: "phrase", row: 8, col: 2 } },
  { activeWorkspace: "sound", view: "sound", dock: "sound", chain: 1, phrase: 2, instrument: 7, track: 1, songRow: 4, focus: { pane: "phrase", row: 8, col: 2 } },
);
assert.equal(sound.chain, false);
assert.equal(sound.phrase, false);
assert.equal(sound.instrument, true);
assert.equal(sound.workspace, true);
assert.equal(sound.focus, false);
console.log("G4 hierarchy dependency tests passed");
