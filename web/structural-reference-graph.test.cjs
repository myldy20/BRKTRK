const assert = require("node:assert/strict");
const graph = require("./structural-reference-graph.js");

const EMPTY = -1;
const song = (rows) => rows.map((row) => row.slice());
const chain = (phrases) => phrases.map((phrase) => ({ phrase, transpose: 0 }));

// One Phrase in four Chain rows, one Chain in two Song cells: the shape the
// issue is about, where editing "this row's Phrase" silently changes others.
const model = {
  song: song([[0, EMPTY, EMPTY], [0, 1, EMPTY], [EMPTY, EMPTY, EMPTY]]),
  chains: { 0: chain([5, 5, EMPTY]), 1: chain([5, 7]), 2: chain([5]) },
};

{
  const summary = graph.sharingSummary(model, "phrase", 5);
  assert.equal(summary.count, 4);
  assert.equal(summary.shared, true);
  assert.equal(summary.referenced, true);
  assert.deepEqual(summary.places.map((p) => [p.chainId, p.chainRow]), [[0, 0], [0, 1], [1, 0], [2, 0]],
    "places are the Chain rows themselves, so a caller can repoint exactly one");
}

// One occurrence is not shared. Editing it is safe, and saying "shared" there
// would be the surface crying wolf.
{
  const summary = graph.sharingSummary(model, "phrase", 7);
  assert.equal(summary.count, 1);
  assert.equal(summary.shared, false);
  assert.equal(summary.referenced, true);
}

// Unreferenced is a different fact from not-shared, and it is the one #364's
// allocator acts on.
{
  const summary = graph.sharingSummary(model, "phrase", 9);
  assert.equal(summary.count, 0);
  assert.equal(summary.shared, false);
  assert.equal(summary.referenced, false);
}

// Chains are reached from Song cells, and both coordinates are reported so one
// cell can be repointed without touching the others.
{
  const summary = graph.sharingSummary(model, "chain", 0);
  assert.equal(summary.shared, true);
  assert.deepEqual(summary.places.map((p) => [p.songRow, p.track]), [[0, 0], [1, 0]]);
  assert.equal(graph.isShared(model, "chain", 1), false, "Chain 01 appears once");
}

// Chain ids are object keys. Visiting them in insertion order would make the
// same project answer differently after a save and reload, so the order is
// numeric and stable.
{
  const shuffled = { song: song([[EMPTY]]), chains: { 10: chain([2]), 3: chain([2]), 7: chain([2]) } };
  assert.deepEqual(graph.phraseReferences(shuffled, 2).map((p) => p.chainId), [3, 7, 10]);
}

// An id outside the object space is not a reference to anything.
for (const id of [EMPTY, -2, 256, 1.5, NaN, null, undefined, "5", {}]) {
  assert.equal(graph.referenceCount(model, "phrase", id), 0, `not an object id: ${JSON.stringify(id)}`);
  assert.equal(graph.referenceCount(model, "chain", id), 0, `not an object id: ${JSON.stringify(id)}`);
}
assert.equal(graph.referenceCount(model, "instrument", 0), 0, "this graph only knows Chain and Phrase");
assert.equal(graph.referenceCount(model, undefined, 0), 0);

// EMPTY cells are absence, not a reference to object -1.
assert.equal(graph.referenceCount({ song: song([[EMPTY, EMPTY]]), chains: {} }, "chain", EMPTY), 0);

// Runs against whatever a project file contains, so a malformed model must not
// throw - it reports nothing rather than guessing.
for (const broken of [undefined, null, {}, { song: null, chains: null }, { song: [null, [0]], chains: { 0: null } }, { song: "x", chains: "y" }]) {
  assert.equal(graph.referenceCount(broken, "chain", 0) >= 0, true, `survives ${JSON.stringify(broken)}`);
  assert.equal(graph.referenceCount(broken, "phrase", 0) >= 0, true, `survives ${JSON.stringify(broken)}`);
}

// This graph and the allocator must not disagree about what is referenced: an
// object the allocator thinks is free while the graph shows an occurrence is
// exactly the silent aliasing #364 closed. field-schema.js builds the same
// answer as a Set, so compare against it directly.
{
  require("./p3-contract.js");
  const schema = require("./field-schema.js");
  const env = { model };
  const referencedChains = new Set();
  const referencedPhrases = new Set();
  for (let id = 0; id <= graph.MAX_OBJECT_ID; id += 1) {
    if (graph.referenceCount(model, "chain", id) > 0) referencedChains.add(id);
    if (graph.referenceCount(model, "phrase", id) > 0) referencedPhrases.add(id);
  }
  const allocatorChains = schema.inboundReferenceIds?.(env, "chain");
  const allocatorPhrases = schema.inboundReferenceIds?.(env, "phrase");
  if (allocatorChains && allocatorPhrases) {
    assert.deepEqual([...referencedChains].sort((a, b) => a - b), [...allocatorChains].sort((a, b) => a - b),
      "graph and allocator must agree about which Chains are referenced");
    assert.deepEqual([...referencedPhrases].sort((a, b) => a - b), [...allocatorPhrases].sort((a, b) => a - b),
      "graph and allocator must agree about which Phrases are referenced");
  }
}

// A reading of the project, so nothing consuming it can edit it.
{
  const summary = graph.sharingSummary(model, "phrase", 5);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.places), true);
  assert.equal(Object.isFrozen(summary.places[0]), true);
}

console.log("Structural reference graph tests passed");
