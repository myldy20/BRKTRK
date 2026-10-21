const assert = require("node:assert/strict");
const stores = require("./stores.js");
const structureTypes = require("./project-structure.js");
const fields = require("./field-schema.js");

const emptyChainStep = () => ({ phrase: -1, transpose: 0 });
const emptyPhraseStep = () => ({ note: -1, velocity: 100, instrument: -1, fx: [0, 0, 0] });
const model = {
  projectName: "TEST",
  tempo: 120,
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: { 0: Array.from({ length: 16 }, emptyChainStep) },
  phrases: {},
  instruments: Array.from({ length: 16 }, (_, id) => ({ id })),
};
const state = {
  chain: 0,
  lastChain: 0,
  phrase: 0,
  lastPhrase: 0,
  focus: { pane: "song", row: 0, col: 0 },
  p3: {},
};
const projectStore = new stores.ProjectStore(model, { trackCount: 8 });
const rendered = [];

globalThis.BRKTRKStores = { project: projectStore };
globalThis.BRKTRKProjectStructure = structureTypes;
globalThis.BRKTRKFieldSchema = fields;
globalThis.BRKTRKStructuralRenderer = {
  refreshLinkedEditors(changeSet) {
    rendered.push(changeSet);
  },
};

const runtime = require("./project-structure-runtime.js");
assert.equal(runtime.domain, projectStore.structure);

const env = {
  model,
  state,
  projectStore,
  firstUnused(collection) {
    for (let id = 0; id <= 255; id += 1) if (!Object.hasOwn(collection, id)) return id;
    return 0;
  },
  chain(id, create = false) {
    if (create && !Array.isArray(model.chains[id])) model.chains[id] = Array.from({ length: 16 }, emptyChainStep);
    return model.chains[id] ?? null;
  },
  phrase(id, create = false) {
    if (create && !Array.isArray(model.phrases[id])) model.phrases[id] = Array.from({ length: 16 }, emptyPhraseStep);
    return model.phrases[id] ?? null;
  },
};

const songChainRef = fields.resolve("song", 0);
let mutation = fields.write(env, songChainRef, 0x21, { createMissing: true, source: "runtime-create-chain" });
assert.equal(mutation.after, 0x21);
assert.equal(mutation.projectChangeSet.subtype, "song.chainRef");
assert.equal(mutation.projectChangeSet.transaction.operation, "create-link");
assert.ok(Array.isArray(model.chains[0x21]));
assert.equal(state.chain, 0x21);
assert.equal(rendered.at(-1).subtype, "song.chainRef");

state.focus = { pane: "chain", row: 3, col: 0 };
const chainPhraseRef = fields.resolve("chain", 0);
mutation = fields.write(env, chainPhraseRef, 0x31, { createMissing: true, source: "runtime-create-phrase" });
assert.equal(mutation.after, 0x31);
assert.equal(mutation.projectChangeSet.subtype, "chain.phraseRef");
assert.ok(Array.isArray(model.phrases[0x31]));
assert.equal(state.phrase, 0x31);
assert.equal(rendered.at(-1).subtype, "chain.phraseRef");

const phraseObject = model.phrases[0x31];
mutation = fields.clear(env, chainPhraseRef);
assert.equal(mutation.after, -1);
assert.equal(mutation.projectChangeSet.transaction.operation, "detach");
assert.equal(model.phrases[0x31], phraseObject, "Field Schema detach must preserve the Phrase object");

state.focus = { pane: "chain", row: 3, col: 1 };
const transpose = fields.resolve("chain", 1);
mutation = fields.write(env, transpose, -99, { source: "runtime-transpose" });
assert.equal(mutation.after, -48);
assert.equal(mutation.projectChangeSet.subtype, "chain.transpose");
assert.equal(model.chains[0x21][3].transpose, -48);
assert.equal(rendered.at(-1).subtype, "chain.transpose");

const beforeNoop = rendered.length;
mutation = fields.write(env, transpose, -48, { source: "runtime-noop" });
assert.equal(mutation.mutated, false);
assert.equal(rendered.length, beforeNoop, "No-op structural Field Schema writes must not render");

console.log("M4.0A structural Field Schema runtime tests passed");
