const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const policy = require("./song-transport-policy.js");

const emptyChain = () => Array.from({ length: 16 }, () => ({ phrase: -1, transpose: 0 }));
const makeModel = () => ({
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: {},
});
const addPhrase = (model, id) => {
  model.phrases[id] = Array.from({ length: 16 }, () => ({ note: -1, velocity: 100, instrument: -1, fx: [0, 0, 0] }));
  model.phrases[id][0].note = 48 + id;
};
const addChain = (model, id, phraseIds, transpose = 0) => {
  model.chains[id] = emptyChain();
  phraseIds.forEach((phraseId, row) => {
    model.chains[id][row] = { phrase: phraseId, transpose: Array.isArray(transpose) ? transpose[row] ?? 0 : transpose };
  });
};
const phraseStartTrace = (program, count) => Array.from({ length: count }, (_, index) => (
  policy.resolveProgramStep(program, index * policy.PHRASE_ROWS)?.context.phraseId ?? null
));

// Existing single-Track structural behavior.
const model = makeModel();
for (let id = 0; id < 4; id += 1) addPhrase(model, id);
addChain(model, 0x10, [0]);
addChain(model, 0x11, [1, 2], [0, 1]);
model.chains[0x12] = emptyChain(); // valid ID, zero-duration Chain; not a Song separator
addChain(model, 0x13, [3], -2);
model.song[0][0] = 0x10;
model.song[1][0] = 0x11;
model.song[2][0] = -1;
model.song[3][0] = 0x12;
model.song[4][0] = 0x13;
model.song[5][0] = -1;

assert.deepEqual(policy.segmentFor(model.song, 0, 1), { start: 0, end: 2, entryRow: 1, track: 0 });
assert.deepEqual(policy.segmentFor(model.song, 0, 2), { start: 3, end: 5, entryRow: 3, track: 0 });
assert.equal(policy.segmentFor(model.song, 1, 0), null);

let program = policy.buildTrackProgram({ model, track: 0, anchorRow: 1 });
assert.equal(program.active, true);
assert.equal(program.occurrences.length, 3);
assert.equal(program.contexts.length, 48);
assert.equal(program.periodRows, 48);
assert.equal(policy.programPeriod(program), 48);
assert.equal(program.startIndex, 16);
assert.equal(policy.contextAt(program, 16).songRow, 1);
assert.equal(policy.contextAt(program, 16).phraseId, 1);
assert.equal(policy.contextAt(program, 32).phraseId, 2);
assert.equal(policy.contextAt(program, 32).transpose, 1);
assert.equal(policy.phraseBoundary(program, 32), true);
assert.equal(policy.phraseBoundary(program, 33), false);

program = policy.buildTrackProgram({ model, track: 0, anchorRow: 2 });
assert.equal(program.segment.start, 3);
assert.equal(program.segment.end, 5);
assert.equal(program.contexts.length, 16);
assert.equal(program.occurrences.length, 1);
assert.equal(program.contexts[0].songRow, 4);
assert.equal(program.contexts[0].chainId, 0x13);
assert.equal(program.startIndex, 0);

program = policy.buildTrackProgram({ model, track: 0, anchorRow: 1, startChainRow: 1 });
assert.equal(program.startIndex, 32);
assert.equal(policy.contextAt(program, program.startIndex).phraseId, 2);

// One canonical wrapped-step contract owns context, boundary and update phase.
assert.equal(policy.wrapProgramIndex(48, 48), 0);
assert.equal(policy.wrapProgramIndex(48, -1), 47);
assert.equal(policy.wrapProgramIndex({ contexts: [] }, 3), -1);
let resolved = policy.resolveProgramStep(program, -16);
assert.equal(resolved.index, 32);
assert.equal(resolved.period, 48);
assert.equal(resolved.context.phraseId, 2);
assert.equal(resolved.phraseBoundary, true);
assert.equal(policy.remapProgramPosition(47, { contexts: Array(32).fill({}) }), 15);
assert.equal(policy.remapProgramPosition(17, { contexts: Array(64).fill({}) }), 17);
assert.equal(policy.remapProgramPosition(-1, { contexts: Array(16).fill({}) }), 15);
assert.equal(policy.remapProgramPosition(5, { contexts: [] }), 0);

// Owner topology 1: parallel 1/2 periods wrap independently without padding.
const parallel12 = makeModel();
for (let id = 0; id < 3; id += 1) addPhrase(parallel12, id);
addChain(parallel12, 0x10, [0]);
addChain(parallel12, 0x20, [1, 2]);
parallel12.song[0][0] = 0x10;
parallel12.song[0][1] = 0x20;
const short12 = policy.buildTrackProgram({ model: parallel12, track: 0, anchorRow: 0 });
const long12 = policy.buildTrackProgram({ model: parallel12, track: 1, anchorRow: 0 });
assert.equal(short12.periodRows, 16);
assert.equal(long12.periodRows, 32);
assert.deepEqual(phraseStartTrace(short12, 4), [0, 0, 0, 0]);
assert.deepEqual(phraseStartTrace(long12, 4), [1, 2, 1, 2]);
for (let step = 0; step < 64; step += 1) {
  assert.equal(policy.resolveProgramStep(short12, step).index, step % 16);
  assert.equal(policy.resolveProgramStep(long12, step).index, step % 32);
}

// Required unequal-period matrix 2/3 and 1/4 plus three simultaneous Tracks.
const matrix = makeModel();
for (let id = 0; id < 9; id += 1) addPhrase(matrix, id);
addChain(matrix, 0x30, [0, 1]);
addChain(matrix, 0x31, [2, 3, 4]);
addChain(matrix, 0x32, [5]);
addChain(matrix, 0x33, [6, 7, 8, 0]);
matrix.song[0][0] = 0x30;
matrix.song[0][1] = 0x31;
matrix.song[0][2] = 0x32;
matrix.song[0][3] = 0x33;
const periods = [0, 1, 2, 3].map((track) => policy.buildTrackProgram({ model: matrix, track, anchorRow: 0 }));
assert.deepEqual(periods.map((entry) => entry.periodRows), [32, 48, 16, 64]);
assert.deepEqual(phraseStartTrace(periods[0], 6), [0, 1, 0, 1, 0, 1]);
assert.deepEqual(phraseStartTrace(periods[1], 6), [2, 3, 4, 2, 3, 4]);
assert.deepEqual(phraseStartTrace(periods[2], 6), [5, 5, 5, 5, 5, 5]);
assert.deepEqual(phraseStartTrace(periods[3], 8), [6, 7, 8, 0, 6, 7, 8, 0]);
assert.equal(policy.buildTrackProgram({ model: matrix, track: 4, anchorRow: 0 }).active, false);

// Owner topology 2: sequential 2-Phrase Chain + 1-Phrase Chain wraps directly.
const sequential = makeModel();
for (let id = 0; id < 3; id += 1) addPhrase(sequential, id);
addChain(sequential, 0x40, [0, 1]);
addChain(sequential, 0x41, [2]);
sequential.song[0][0] = 0x40;
sequential.song[1][0] = 0x41;
sequential.song[2][0] = -1;
const sequentialProgram = policy.buildTrackProgram({ model: sequential, track: 0, anchorRow: 0 });
assert.equal(sequentialProgram.occurrences.length, 3);
assert.equal(sequentialProgram.periodRows, 48);
assert.deepEqual(phraseStartTrace(sequentialProgram, 6), [0, 1, 2, 0, 1, 2]);
assert.deepEqual(
  sequentialProgram.occurrences.map(({ songRow, chainId, chainRow, phraseId }) => ({ songRow, chainId, chainRow, phraseId })),
  [
    { songRow: 0, chainId: 0x40, chainRow: 0, phraseId: 0 },
    { songRow: 0, chainId: 0x40, chainRow: 1, phraseId: 1 },
    { songRow: 1, chainId: 0x41, chainRow: 0, phraseId: 2 },
  ],
);
assert.equal(policy.phraseBoundary(sequentialProgram, 48), true);
assert.equal(policy.contextAt(sequentialProgram, 48).phraseId, 0);

// A referenced zero-duration Chain stays in the block but never creates a synthetic occurrence.
const zeroDuration = makeModel();
for (let id = 0; id < 2; id += 1) addPhrase(zeroDuration, id);
addChain(zeroDuration, 0x50, [0]);
zeroDuration.chains[0x51] = emptyChain();
addChain(zeroDuration, 0x52, [1]);
zeroDuration.song[0][0] = 0x50;
zeroDuration.song[1][0] = 0x51;
zeroDuration.song[2][0] = 0x52;
zeroDuration.song[3][0] = -1;
const zeroProgram = policy.buildTrackProgram({ model: zeroDuration, track: 0, anchorRow: 1 });
assert.deepEqual(zeroProgram.segment, { start: 0, end: 3, entryRow: 1, track: 0 });
assert.equal(zeroProgram.occurrences.length, 2);
assert.equal(zeroProgram.periodRows, 32);
assert.deepEqual(phraseStartTrace(zeroProgram, 4), [0, 1, 0, 1]);
assert.equal(zeroProgram.contexts.some((context) => context.chainId === 0x51), false);

// Static ownership guard: current context/boundary consumers must share resolveProgramStep.
const source = readFileSync(require.resolve("./song-transport-policy.js"), "utf8");
const contextAtSource = source.match(/function contextAt\([\s\S]*?\n  \}/)?.[0] ?? "";
const phraseBoundarySource = source.match(/function phraseBoundary\([\s\S]*?\n  \}/)?.[0] ?? "";
assert.ok(contextAtSource.includes("resolveProgramStep"));
assert.ok(phraseBoundarySource.includes("resolveProgramStep"));
assert.equal(contextAtSource.includes("%"), false);
assert.equal(phraseBoundarySource.includes("%"), false);
const p36Source = readFileSync(require.resolve("./p36-transport.js"), "utf8");
assert.ok(p36Source.includes("songPolicy.contextAt"));
assert.ok(p36Source.includes("songPolicy.phraseBoundary"));
assert.equal(/contexts\.length[\s\S]{0,80}%|%[\s\S]{0,80}contexts\.length/.test(p36Source), false);

assert.deepEqual(policy.normalizeTransport({ followPlayhead: true, scopeLocked: true, lockedScope: "song" }), {
  followPlayhead: true,
  scopeLocked: true,
  lockedScope: "song",
});
assert.deepEqual(policy.normalizeTransport({ lockedScope: "bogus" }), {
  followPlayhead: false,
  scopeLocked: false,
  lockedScope: "phrase",
});
console.log("M4.0A H0 fixed-row transport policy tests passed");