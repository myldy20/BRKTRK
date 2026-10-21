const assert = require("node:assert/strict");
const policy = require("./playback-context-policy.js");

const emptyStep = () => ({ note: -1, velocity: 100, instrument: -1, fx: [0, 0, 0] });
const emptyChain = () => Array.from({ length: 16 }, () => ({ phrase: -1, transpose: 0 }));
const model = {
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: {},
};
model.phrases[0] = Array.from({ length: 16 }, emptyStep);
model.phrases[0][0].note = 60;
model.phrases[1] = Array.from({ length: 16 }, emptyStep);
model.phrases[1][0].note = 65;
model.chains[0x10] = emptyChain();
model.chains[0x10][0] = { phrase: 0, transpose: 0 };
model.chains[0x10][1] = { phrase: 1, transpose: 0 };
model.chains[0x11] = emptyChain();
model.chains[0x11][0] = { phrase: 0, transpose: 1 };
model.chains[0x11][1] = { phrase: 1, transpose: -2 };
model.song[10][0] = 0x10;
model.song[11][0] = 0x11;

const sequence = policy.annotate({
  scope: "song",
  segments: [
    { start: 0, end: 32, songRow: 10 },
    { start: 32, end: 64, songRow: 11 },
  ],
}, { songRow: 10, track: 0, chainId: 0x10, chainRow: 0, phraseId: 0 });

let context = policy.resolve({ sequence, index: 32, track: 0, model });
assert.equal(context.songRow, 11);
assert.equal(context.chainId, 0x11);
assert.equal(context.chainRow, 0);
assert.equal(context.phraseId, 0);
assert.equal(context.phraseRow, 0);
assert.equal(context.transpose, 1);
assert.equal(context.sourceNote, 60);
assert.equal(context.effectiveNote, 61);
assert.match(
  policy.format(context, {
    hex: (value) => value.toString(16).toUpperCase().padStart(2, "0"),
    noteName: (value) => `N${value}`,
  }),
  /C11:00 .* P00:00 .* TSP \+01 .* SRC N60.*OUT N61/,
);

context = policy.resolve({ sequence, index: 48, track: 0, model });
assert.equal(context.chainId, 0x11);
assert.equal(context.chainRow, 1);
assert.equal(context.phraseId, 1);
assert.equal(context.transpose, -2);
assert.equal(context.sourceNote, 65);
assert.equal(context.effectiveNote, 63);

const chainSequence = policy.annotate({
  scope: "chain",
  segments: [{ start: 0, end: 16, chainRow: 0, phrase: 0 }],
}, { songRow: 11, track: 0, chainId: 0x11, chainRow: 0, phraseId: 0 });
context = policy.resolve({ sequence: chainSequence, index: 0, track: 5, model });
assert.equal(context.track, 0, "Chain playback keeps the Track that started the scoped sequence");
assert.equal(context.transpose, 1);
assert.equal(context.effectiveNote, 61);

const phraseSequence = policy.annotate({
  scope: "phrase",
  segments: [{ start: 0, end: 16 }],
}, { songRow: 11, track: 0, chainId: 0x11, chainRow: 0, phraseId: 0 });
context = policy.resolve({ sequence: phraseSequence, index: 0, track: 7, model });
assert.equal(context.track, 0, "Phrase playback keeps its origin Track");
assert.equal(context.transpose, 0);
assert.equal(context.effectiveNote, 60);
assert.equal(policy.format({ track: 3, silent: true }), "PLAY T4 · SILENT · NO LOOP BLOCK");

console.log("P3.5 playback context policy tests passed");
