const assert = require("node:assert/strict");
const stores = require("./stores.js");
const structureTypes = require("./project-structure.js");

const emptyChainStep = () => ({ phrase: -1, transpose: 0 });
const model = {
  projectName: "TEST",
  tempo: 120,
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: { 0: Array.from({ length: 16 }, emptyChainStep) },
  phrases: {},
  instruments: Array.from({ length: 16 }, (_, id) => ({ id })),
};
const store = new stores.ProjectStore(model, { trackCount: 8 });
const structure = structureTypes.install(store);
assert.equal(store.structure, structure);

const counts = { project: 0, persistence: 0, audio: 0, render: 0 };
for (const channel of Object.keys(counts)) store.subscribe(channel, () => { counts[channel] += 1; });

let mutation = structure.setSongChainRef(0, 0, 0, { source: "unit-link" });
assert.equal(mutation.after, 0);
assert.equal(model.song[0][0], 0);
assert.equal(mutation.changeSet.owner, "project");
assert.equal(mutation.changeSet.subtype, "song.chainRef");
assert.deepEqual(mutation.changeSet.path, ["song", 0, 0]);
assert.equal(mutation.changeSet.transaction.operation, "link");
assert.deepEqual(counts, { project: 1, persistence: 1, audio: 1, render: 1 });

mutation = structure.setSongChainRef(0, 1, 0xAF, { createMissing: true, source: "unit-create-chain" });
assert.equal(mutation.created, true);
assert.ok(Array.isArray(model.chains[0xAF]));
assert.equal(model.song[0][1], 0xAF);
assert.equal(mutation.changeSet.transaction.operation, "create-link");

// Repair an unchanged reference whose target object is missing.
model.song[0][2] = 0x44;
delete model.chains[0x44];
mutation = structure.setSongChainRef(0, 2, 0x44, { createMissing: true, source: "unit-repair-chain" });
assert.equal(mutation.mutated, true);
assert.equal(mutation.created, true);
assert.ok(Array.isArray(model.chains[0x44]));
assert.equal(mutation.changeSet.transaction.operation, "repair");

mutation = structure.setChainPhraseRef(0, 0, 0x22, { createMissing: true, source: "unit-create-phrase" });
assert.equal(mutation.created, true);
assert.ok(Array.isArray(model.phrases[0x22]));
assert.equal(model.chains[0][0].phrase, 0x22);
assert.equal(mutation.changeSet.subtype, "chain.phraseRef");
assert.deepEqual(mutation.changeSet.path, ["chains", 0, 0, "phrase"]);
assert.deepEqual(model.phrases[0x22][0].fx, [
  { command: 0, value: 0 },
  { command: 0, value: 0 },
  { command: 0, value: 0 },
], "new Phrase allocation must use the canonical schema-v2 compound FX shape immediately");
assert.deepEqual(
  model.phrases[0x22][0].condition,
  { probability: 100, every: 1, offset: 0 },
  "new Phrase allocation must include the canonical unconditional condition immediately",
);

const phraseObject = model.phrases[0x22];
mutation = structure.setChainPhraseRef(0, 0, -1, { source: "unit-detach-phrase" });
assert.equal(mutation.after, -1);
assert.equal(model.chains[0][0].phrase, -1);
assert.equal(model.phrases[0x22], phraseObject, "detach must preserve the Phrase object");
assert.equal(mutation.changeSet.transaction.operation, "detach");
assert.equal(mutation.changeSet.transaction.objectId, 0x22);
assert.equal(mutation.changeSet.transaction.objectPreserved, true);

const chainObject = model.chains[0xAF];
mutation = structure.setSongChainRef(0, 1, -1, { source: "unit-detach-chain" });
assert.equal(model.song[0][1], -1);
assert.equal(model.chains[0xAF], chainObject, "detach must preserve the Chain object");
assert.equal(mutation.changeSet.transaction.objectId, 0xAF);

mutation = structure.setChainTranspose(0, 0, 99, { source: "unit-transpose" });
assert.equal(mutation.after, 48);
assert.equal(model.chains[0][0].transpose, 48);
assert.equal(mutation.changeSet.subtype, "chain.transpose");
assert.deepEqual(mutation.changeSet.path, ["chains", 0, 0, "transpose"]);

const beforeNoop = { ...counts };
mutation = structure.setChainTranspose(0, 0, 48, { source: "unit-noop" });
assert.equal(mutation.mutated, false);
assert.deepEqual(counts, beforeNoop, "no-op structural writes must not notify subscribers");

assert.throws(() => structure.setChainPhraseRef(0xFE, 0, 1), /does not exist/);
assert.throws(() => structure.ensureChain(-1), /Empty/);
assert.throws(() => structure.ensurePhrase(-1), /Empty/);

console.log("M4.0A ProjectStore structural tests passed through schema-v2 Phrase allocation");
