const assert = require("node:assert/strict");
const compiler = require("./event-plan-compiler.js");
const songPolicy = require("./song-transport-policy.js");

const EMPTY = -1;
const emptyFx = () => ({ command: 0, value: 0 });
const emptyStep = () => ({ note: EMPTY, velocity: 100, instrument: EMPTY, fx: Array.from({ length: 3 }, emptyFx) });
const emptyChain = () => Array.from({ length: 16 }, () => ({ phrase: EMPTY, transpose: 0 }));

function freshProject() {
  const phrase = Array.from({ length: 16 }, emptyStep);
  phrase[0] = { note: 48, velocity: 100, instrument: EMPTY, fx: Array.from({ length: 3 }, emptyFx) };
  const chain = emptyChain();
  chain[0] = { phrase: 0, transpose: 0 };
  const song = Array.from({ length: 64 }, () => Array(8).fill(EMPTY));
  song[0][0] = 0;
  return {
    song,
    chains: { 0: chain },
    phrases: { 0: phrase },
    instrumentPool: {},
  };
}

{
  const project = freshProject();
  const phrase = compiler.compilePhraseProgram({ model: project, origin: { track: 0, phraseId: 0 } });
  assert.equal(phrase.events[0].instrumentId, EMPTY, "shipped Phrase EventPlan must not synthesize Instrument 00 for an unassigned fresh row");
  assert.equal(phrase.steps[0].instrumentIds[0], EMPTY, "sequence-step projection must preserve unassigned Instrument truth");

  const song = compiler.compileSongPlan({
    model: project,
    songPolicy,
    origin: { songRow: 0, track: 0, chainId: 0, chainRow: 0, phraseId: 0 },
    trackCount: 8,
  });
  assert.equal(song.tracks[0].events[0].instrumentId, EMPTY, "shipped Song EventPlan must not synthesize Instrument 00 for a fresh Project");
}

{
  const project = freshProject();
  project.phrases[0][0].instrument = 7;
  const phrase = compiler.compilePhraseProgram({ model: project, origin: { track: 0, phraseId: 0 } });
  assert.equal(phrase.events[0].instrumentId, 7, "an imported unresolved Instrument byte must remain lossless in EventPlan data");
  assert.equal(phrase.steps[0].instrumentIds[0], 7, "sequence projection must preserve an explicit unresolved Instrument byte");
}

{
  const steps = [2, EMPTY, 4, EMPTY].map((instrument) => ({ instrument }));
  assert.deepEqual(
    [...compiler.resolveCyclicInstrumentIds(steps, EMPTY)],
    [2, 2, 4, 4],
    "removing implicit 00 must not break authored cyclic Instrument carry",
  );
}

console.log("A5 production EventPlan Instrument truth regressions passed");
