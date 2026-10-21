const assert = require("node:assert/strict");
const stores = require("./stores.js");
const structureTypes = require("./project-structure.js");
const graph = require("./structural-reference-graph.js");

const emptyChainStep = () => ({ phrase: -1, transpose: 0 });
const emptyFxSlot = () => ({ command: 0, value: 0 });
const phraseStep = (note = -1) => ({ note, velocity: 100, instrument: -1, fx: [emptyFxSlot(), emptyFxSlot(), emptyFxSlot()] });

function harness() {
  const model = {
    projectName: "TEST",
    tempo: 120,
    schemaVersion: 4,
    song: Array.from({ length: 8 }, () => Array(8).fill(-1)),
    chains: {},
    phrases: {},
    instruments: [],
  };
  // Chain 00 sits in three Song cells; Phrase 05 sits in three Chain rows.
  // Both are shared, which is the situation the musician cannot currently see.
  model.chains[0] = Array.from({ length: 16 }, emptyChainStep);
  model.chains[1] = Array.from({ length: 16 }, emptyChainStep);
  model.chains[0][0] = { phrase: 5, transpose: 0 };
  model.chains[0][1] = { phrase: 5, transpose: 3 };
  model.chains[1][0] = { phrase: 5, transpose: 0 };
  model.phrases[5] = Array.from({ length: 16 }, () => phraseStep());
  model.phrases[5][0] = phraseStep(48);
  model.song[0][0] = 0;
  model.song[1][0] = 0;
  model.song[2][1] = 0;
  model.song[3][0] = 1;
  const store = new stores.ProjectStore(model, { trackCount: 8 });
  return { model, store, structure: structureTypes.install(store) };
}

// Duplicating one occurrence of a shared Phrase must move exactly that one.
{
  const { model, structure } = harness();
  assert.equal(graph.referenceCount(model, "phrase", 5), 3, "the fixture starts with a shared Phrase");

  const result = structure.duplicateAndRepoint({ kind: "phrase", chainId: 0, chainRow: 1 }, { source: "unit-duplicate" });
  assert.equal(result.mutated, true);
  assert.equal(result.sourceId, 5);
  assert.ok(Number.isInteger(result.freshId) && result.freshId !== 5, "the copy gets its own identity");

  assert.equal(model.chains[0][1].phrase, result.freshId, "the selected occurrence moved to the copy");
  assert.equal(model.chains[0][0].phrase, 5, "the other occurrence in the same Chain is untouched");
  assert.equal(model.chains[1][0].phrase, 5, "the occurrence in another Chain is untouched");
  assert.equal(graph.referenceCount(model, "phrase", 5), 2);
  assert.equal(graph.referenceCount(model, "phrase", result.freshId), 1, "the copy is not shared");

  assert.deepEqual(model.phrases[result.freshId], model.phrases[5], "the copy starts as the original's content");
  model.phrases[result.freshId][0].note = 60;
  assert.equal(model.phrases[5][0].note, 48, "editing the copy must not reach the original");

  assert.equal(model.chains[0][1].transpose, 3, "repointing must not disturb the row's other fields");
}

// The same for a Chain reached from a Song cell.
{
  const { model, structure } = harness();
  const result = structure.duplicateAndRepoint({ kind: "chain", songRow: 1, track: 0 }, { source: "unit-duplicate" });
  assert.equal(result.mutated, true);
  assert.equal(result.sourceId, 0);
  assert.equal(model.song[1][0], result.freshId);
  assert.equal(model.song[0][0], 0, "the other Song cells keep the original");
  assert.equal(model.song[2][1], 0);
  assert.deepEqual(model.chains[result.freshId], model.chains[0]);
  assert.equal(graph.referenceCount(model, "chain", 0), 2);
}

// #364's allocator contract: the fresh identity is absent from the pool and
// unreferenced by the graph, never a recycled id something still points at.
{
  const { model, structure } = harness();
  const result = structure.duplicateAndRepoint({ kind: "phrase", chainId: 0, chainRow: 0 }, { source: "unit-alloc" });
  assert.equal(Object.hasOwn(model.phrases, String(result.freshId)), true);
  assert.notEqual(result.freshId, 5);
  assert.equal(result.freshId, 0, "the first genuinely free identity is taken, not the next number after the source");
}

// One published change set covers both halves, so Undo cannot restore a copy
// without its reference or a reference without its copy.
{
  const { store, structure } = harness();
  const published = [];
  store.subscribe("project", (changeSet) => { published.push(changeSet); });
  const result = structure.duplicateAndRepoint({ kind: "phrase", chainId: 0, chainRow: 1 }, { source: "unit-atomic" });
  assert.equal(published.length, 1, "the copy and the repoint must not publish separately");
  const changeSet = published[0];
  assert.equal(changeSet.subtype, "phrase.duplicate-repoint");
  assert.equal(changeSet.transaction.operation, "duplicate-and-repoint");
  assert.equal(changeSet.transaction.repointedOccurrences, 1);
  assert.equal(changeSet.transaction.sourceId, 5);
  assert.equal(changeSet.transaction.freshId, result.freshId);
  assert.equal(changeSet.persistsProject, true);
  // The whole project is carried, which is what puts Undo in snapshot mode and
  // makes the two halves restore together.
  assert.equal(changeSet.before.chains[0][1].phrase, 5);
  assert.equal(changeSet.after.chains[0][1].phrase, result.freshId);
  assert.equal(changeSet.before.phrases[result.freshId], undefined, "the copy did not exist before");
}

// Capacity exhaustion leaves the graph exactly as it was and says why.
{
  const { model, structure } = harness();
  for (let id = 0; id <= graph.MAX_OBJECT_ID; id += 1) {
    if (!Object.hasOwn(model.phrases, String(id))) model.phrases[String(id)] = Array.from({ length: 16 }, () => phraseStep());
  }
  const before = JSON.stringify(model);
  const result = structure.duplicateAndRepoint({ kind: "phrase", chainId: 0, chainRow: 1 }, { source: "unit-full" });
  assert.equal(result.mutated, false);
  assert.equal(result.allocationFailed, true);
  assert.equal(result.reason, "pool-full");
  assert.equal(result.freshId, null, "no silent fallback to 00");
  assert.equal(JSON.stringify(model), before, "a refused duplicate must not touch the project");
}

// An Empty cell is not an occurrence, and neither is a reference to an object
// that is not in the pool.
{
  const { model, structure } = harness();
  const before = JSON.stringify(model);
  const empty = structure.duplicateAndRepoint({ kind: "phrase", chainId: 0, chainRow: 5 }, { source: "unit-empty" });
  assert.equal(empty.mutated, false);
  assert.equal(empty.reason, "empty-occurrence");
  assert.equal(empty.allocationFailed, false, "an empty cell is not a capacity problem");

  model.chains[0][6] = { phrase: 200, transpose: 0 };
  const missing = structure.duplicateAndRepoint({ kind: "phrase", chainId: 0, chainRow: 6 }, { source: "unit-missing" });
  assert.equal(missing.mutated, false);
  assert.equal(missing.reason, "missing-object");
  model.chains[0][6] = emptyChainStep();
  assert.equal(JSON.stringify(model), before, "neither refusal may leave a trace");
}

// Duplicating the last remaining occurrence is allowed: it is a rename of the
// reference, and refusing it would be a rule the musician has to learn.
{
  const { model, structure } = harness();
  const result = structure.duplicateAndRepoint({ kind: "chain", songRow: 3, track: 0 }, { source: "unit-single" });
  assert.equal(result.mutated, true);
  assert.equal(graph.referenceCount(model, "chain", 1), 0, "the original is now unreferenced, and the allocator may reuse it later");
  assert.equal(graph.referenceCount(model, "chain", result.freshId), 1);
}

// #373 acceptance: "Undo/Redo restores exact object and reference identity."
// The copy and the repoint were published as one change set, so history must
// put both back together - never an orphaned copy, never a cell pointing at an
// object that no longer exists.
{
  const { model, store, structure } = harness();
  const undo = require("./undo-redo.js");
  const root = { BRKTRKStores: { project: store }, setStatus() {}, renderAll() {} };
  const history = undo.install(root, { projectStore: store, limit: 8 });

  const before = JSON.stringify(model);
  const result = structure.duplicateAndRepoint({ kind: "phrase", chainId: 0, chainRow: 1 }, { source: "unit-history" });
  assert.equal(result.mutated, true);
  const after = JSON.stringify(model);
  assert.equal(history.snapshot().undoDepth, 1, "a duplicate is one history entry, not two");

  assert.equal(history.undo().ok, true);
  assert.equal(JSON.stringify(model), before, "Undo must restore the project exactly, copy and reference together");
  assert.equal(model.chains[0][1].phrase, 5, "the occurrence points back at the original");
  assert.equal(Object.hasOwn(model.phrases, String(result.freshId)), false, "no orphaned copy survives the Undo");
  assert.equal(graph.referenceCount(model, "phrase", 5), 3);

  assert.equal(history.redo().ok, true);
  assert.equal(JSON.stringify(model), after, "Redo must restore the same identities, not merely an equivalent shape");
  assert.equal(model.chains[0][1].phrase, result.freshId, "Redo repoints the same occurrence at the same copy id");
  history.dispose();
}

assert.throws(() => structureTypes.createDomain(new stores.ProjectStore({ song: [], chains: {}, phrases: {} }, { trackCount: 8 }))
  .duplicateAndRepoint({ kind: "instrument" }), TypeError, "this operation only knows Chain and Phrase");

console.log("Structural duplicate-and-repoint tests passed");
