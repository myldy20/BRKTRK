const assert = require("node:assert/strict");
const compiler = require("./event-plan-compiler.js");
const songPolicy = require("./song-transport-policy.js");

const emptyStep = () => ({ note: -1, velocity: 100, instrument: -1, fx: [{ command: 0, value: 0 }, { command: 0, value: 0 }, { command: 0, value: 0 }] });
const emptyChain = () => Array.from({ length: 16 }, () => ({ phrase: -1, transpose: 0 }));
const model = {
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: {},
  instrumentPool: {},
};

model.phrases[1] = Array.from({ length: 16 }, emptyStep);
model.phrases[1][0] = { note: 60, velocity: 100, instrument: -1, fx: [{ command: 4, value: 2 }, { command: 5, value: 0x30 }, { command: 0, value: 0 }] };
model.phrases[1][4] = { note: -1, velocity: 80, instrument: 2, fx: [0, 0, 0] };
model.phrases[1][8] = { note: 64, velocity: 90, instrument: -1, fx: [0, 0, 0] };
model.phrases[1][12] = { note: -2, velocity: 100, instrument: 3, fx: [0, 0, 0] };

const phrase = compiler.compilePhraseProgram({
  model,
  origin: { songRow: 0, track: 5, chainId: 9, chainRow: 2, phraseId: 1 },
  trackCount: 8,
});

assert.equal(phrase.mode, "sequence");
assert.equal(phrase.scope, "phrase");
assert.equal(phrase.events.length, 16);
assert.deepEqual(
  phrase.events.map((event) => event.instrumentId),
  [3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3],
  "rows before the first explicit Instrument must inherit the final explicit Instrument from loop wrap",
);
assert.equal(phrase.events[0].note, 60);
assert.equal(phrase.events[0].trackId, 5);
assert.equal(phrase.events[0].instrumentId, 3);
assert.equal(phrase.events[0].velocity, 100);
assert.deepEqual(phrase.events[0].fx, [
  { command: 4, value: 2 },
  { command: 5, value: 0x30 },
  { command: 0, value: 0 },
], "schema-v2 compound FX slots must cross the event-program boundary without flattening values");
assert.deepEqual(phrase.steps[0].fx[5], phrase.events[0].fx, "sequence steps must retain the selected Track compound FX slots");
assert.deepEqual(phrase.events[0].parameterEvents, [], "legacy Phrase rows must compile with no authored ParameterEvents");
assert.equal(Object.hasOwn(phrase.steps[0], "parameterEvents"), false, "ParameterEvents must stay Host/compiler metadata until PE2 runtime delivery");
assert.equal(phrase.events[4].note, null, "an Empty Note with an Instrument must update carry without triggering a Note");
assert.equal(phrase.events[12].note, -2, "Note Off must retain release semantics");
assert.equal(phrase.steps[0].instrumentIds[5], 3, "logical Instrument identity must cross the sequence event contract");
assert.equal(phrase.steps[0].trackIds[5], 5, "logical Track identity must cross the sequence event contract");
for (const key of ["waves", "gains", "pans", "mutes"]) {
  assert.equal(Object.hasOwn(phrase.steps[0], key), false, `production event plans must not retain preview ${key}`);
}
for (const key of ["wave", "gain", "pan", "mute"]) {
  assert.equal(Object.hasOwn(phrase.events[0], key), false, `production events must not retain preview ${key}`);
}

const noExplicit = Array.from({ length: 16 }, emptyStep);
noExplicit[2].note = 67;
model.phrases[2] = noExplicit;
const fallback = compiler.compilePhraseProgram({ model, origin: { track: 0, phraseId: 2 } });
assert.ok(fallback.events.every((event) => event.instrumentId === -1), "a loop with no explicit Instrument must remain unassigned instead of fabricating 00");
assert.ok(fallback.steps.every((step) => step.instrumentIds[0] === -1), "sequence projection must preserve the same unassigned loop truth");

model.chains[4] = emptyChain();
model.chains[4][0] = { phrase: 1, transpose: 0 };
model.chains[4][1] = { phrase: 2, transpose: 1 };
const chain = compiler.compileChainProgram({
  model,
  origin: { songRow: 0, track: 5, chainId: 4, chainRow: 0, phraseId: 1 },
});
assert.equal(chain.events.length, 32);
assert.equal(chain.events[0].instrumentId, 3, "Chain compilation must use the same cyclic carry rule as Phrase compilation");
assert.equal(chain.events[16].instrumentId, 3, "carry must continue across Phrase occurrences inside a Chain loop");
assert.deepEqual(chain.events[0].fx[0], { command: 4, value: 2 }, "Chain occurrences must retain Phrase FX values");

const chainFromSecondRow = compiler.compileChainProgram({
  model,
  origin: { songRow: 0, track: 5, chainId: 4, chainRow: 1, phraseId: 2 },
});
assert.equal(chainFromSecondRow.events.length, 32, "starting Chain from row 01 must preserve the complete two-Phrase loop period");
assert.equal(chainFromSecondRow.contexts[0].chainRow, 1, "mid-Chain start must begin at the requested row");
assert.equal(chainFromSecondRow.contexts[15].chainRow, 1, "the requested occurrence must remain the first complete Phrase");
assert.equal(chainFromSecondRow.contexts[16].chainRow, 0, "after the requested occurrence the Chain loop must wrap to its earlier populated row");
assert.equal(chainFromSecondRow.contexts[31].chainRow, 0, "the wrapped earlier occurrence must remain a complete Phrase");
assert.deepEqual(
  [...new Set(chainFromSecondRow.contexts.map((context) => context.chainRow))],
  [1, 0],
  "mid-Chain start must rotate the loop rather than truncate its period",
);

model.song[0][0] = 4;
model.song[0][1] = 4;
const song = compiler.compileSongPlan({
  model,
  songPolicy,
  origin: { songRow: 0, track: 1, chainId: 4, chainRow: 1, phraseId: 2 },
  continueFromChain: true,
  trackCount: 8,
});
assert.equal(song.mode, "track-plan");
assert.equal(song.tracks[1].startIndex, 16, "mid-Chain start must preserve the structural start position");
assert.equal(song.tracks[1].events[16].instrumentId, 3, "mid-program start before an explicit Instrument must be resolved from cyclic project context");
assert.deepEqual(
  song.tracks[0].events.map((event) => event.instrumentId),
  song.tracks[1].events.map((event) => event.instrumentId),
  "equivalent Track project data must compile identically regardless of selected Track",
);

const changedEditorState = compiler.compileSongPlan({
  model,
  songPolicy,
  origin: { songRow: 0, track: 0, chainId: 4, chainRow: 0, phraseId: 1 },
  trackCount: 8,
});
assert.deepEqual(
  song.tracks[0].events.map(({ note, instrumentId, fx }) => ({ note, instrumentId, fx })),
  changedEditorState.tracks[0].events.map(({ note, instrumentId, fx }) => ({ note, instrumentId, fx })),
  "event output must not depend on editor-selected Instrument, workspace or Follow state",
);

// #511: a plan whose notes have nothing to play them is silent by design, and
// Play must be able to say so. The summary reads the compiled plan, so cyclic
// Instrument resolution is already applied: an unassigned row that inherits
// an Instrument plays.
{
  const production = { name: "SYNTH", engineRef: { moduleId: "design.test", engineId: "synth" } };
  const demo = Array.from({ length: 16 }, emptyStep);
  demo[0] = { ...emptyStep(), note: 48 };
  demo[4] = { ...emptyStep(), note: -2 };
  demo[8] = { ...emptyStep(), note: 55 };
  const demoModel = { ...model, phrases: { ...model.phrases, 7: demo }, instrumentPool: {} };
  const demoPlan = compiler.compilePhraseProgram({ model: demoModel, origin: { track: 0, phraseId: 7 } });

  const fresh = compiler.playableNoteSummary(demoPlan, {});
  assert.deepEqual({ ...fresh }, { notes: 2, unassigned: 2, emptySlot: 0, silent: 2, hasProductionInstrument: false }, "Note Off is not a struck note; both demo notes are unassigned");
  assert.equal(compiler.silentNotesStatus(fresh), "SILENT · NO INSTRUMENT — SOUND ▸ CREATE", "an empty pool points at CREATE");

  const created = compiler.playableNoteSummary(demoPlan, { 0: production });
  assert.equal(created.silent, 2);
  assert.equal(compiler.silentNotesStatus(created), "SILENT · NOTES HAVE NO INSTRUMENT — SET INST", "an Instrument that exists but is not on the notes points at INST");

  const assigned = Array.from({ length: 16 }, (_, row) => ({ ...demo[row] }));
  assigned[0].instrument = 0;
  const assignedPlan = compiler.compilePhraseProgram({ model: { ...demoModel, phrases: { ...demoModel.phrases, 8: assigned } }, origin: { track: 0, phraseId: 8 } });
  const inherited = compiler.playableNoteSummary(assignedPlan, { 0: production });
  assert.equal(inherited.silent, 0, "a later unassigned note inherits row 00's Instrument and plays");
  assert.equal(compiler.silentNotesStatus(inherited), null, "a playable plan adds nothing to the status");

  const emptySlot = Array.from({ length: 16 }, (_, row) => ({ ...demo[row] }));
  emptySlot[0].instrument = 1;
  const emptySlotPlan = compiler.compilePhraseProgram({ model: { ...demoModel, phrases: { ...demoModel.phrases, 9: emptySlot } }, origin: { track: 0, phraseId: 9 } });
  const orphaned = compiler.playableNoteSummary(emptySlotPlan, { 0: production });
  assert.deepEqual([orphaned.unassigned, orphaned.emptySlot], [0, 2], "notes naming an empty slot are counted apart from unassigned ones");
  assert.equal(compiler.silentNotesStatus(orphaned), "SILENT · NOTES HAVE NO INSTRUMENT — SET INST");

  // A Song plan counts only active Tracks' struck notes.
  const mixed = compiler.playableNoteSummary({
    mode: "track-plan",
    tracks: [
      { active: true, events: [{ note: 60, instrumentId: 0 }, { note: 62, instrumentId: -1 }, { note: null, instrumentId: -1 }] },
      { active: true, events: [{ note: 64, instrumentId: -1 }, { note: -2, instrumentId: -1 }] },
      { active: false, events: [{ note: 67, instrumentId: -1 }] },
    ],
  }, { 0: production });
  assert.deepEqual([mixed.notes, mixed.silent], [3, 2]);
  assert.equal(compiler.silentNotesStatus(mixed), "2 OF 3 NOTES HAVE NO INSTRUMENT", "a partly silent plan says how much is silent");

  assert.equal(compiler.silentNotesStatus(compiler.playableNoteSummary({ mode: "sequence", events: [] }, {})), null, "no notes, nothing to say");
  assert.equal(compiler.silentNotesStatus(null), null);
}


// #567 P0: default conditions are behavior-equivalent to legacy rows, while
// iteration/probability admission is deterministic and resolved by the Host compiler.
{
  const legacyModel = {
    song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
    chains: { 0: [{ phrase: 0, transpose: 0 }] },
    phrases: {
      0: Array.from({ length: 16 }, (_, row) => ({
        note: row === 0 ? 60 : row === 4 ? -2 : -1,
        velocity: 70 + row,
        instrument: row === 0 ? 2 : -1,
        fx: row === 0 ? [{ command: 4, value: 2 }, 0, 0] : [0, 0, 0],
      })),
    },
    instrumentPool: {},
  };
  const explicitDefaults = structuredClone(legacyModel);
  for (const step of explicitDefaults.phrases[0]) {
    step.condition = { probability: 100, every: 1, offset: 0 };
  }
  const origin = { songRow: 9, track: 3, chainId: 0, chainRow: 0, phraseId: 0 };
  assert.deepEqual(
    compiler.compilePhraseProgram({ model: legacyModel, origin }),
    compiler.compilePhraseProgram({ model: explicitDefaults, origin }),
    "legacy rows without condition must compile exactly like canonical unconditional rows",
  );

  const iterated = structuredClone(explicitDefaults);
  iterated.phrases[0][0].condition = { probability: 100, every: 2, offset: 1 };
  iterated.phrases[0][0].parameterEvents = [
    { instrumentId: 2, parameterId: "filter.cutoff", value: 0.75, interpolationOut: "linear" },
  ];
  const first = compiler.compilePhraseProgram({ model: iterated, origin, occurrenceIndex: 1 });
  const second = compiler.compilePhraseProgram({ model: iterated, origin, occurrenceIndex: 2 });
  assert.equal(first.events[0].note, null, "offset 1 of every 2 must suppress the first occurrence");
  assert.deepEqual(first.events[0].fx, compiler.normalizeFxSlots(), "a rejected step must not leak Phrase FX events");
  assert.deepEqual(first.events[0].parameterEvents, [], "a rejected step must not leak authored ParameterEvents");
  assert.equal(second.events[0].note, 60, "offset 1 of every 2 must admit the second occurrence");
  assert.deepEqual(second.events[0].fx[0], { command: 4, value: 2 }, "an admitted occurrence retains Phrase FX");
  assert.deepEqual(second.events[0].parameterEvents, [
    { instrumentId: 2, parameterId: "filter.cutoff", value: 0.75, interpolationOut: "linear" },
  ], "an admitted occurrence retains canonical authored ParameterEvents as Host metadata");

  const carryModel = structuredClone(explicitDefaults);
  carryModel.phrases[0][0] = {
    ...carryModel.phrases[0][0],
    note: 60,
    instrument: 1,
    condition: { probability: 100, every: 2, offset: 1 },
  };
  carryModel.phrases[0][4] = {
    ...carryModel.phrases[0][4],
    note: 64,
    instrument: -1,
    condition: { probability: 100, every: 1, offset: 0 },
  };
  carryModel.phrases[0][8] = {
    ...carryModel.phrases[0][8],
    note: 67,
    instrument: 2,
    condition: { probability: 100, every: 1, offset: 0 },
  };
  const carryFirst = compiler.compilePhraseProgram({ model: carryModel, origin, occurrenceIndex: 1 });
  const carrySecond = compiler.compilePhraseProgram({ model: carryModel, origin, occurrenceIndex: 2 });
  assert.equal(carryFirst.events[0].note, null);
  assert.equal(carryFirst.events[4].instrumentId, 2, "a rejected explicit Instrument must not mutate cyclic carry");
  assert.equal(carrySecond.events[4].instrumentId, 1, "an admitted explicit Instrument participates in cyclic carry");

  const probabilityInput = {
    condition: { probability: 50, every: 1, offset: 0 },
    scope: "song",
    track: 2,
    context: { songRow: 7, chainId: 4, chainRow: 3, phraseId: 9, phraseRow: 5 },
    occurrenceIndex: 11,
    seed: "project-seed-v1",
  };
  const probabilityA = compiler.evaluateStepCondition(probabilityInput);
  const probabilityB = compiler.evaluateStepCondition(probabilityInput);
  assert.deepEqual(probabilityA, probabilityB, "same semantic occurrence and seed must produce the same admission result");
  assert.notEqual(probabilityA.draw, null, "non-trivial probability must expose a deterministic draw to tests/diagnostics");
  const probabilityNext = compiler.evaluateStepCondition({ ...probabilityInput, occurrenceIndex: 12 });
  assert.notEqual(probabilityNext.draw, probabilityA.draw, "occurrence identity must participate in the deterministic probability address");

  const reusedPhraseB = compiler.evaluateStepCondition({
    ...probabilityInput,
    context: { ...probabilityInput.context, chainRow: 4 },
  });
  assert.notEqual(
    probabilityA.draw,
    reusedPhraseB.draw,
    "two Song placements of one shared Phrase must have independent deterministic probability addresses",
  );

  const identity = compiler.semanticOccurrenceIdentity({
    scope: "song",
    track: 2,
    context: probabilityInput.context,
  });
  const keyedOccurrence = { [compiler.occurrenceIdentityKey(identity)]: 13 };
  assert.equal(
    compiler.evaluateStepCondition({ ...probabilityInput, occurrenceIndex: keyedOccurrence }).occurrenceIndex,
    13,
    "compiler callers may supply occurrence counters keyed by semantic placement identity",
  );

  assert.deepEqual(
    compiler.normalizeStepCondition({ probability: -1, every: 99, offset: 99 }),
    { probability: 0, every: 16, offset: 15 },
  );
  assert.throws(
    () => compiler.evaluateStepCondition({ ...probabilityInput, occurrenceIndex: 0 }),
    /positive integer/,
  );
}

console.log("I1 deterministic production event-plan compiler tests passed");
