const assert = require("node:assert/strict");
const renderer = require("./workspace-context-renderer.js");

const phrase = {
  activeWorkspace: "phrase", view: "phrase", dock: "mix",
  focus: { pane: "phrase", row: 7, col: 2 },
  songRow: 4, track: 1, chain: 3, chainRow: 5,
  phrase: 8, phraseRow: 7, instrument: 5, soundParam: 2,
};
const sound = { ...phrase, activeWorkspace: "sound", view: "sound", dock: "sound" };
assert.deepEqual(renderer.dependencies(phrase, sound), {
  workspace: true, focus: false, track: false, chain: false,
  phrase: false, instrument: false,
});

const song = {
  ...phrase,
  activeWorkspace: "song", view: "song",
  focus: { pane: "song", row: 7, col: 2 },
  songRow: 7, track: 2, chain: 9, chainRow: 0,
  phrase: 4, phraseRow: 7, instrument: 5,
};
assert.deepEqual(renderer.dependencies(phrase, song), {
  workspace: true, focus: true, track: true, chain: true,
  phrase: true, instrument: false,
});

const resolved = renderer.resolveContexts({ before: { context: phrase }, after: { context: sound } });
assert.equal(resolved.before.activeWorkspace, "phrase");
assert.equal(resolved.after.activeWorkspace, "sound");
console.log("G7 workspace context dependency tests passed");
