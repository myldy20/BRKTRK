const assert = require("node:assert/strict");
const stores = require("./stores.js");
const structureTypes = require("./project-structure.js");
const undoRedoTypes = require("./undo-redo.js");
const schema = require("./field-schema.js");
require("./project-structure-runtime.js");

const EMPTY = -1;
const emptyChainStep = () => ({ phrase: EMPTY, transpose: 0 });
const emptyPhraseStep = () => ({
  note: EMPTY,
  velocity: 100,
  instrument: EMPTY,
  fx: Array.from({ length: 3 }, () => ({ command: 0, value: 0 })),
});
const emptyTrack = (id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } });

function createEnv() {
  const model = {
    schemaVersion: 4,
    sourceFormat: "brktrk",
    projectName: "G2B",
    tempo: 120,
    tracks: Array.from({ length: 8 }, (_, id) => emptyTrack(id)),
    song: [Array(8).fill(EMPTY)],
    chains: {},
    phrases: {},
    instrumentPool: {},
  };
  const env = {
    EMPTY,
    NOTE_OFF: -2,
    state: {
      chain: 0,
      phrase: 0,
      instrument: 0,
      lastChain: 0,
      lastPhrase: 0,
      focus: { pane: "song", row: 0, col: 0 },
    },
    model,
    firstUnused() {
      throw new Error("semantic Fresh must not delegate to the legacy content-empty allocator");
    },
    chain(id, create = true) {
      if (!Object.hasOwn(this.model.chains, id) && create) {
        this.model.chains[id] = Array.from({ length: 16 }, emptyChainStep);
      }
      return this.model.chains[id];
    },
    phrase(id, create = true) {
      if (!Object.hasOwn(this.model.phrases, id) && create) {
        this.model.phrases[id] = Array.from({ length: 16 }, emptyPhraseStep);
      }
      return this.model.phrases[id];
    },
    noteName: String,
    fxName: String,
  };
  env.projectStore = new stores.ProjectStore(model, { trackCount: 8 });
  structureTypes.install(env.projectStore);
  return env;
}

function installHistory(env) {
  const root = {
    setStatus() {},
    renderAll() {},
  };
  const history = undoRedoTypes.install(root, { projectStore: env.projectStore, limit: 16 });
  return { root, history };
}

assert.equal(schema.firstMissingReference({ 0: [] }), 1, "existing empty identity is not a Fresh allocation slot");
assert.equal(schema.firstMissingReference(Object.fromEntries(Array.from({ length: 256 }, (_, id) => [id, []]))), null, "256/256 identity space has no Fresh slot");

{
  const env = createEnv();
  env.model.chains[0] = Array.from({ length: 16 }, emptyChainStep);
  env.model.song[0][1] = 0;
  const descriptor = schema.resolve("song", 0);
  const mutation = schema.insert(env, descriptor, { fresh: true, source: "g2b-chain-fresh" }, { pane: "song", row: 0, col: 0 });

  assert.equal(mutation.after, 1, "Fresh Chain must allocate a new identity instead of aliasing referenced-empty Chain 00");
  assert.equal(env.model.song[0][0], 1);
  assert.ok(Object.hasOwn(env.model.chains, 1));
  assert.notStrictEqual(env.model.chains[1], env.model.chains[0]);
  assert.equal(mutation.projectChangeSet?.target, "structure.song.chainRef", "Fresh Chain must publish through ProjectStore structural ownership");
  assert.equal(mutation.projectChangeSet?.persistsProject, true);
}

{
  const env = createEnv();
  env.model.song[0][1] = 0;
  const descriptor = schema.resolve("song", 0);
  const mutation = schema.insert(env, descriptor, { fresh: true, source: "g2b-chain-dangling-reference" }, { pane: "song", row: 0, col: 0 });

  assert.equal(mutation.after, 1, "Fresh Chain must not materialize a dangling inbound Chain 00 reference");
  assert.equal(Object.hasOwn(env.model.chains, 0), false, "dangling Chain 00 must remain unresolved");
  assert.ok(Object.hasOwn(env.model.chains, 1), "Fresh Chain must allocate the first safe unreferenced identity");
}

{
  const env = createEnv();
  env.model.chains[0] = Array.from({ length: 16 }, emptyChainStep);
  env.model.phrases[0] = Array.from({ length: 16 }, emptyPhraseStep);
  env.model.chains[0][1] = { phrase: 0, transpose: 0 };
  env.state.focus = { pane: "chain", row: 0, col: 0 };
  const descriptor = schema.resolve("chain", 0);
  const mutation = schema.insert(env, descriptor, { fresh: true, source: "g2b-phrase-fresh" }, env.state.focus);

  assert.equal(mutation.after, 1, "Fresh Phrase must allocate a new identity instead of aliasing referenced-empty Phrase 00");
  assert.equal(env.model.chains[0][0].phrase, 1);
  assert.ok(Object.hasOwn(env.model.phrases, 1));
  assert.notStrictEqual(env.model.phrases[1], env.model.phrases[0]);
  assert.equal(mutation.projectChangeSet?.target, "structure.chain.phraseRef", "Fresh Phrase must publish through ProjectStore structural ownership");
  assert.equal(mutation.projectChangeSet?.persistsProject, true);
}

{
  const env = createEnv();
  env.model.chains[0] = Array.from({ length: 16 }, emptyChainStep);
  env.model.chains[0][1] = { phrase: 0, transpose: 0 };
  env.state.focus = { pane: "chain", row: 0, col: 0 };
  const descriptor = schema.resolve("chain", 0);
  const mutation = schema.insert(env, descriptor, { fresh: true, source: "g2b-phrase-dangling-reference" }, env.state.focus);

  assert.equal(mutation.after, 1, "Fresh Phrase must not materialize a dangling inbound Phrase 00 reference");
  assert.equal(Object.hasOwn(env.model.phrases, 0), false, "dangling Phrase 00 must remain unresolved");
  assert.ok(Object.hasOwn(env.model.phrases, 1), "Fresh Phrase must allocate the first safe unreferenced identity");
}

{
  const env = createEnv();
  env.model.phrases[0] = Array.from({ length: 16 }, emptyPhraseStep);
  for (let id = 0; id < 256; id += 1) {
    const rows = Array.from({ length: 16 }, emptyChainStep);
    rows[0] = { phrase: 0, transpose: 0 };
    env.model.chains[id] = rows;
  }
  const descriptor = schema.resolve("song", 0);
  const mutation = schema.insert(env, descriptor, { fresh: true, source: "g2b-chain-capacity" }, { pane: "song", row: 0, col: 0 });

  assert.equal(mutation.mutated, false, "Fresh Chain at full 256-ID capacity must fail without mutating Project state");
  assert.equal(mutation.after, EMPTY, "Chain capacity failure must preserve the original empty reference");
  assert.equal(mutation.allocationFailed, true, "semantic Fresh Chain must expose explicit allocation failure");
  assert.equal(mutation.reason, "reference-capacity");
  assert.equal(env.model.song[0][0], EMPTY, "Chain capacity failure must never fall back to Chain 00");
}

{
  const env = createEnv();
  env.model.chains[0] = Array.from({ length: 16 }, emptyChainStep);
  for (let id = 0; id < 256; id += 1) {
    env.model.phrases[id] = Array.from({ length: 16 }, emptyPhraseStep);
  }
  env.state.focus = { pane: "chain", row: 0, col: 0 };
  const descriptor = schema.resolve("chain", 0);
  const mutation = schema.insert(env, descriptor, { fresh: true, source: "g2b-phrase-capacity" }, env.state.focus);

  assert.equal(mutation.mutated, false, "Fresh Phrase at full 256-ID capacity must fail without mutating Project state");
  assert.equal(mutation.after, EMPTY, "Phrase capacity failure must preserve the original empty reference");
  assert.equal(mutation.allocationFailed, true, "semantic Fresh Phrase must expose explicit allocation failure");
  assert.equal(mutation.reason, "reference-capacity");
  assert.equal(env.model.chains[0][0].phrase, EMPTY, "Phrase capacity failure must never fall back to Phrase 00");
}

{
  const env = createEnv();
  env.model.chains[0] = Array.from({ length: 16 }, emptyChainStep);
  env.model.song[0][1] = 0;
  const { history } = installHistory(env);
  const descriptor = schema.resolve("song", 0);
  const mutation = schema.insert(env, descriptor, { fresh: true, source: "g2b-chain-history" }, { pane: "song", row: 0, col: 0 });

  assert.equal(mutation.after, 1);
  assert.equal(history.snapshot().undoDepth, 1, "Fresh Chain must create one durable Project history entry");
  assert.equal(history.undo().ok, true);
  assert.equal(env.model.song[0][0], EMPTY, "Undo restores the original reference");
  assert.equal(Object.hasOwn(env.model.chains, 1), false, "Undo removes the newly allocated Chain identity");
  assert.ok(Object.hasOwn(env.model.chains, 0), "Undo preserves the pre-existing referenced-empty Chain identity");
  assert.equal(history.redo().ok, true);
  assert.equal(env.model.song[0][0], 1, "Redo restores the exact allocated Chain reference");
  assert.ok(Object.hasOwn(env.model.chains, 1), "Redo restores the exact allocated Chain identity");
}

{
  const env = createEnv();
  env.model.chains[0] = Array.from({ length: 16 }, emptyChainStep);
  env.model.phrases[0] = Array.from({ length: 16 }, emptyPhraseStep);
  env.model.chains[0][1] = { phrase: 0, transpose: 0 };
  env.state.focus = { pane: "chain", row: 0, col: 0 };
  const { history } = installHistory(env);
  const descriptor = schema.resolve("chain", 0);
  const mutation = schema.insert(env, descriptor, { fresh: true, source: "g2b-phrase-history" }, env.state.focus);

  assert.equal(mutation.after, 1);
  assert.equal(history.snapshot().undoDepth, 1, "Fresh Phrase must create one durable Project history entry");
  assert.equal(history.undo().ok, true);
  assert.equal(env.model.chains[0][0].phrase, EMPTY, "Undo restores the original Phrase reference");
  assert.equal(Object.hasOwn(env.model.phrases, 1), false, "Undo removes the newly allocated Phrase identity");
  assert.ok(Object.hasOwn(env.model.phrases, 0), "Undo preserves the pre-existing referenced-empty Phrase identity");
  assert.equal(history.redo().ok, true);
  assert.equal(env.model.chains[0][0].phrase, 1, "Redo restores the exact allocated Phrase reference");
  assert.ok(Object.hasOwn(env.model.phrases, 1), "Redo restores the exact allocated Phrase identity");
}

console.log("G2B Fresh Chain/Phrase identity regression passed");
