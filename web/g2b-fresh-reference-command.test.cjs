const assert = require("node:assert/strict");
const stores = require("./stores.js");
const structureTypes = require("./project-structure.js");
require("./field-schema.js");
require("./project-structure-runtime.js");
const dispatcherTypes = require("./command-dispatcher.js");

const EMPTY = -1;
const TRACKS = 8;
const emptyChainStep = () => ({ phrase: EMPTY, transpose: 0 });
const emptyPhraseStep = () => ({
  note: EMPTY,
  velocity: 100,
  instrument: EMPTY,
  fx: Array.from({ length: 3 }, () => ({ command: 0, value: 0 })),
});

function createHarness({ pane, fullKind }) {
  const model = {
    schemaVersion: 4,
    sourceFormat: "brktrk",
    projectName: "G2B COMMAND",
    tempo: 120,
    tracks: Array.from({ length: TRACKS }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
    song: [Array(TRACKS).fill(EMPTY)],
    chains: {},
    phrases: {},
    instrumentPool: {},
  };
  if (pane === "chain") model.chains[0] = Array.from({ length: 16 }, emptyChainStep);
  if (fullKind === "chain") {
    for (let id = 0; id < 256; id += 1) model.chains[id] = Array.from({ length: 16 }, emptyChainStep);
  } else {
    for (let id = 0; id < 256; id += 1) model.phrases[id] = Array.from({ length: 16 }, emptyPhraseStep);
  }

  const state = {
    view: pane,
    dock: "mix",
    scope: pane,
    live: false,
    playing: false,
    songRow: 0,
    track: 0,
    chain: 0,
    chainRow: 0,
    phrase: 0,
    phraseRow: 0,
    instrument: 0,
    focus: { pane, row: 0, col: 0 },
    lastChain: 0,
    lastPhrase: 0,
    p3: { activeWorkspace: pane, soundParam: 0, parents: [], mixReturn: null },
  };
  const owned = stores.createStores({ model, state, trackCount: TRACKS });
  structureTypes.install(owned.project);
  owned.project.phraseSteps = {};
  owned.navigation.entryState = {
    closeAll() {},
    getPreparedEntry() { return { velocity: 100, instrument: 0, octave: 4, editStep: 1 }; },
    setPreparedValue() { throw new Error("capacity regression must not edit prepared entry"); },
  };

  const statuses = [];
  let legacyPersistCount = 0;
  let storePersistenceCount = 0;
  owned.project.subscribe("persistence", () => { storePersistenceCount += 1; });

  const soundRenderer = {
    renderSelection() {},
    renderFieldCompletion() {},
  };
  const root = {
    document: { querySelector() { return null; } },
    BRKTRKStores: owned,
    BRKTRKHierarchyRenderer: { render() {} },
    BRKTRKMixContextRenderer: { render() {} },
    BRKTRKOccurrenceContextRenderer: { render() {} },
    BRKTRKWorkspaceContextRenderer: { render() {} },
    BRKTRKSoundEditRenderer: soundRenderer,
    persist() { legacyPersistCount += 1; },
    renderAll() {},
    renderTrackerCursor() {},
    renderTransport() {},
    focusSelectedCell() {},
    async togglePlayback() {},
    stopPlayback() {},
  };
  const env = {
    state,
    model: owned.project.getState(),
    EMPTY,
    NOTE_OFF: -2,
    TRACKS,
    PHRASE_ROWS: 16,
    heldKeys: new Set(),
    projectStore: owned.project,
    navigationStore: owned.navigation,
    soundEditRenderer: soundRenderer,
    audio: { ready: false },
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    hex: (value) => Math.max(0, Number(value) || 0).toString(16).toUpperCase().padStart(2, "0"),
    noteName: String,
    fxName: String,
    focusLimits: (targetPane) => targetPane === "song"
      ? { rows: 1, cols: TRACKS }
      : targetPane === "chain"
        ? { rows: 16, cols: 2 }
        : { rows: 16, cols: 6 },
    chain(id, create = true) {
      if (!Object.hasOwn(this.model.chains, id) && create) this.model.chains[id] = Array.from({ length: 16 }, emptyChainStep);
      return this.model.chains[id];
    },
    phrase(id, create = true) {
      if (!Object.hasOwn(this.model.phrases, id) && create) this.model.phrases[id] = Array.from({ length: 16 }, emptyPhraseStep);
      return this.model.phrases[id];
    },
    currentValue() { return EMPTY; },
    firstUnused() { throw new Error("semantic Fresh must not use legacy firstUnused"); },
    setStatus(message, tone = "green") { statuses.push({ message, tone }); },
  };
  const commands = dispatcherTypes.install(root, env);
  return {
    commands,
    env,
    statuses,
    legacyPersistCount: () => legacyPersistCount,
    storePersistenceCount: () => storePersistenceCount,
  };
}

async function assertExplicitCapacityFailure({ pane, fullKind, expectedMessage }) {
  const fixture = createHarness({ pane, fullKind });
  const beforeHistory = fixture.commands.history.list().length;
  const result = await fixture.commands.dispatch({
    type: "field.insert",
    fresh: true,
    source: `g2b-${fullKind}-capacity-command`,
  });

  assert.equal(result.allocationFailed, true, `${fullKind} command must preserve allocator failure identity`);
  assert.equal(result.ok, false, `${fullKind} full-capacity Fresh must be an explicit failed command`);
  assert.equal(result.message, expectedMessage, `${fullKind} command must expose a stable capacity error`);
  assert.deepEqual(fixture.statuses.at(-1), { message: expectedMessage, tone: "amber" });
  assert.equal(fixture.commands.history.list().length, beforeHistory, `${fullKind} capacity failure must not create command history`);
  assert.equal(fixture.legacyPersistCount(), 0, `${fullKind} capacity failure must not call legacy persistence`);
  assert.equal(fixture.storePersistenceCount(), 0, `${fullKind} capacity failure must not publish Project persistence`);

  if (pane === "song") assert.equal(fixture.env.model.song[0][0], EMPTY, "Chain capacity failure must preserve the empty Song reference");
  else assert.equal(fixture.env.model.chains[0][0].phrase, EMPTY, "Phrase capacity failure must preserve the empty Chain reference");
}

(async () => {
  await assertExplicitCapacityFailure({ pane: "song", fullKind: "chain", expectedMessage: "CHAIN POOL FULL" });
  await assertExplicitCapacityFailure({ pane: "chain", fullKind: "phrase", expectedMessage: "PHRASE POOL FULL" });
  console.log("G2B command-level Fresh capacity failure regression passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
