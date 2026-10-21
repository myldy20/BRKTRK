const assert = require("node:assert/strict");
const renderer = require("./occurrence-context-renderer.js");

const chainA = {
  activeWorkspace: "chain", view: "chain", dock: "mix",
  focus: { pane: "chain", row: 0, col: 0 },
  songRow: 0, track: 0, chain: 0, chainRow: 0,
  phrase: 0, phraseRow: 0, instrument: 2, soundParam: 0,
};
const chainB = { ...chainA, songRow: 4, track: 1 };
const sameChain = renderer.resolveContexts({ before: chainA, after: chainB });
assert.equal(sameChain.before.songRow, 0);
assert.equal(sameChain.after.track, 1);
assert.deepEqual(renderer.dependencies(sameChain.before, sameChain.after), {
  workspace: false, focus: false, track: true, chain: false,
  phrase: false, instrument: false,
});

const phraseB = {
  ...chainB,
  activeWorkspace: "phrase", view: "phrase",
  focus: { pane: "phrase", row: 7, col: 2 },
  chainRow: 3, phrase: 1, phraseRow: 7, instrument: 5,
};
const changedPhrase = renderer.resolveContexts({
  before: { context: { ...phraseB, chainRow: 0, phrase: 0, instrument: 2 } },
  after: { context: phraseB },
});
assert.deepEqual(renderer.dependencies(changedPhrase.before, changedPhrase.after), {
  workspace: false, focus: false, track: false, chain: true,
  phrase: true, instrument: true,
});
console.log("G6 occurrence context dependency tests passed");
