const assert = require("node:assert/strict");
const stores = require("./stores.js");
const phraseStepTypes = require("./project-phrase-step.js");
const navigationEntryTypes = require("./navigation-entry-state.js");
const schema = require("./field-schema.js");

const emptyChainStep = () => ({ phrase: -1, transpose: 0 });
const emptyPhraseStep = () => ({
  note: -1,
  velocity: 100,
  instrument: -1,
  fx: Array.from({ length: 3 }, () => ({ command: 0, value: 0 })),
  condition: { probability: 100, every: 1, offset: 0 },
});
const env = {
  EMPTY: -1, NOTE_OFF: -2,
  state: {
    chain: 0, phrase: 0, instrument: 0,
    focus: { pane: "song", row: 0, col: 0 },
    p3: { noteOctave: 4, nextVelocity: 93, nextInstrument: 3, applyPreparedEntry: false },
  },
  model: {
    projectName: "TEST",
    tempo: 120,
    song: [[-1]], chains: {}, phrases: {},
    instruments: Array.from({ length: 16 }, (_, index) => ({ index })),
  },
  chain(id, create = true) {
    if (!Object.hasOwn(this.model.chains, id) && create) this.model.chains[id] = Array.from({ length: 16 }, emptyChainStep);
    return this.model.chains[id];
  },
  phrase(id, create = true) {
    if (!Object.hasOwn(this.model.phrases, id) && create) this.model.phrases[id] = Array.from({ length: 16 }, emptyPhraseStep);
    return this.model.phrases[id];
  },
  firstUnused(collection) {
    for (let id = 0; id < 256; id += 1) if (!Object.hasOwn(collection, id)) return id;
    return 0;
  },
  noteName(value) { return String(value); },
  fxName(value) { return `FX${value}`; },
};
env.phrase(0, true);
env.projectStore = new stores.ProjectStore(env.model, { trackCount: 8 });
phraseStepTypes.install(env.projectStore);
env.navigationStore = new stores.NavigationStore(env.state);
env.navigationEntry = navigationEntryTypes.install(env.navigationStore);

const chainRef = schema.resolve("song", 0);
assert.equal(chainRef.id, "song.chainRef");
let mutation = schema.write(env, chainRef, 0xAF, { createMissing: true });
assert.equal(mutation.after, 0xAF);
assert.ok(Object.hasOwn(env.model.chains, 0xAF));
assert.equal(env.model.song[0][0], 0xAF);
delete env.model.chains[0xAF];
mutation = schema.write(env, chainRef, 0xAF, { createMissing: true });
assert.equal(mutation.allocated, true, "creating a missing object behind an unchanged reference is still a mutation");
assert.equal(mutation.mutated, true);

const note = schema.resolve("phrase", 0);
env.state.focus = { pane: "phrase", row: 0, col: 0 };
mutation = schema.clear(env, note);
assert.equal(mutation.after, -2, "Empty must become Note Off");
assert.equal(mutation.projectChangeSet.target, "phrase.note");
assert.deepEqual(mutation.projectChangeSet.path, ["phrases", 0, 0, "note"]);
mutation = schema.clear(env, note);
assert.equal(mutation.after, -1, "Note Off must return to Empty");
mutation = schema.adjust(env, note, "ArrowUp");
assert.equal(mutation.after, 72, "coarse Note edit starts from current C pitch and adds an octave");

const step = env.phrase(0)[0];
step.velocity = 41;
step.instrument = 1;
env.navigationEntry.setPreparedEntry({ velocity: 77, instrument: 5 }, { source: "field-schema-test" });
mutation = schema.write(env, note, 65, { source: "field-note" });
assert.equal(mutation.after, 65);
assert.equal(step.velocity, 41, "ordinary note edit must not rewrite Velocity");
assert.equal(step.instrument, 1, "ordinary note edit must not rewrite Instrument");
assert.equal(mutation.projectChangeSet.owner, "project");
assert.equal(mutation.projectChangeSet.subtype, "phrase.note");

const velocity = schema.resolve("phrase", 1);
mutation = schema.write(env, velocity, 127, { source: "field-velocity" });
assert.equal(mutation.after, 127);
assert.equal(mutation.projectChangeSet.target, "phrase.velocity");
mutation = schema.adjust(env, velocity, "ArrowUp");
assert.equal(mutation.after, 127, "Velocity clamps at 127");

const instrument = schema.resolve("phrase", 2);
mutation = schema.write(env, instrument, 3, { source: "field-instrument" });
assert.equal(mutation.after, 3);
assert.equal(env.state.instrument, 0, "Field Schema must not directly write Navigation-owned Instrument selection");
assert.equal(mutation.projectChangeSet.target, "phrase.instrument");
assert.ok(mutation.projectChangeSet.renderTargets.includes("instrument.context"));

const fx1 = schema.resolve("phrase", 3);
assert.equal(fx1.id, "phrase.fx1");
assert.equal(fx1.affectsPlayback, false, "M4.1B FX editor data stays inert until M4.1C");
assert.equal(fx1.max, 255, "command vocabulary is byte-wide and not capped to the initial registry");
mutation = schema.write(env, fx1, 0xE2, { source: "field-fx-command" });
assert.equal(mutation.after, 0xE2);
assert.equal(mutation.projectChangeSet.target, "phrase.fx.command");
assert.deepEqual(mutation.projectChangeSet.path, ["phrases", 0, 0, "fx", 0, "command"]);
assert.deepEqual(step.fx[0], { command: 0xE2, value: 0 });

let valueMutation = fx1.writeValue(env, env.state.focus, 0xA5, { source: "field-fx-value" });
assert.equal(valueMutation.after, 0xA5);
assert.equal(valueMutation.changeSet.target, "phrase.fx.value");
assert.deepEqual(step.fx[0], { command: 0xE2, value: 0xA5 });
assert.deepEqual(fx1.readSlot(env, env.state.focus), { command: 0xE2, value: 0xA5 });
assert.equal(fx1.readValue(env, env.state.focus), 0xA5);
assert.equal(schema.format(env, fx1, 0xE2), "FX226");
assert.equal(schema.parse(fx1, "FF"), 255);

const wholeSlotMutation = fx1.writeSlot(env, env.state.focus, { command: 4, value: 0x20 }, { source: "field-fx-slot" });
assert.deepEqual(wholeSlotMutation.after, { command: 4, value: 0x20 });
assert.deepEqual(step.fx[0], { command: 4, value: 0x20 });
mutation = schema.clear(env, fx1);
assert.equal(mutation.after, 0);
assert.deepEqual(step.fx[0], { command: 0, value: 0 }, "clearing an FX command clears its value through the compound-slot contract");

const probability = schema.specialDescriptors.phraseConditionProbability;
const every = schema.specialDescriptors.phraseConditionEvery;
const offset = schema.specialDescriptors.phraseConditionOffset;
assert.equal(probability.specialGroup, "phrase-condition");
assert.equal(probability.desktopSpecial, true);
assert.equal(probability.cursorBound, true);
mutation = schema.write(env, probability, 37, { source: "field-condition-probability" });
assert.equal(mutation.after, 37);
assert.deepEqual(step.condition, { probability: 37, every: 1, offset: 0 });
assert.equal(mutation.projectChangeSet.target, "phrase.condition");

mutation = schema.write(env, every, 4, { source: "field-condition-every" });
assert.equal(mutation.after, 4);
mutation = schema.write(env, offset, 3, { source: "field-condition-offset" });
assert.equal(mutation.after, 3);
assert.deepEqual(step.condition, { probability: 37, every: 4, offset: 3 });

mutation = schema.write(env, every, 2, { source: "field-condition-clamp" });
assert.equal(mutation.after, 2);
assert.deepEqual(step.condition, { probability: 37, every: 2, offset: 1 }, "reducing every must clamp offset through the Project condition owner");
mutation = schema.reset(env, probability);
assert.equal(mutation.after, 100);
mutation = schema.reset(env, every);
assert.equal(mutation.after, 1);
assert.deepEqual(step.condition, { probability: 100, every: 1, offset: 0 }, "resetting EVERY must keep OFFSET canonical");

const projectName = schema.specialDescriptors.projectName;
mutation = schema.write(env, projectName, "  night drive  ", { source: "field-test" });
assert.equal(mutation.after, "NIGHT DRIVE");
assert.equal(env.model.projectName, "NIGHT DRIVE");
assert.equal(mutation.projectChangeSet.target, "project.identity.name");
assert.deepEqual(mutation.projectChangeSet.path, ["projectName"]);
assert.equal(mutation.projectChangeSet.affectsPlayback, false);
assert.deepEqual(mutation.projectChangeSet.renderTargets, ["project.identity.name"]);

const tempo = schema.specialDescriptors.tempo;
mutation = schema.write(env, tempo, 142, { source: "field-test" });
assert.equal(mutation.after, 142);
assert.equal(env.model.tempo, 142);
assert.equal(mutation.projectChangeSet.target, "project.tempo");
assert.deepEqual(mutation.projectChangeSet.path, ["tempo"]);
assert.equal(mutation.projectChangeSet.affectsPlayback, true);

const nextVelocity = schema.specialDescriptors.nextVelocity;
mutation = schema.write(env, nextVelocity, 111);
assert.equal(mutation.after, 111);
assert.equal(env.navigationEntry.getPreparedEntry().velocity, 111);
assert.equal(Object.hasOwn(env.state.p3, "nextVelocity"), false, "Retired NEXT VEL alias must not be recreated");

const nextInstrument = schema.specialDescriptors.nextInstrument;
mutation = schema.reset(env, nextInstrument);
assert.equal(mutation.after, -1, "NEXT INST reset must select fallback");
assert.equal(env.navigationEntry.getPreparedEntry().instrument, -1);
assert.equal(Object.hasOwn(env.state.p3, "nextInstrument"), false, "Retired NEXT INST alias must not be recreated");
assert.equal(schema.parse(nextInstrument, "--"), -1);
assert.equal(schema.parse(nextInstrument, "0F"), 15);

assert.equal(schema.parse(chainRef, "FF"), 255);
assert.equal(schema.parse(velocity, "87"), 87);
console.log("M4.1B field-schema compound FX tests passed");
