const assert = require("node:assert/strict");
const undo = require("./undo-redo.js");

const initial = { schemaVersion: 2, tempo: 120, value: 0 };
const afterOne = { schemaVersion: 2, tempo: 121, value: 0 };
const afterTwo = { schemaVersion: 2, tempo: 122, value: 0 };
const journal = new undo.ProjectHistoryJournal({ limit: 2, schemaVersion: 2 });

journal.record({ target: "project.tempo", persistsProject: true }, initial, afterOne, 1000);
assert.deepEqual(journal.snapshot(), {
  limit: 2,
  schemaVersion: 2,
  undoDepth: 1,
  redoDepth: 0,
  lastUndoTarget: "project.tempo",
  lastRedoTarget: null,
  lastInvalidation: null,
});

const undoOne = journal.takeUndo(2);
assert.deepEqual(undoOne.before, initial);
assert.deepEqual(undoOne.after, afterOne);
assert.equal(journal.snapshot().undoDepth, 0);
assert.equal(journal.snapshot().redoDepth, 1);

const redoOne = journal.takeRedo(2);
assert.equal(redoOne.id, undoOne.id);
assert.equal(journal.snapshot().undoDepth, 1);
assert.equal(journal.snapshot().redoDepth, 0);

const audioNeutralRestore = undo.createRestoreChangeSet("undo", {
  id: 41,
  target: "project.instrumentPool.3",
  changeSet: { affectsPlayback: false },
}, 2);
assert.equal(audioNeutralRestore.affectsPlayback, false, "history restore must preserve an audio-neutral durable edit");
assert.equal(audioNeutralRestore.transaction.originalAffectsPlayback, false,
  "history restore transaction must expose original audio relevance to specialized runtime owners");
const legacyRestore = undo.createRestoreChangeSet("redo", {
  id: 42,
  target: "project.instrumentPool.3.parameterSnapshot.cutoff",
}, 2);
assert.equal(legacyRestore.affectsPlayback, true,
  "older history entries without playback metadata must remain conservatively audio-relevant");
assert.equal(legacyRestore.transaction.originalAffectsPlayback, true);

journal.takeUndo(2);
journal.record({ target: "project.tempo", persistsProject: true }, initial, afterTwo, 1200);
assert.equal(journal.snapshot().redoDepth, 0, "new edit after Undo must invalidate Redo");

const transientJournal = new undo.ProjectHistoryJournal({ limit: 8, schemaVersion: 2 });
transientJournal.record({
  target: "project.instruments.0.params.1",
  persistsProject: true,
  transaction: { instrumentId: 0, parameterIndex: 1, transient: true },
}, initial, { ...initial, value: 10 }, 2000);
transientJournal.record({
  target: "project.instruments.0.params.1",
  persistsProject: true,
  transaction: { instrumentId: 0, parameterIndex: 1, transient: true },
}, { ...initial, value: 10 }, { ...initial, value: 20 }, 2200);
assert.equal(transientJournal.snapshot().undoDepth, 1, "same transient gesture must coalesce");
const transientEntry = transientJournal.takeUndo(2);
assert.deepEqual(transientEntry.before, initial);
assert.deepEqual(transientEntry.after, { ...initial, value: 20 });

const separatedJournal = new undo.ProjectHistoryJournal({ limit: 8, schemaVersion: 2 });
separatedJournal.record({
  target: "project.instruments.0.params.1",
  persistsProject: true,
  transaction: { instrumentId: 0, parameterIndex: 1, transient: true },
}, initial, { ...initial, value: 10 }, 3000);
separatedJournal.record({
  target: "project.instruments.0.params.1",
  persistsProject: true,
  transaction: { instrumentId: 0, parameterIndex: 1, transient: true },
}, { ...initial, value: 10 }, { ...initial, value: 20 }, 4000);
assert.equal(separatedJournal.snapshot().undoDepth, 2, "separate transient gestures must remain separate transactions");

const bounded = new undo.ProjectHistoryJournal({ limit: 2, schemaVersion: 2 });
bounded.record({ target: "a", persistsProject: true }, initial, { ...initial, value: 1 }, 1);
bounded.record({ target: "b", persistsProject: true }, { ...initial, value: 1 }, { ...initial, value: 2 }, 2);
bounded.record({ target: "c", persistsProject: true }, { ...initial, value: 2 }, { ...initial, value: 3 }, 3);
assert.equal(bounded.snapshot().undoDepth, 2);
assert.equal(bounded.takeUndo(2).target, "c");
assert.equal(bounded.takeUndo(2).target, "b");

const migration = new undo.ProjectHistoryJournal({ limit: 8, schemaVersion: 2 });
migration.record({ target: "project.tempo", persistsProject: true }, initial, afterOne, 1);
assert.equal(migration.takeUndo(3), null, "history must not replay across schema migration");
assert.equal(migration.snapshot().undoDepth, 0);
assert.equal(migration.snapshot().redoDepth, 0);
assert.equal(migration.snapshot().schemaVersion, 3);
assert.equal(migration.snapshot().lastInvalidation.reason, "schema-changed");

const target = { schemaVersion: 2, nested: { value: 1 }, stale: true };
const identity = target;
undo.replaceObjectState(target, { schemaVersion: 2, nested: { value: 9 }, fresh: true });
assert.equal(target, identity, "restore must preserve canonical ProjectStore object identity");
assert.deepEqual(target, { schemaVersion: 2, nested: { value: 9 }, fresh: true });

const emitted = [];
const subscribers = new Map();
const project = { schemaVersion: 2, tempo: 120, tracks: [] };
const fakeStore = {
  getState: () => project,
  subscribe(channel, listener) {
    subscribers.set(channel, listener);
    return () => subscribers.delete(channel);
  },
  publish(changeSet, channels) {
    emitted.push({ changeSet, channels: [...channels] });
    for (const channel of channels) subscribers.get(channel)?.(changeSet, project);
  },
};
const fakeRoot = {
  BRKTRKStores: { project: fakeStore },
  setStatus() {},
  renderAll() {},
};
const controller = undo.install(fakeRoot, { projectStore: fakeStore, limit: 8 });
project.tempo = 130;
fakeStore.publish({
  owner: "project",
  target: "project.tempo",
  persistsProject: true,
  affectsPlayback: true,
  transaction: null,
  source: "unit",
}, ["persistence"]);
assert.equal(controller.snapshot().undoDepth, 1);
assert.equal(controller.undo().ok, true);
assert.equal(project.tempo, 120, "Undo must restore exact prior canonical project state");
assert.equal(controller.snapshot().redoDepth, 1);
assert.equal(controller.redo().ok, true);
assert.equal(project.tempo, 130, "Redo must restore exact post-edit canonical project state");
assert.ok(emitted.some((item) => item.changeSet.target === "project.history.undo"));
assert.ok(emitted.some((item) => item.channels.includes("audio") && item.channels.includes("track-mix")), "history restore must fan out through runtime subscriber boundaries");
controller.dispose();

const soundSubscribers = new Map();
const soundProject = { schemaVersion: 3, tempo: 120, tracks: [], compatibilityExtensions: {} };
Object.defineProperty(soundProject, "instruments", {
  configurable: true,
  enumerable: false,
  writable: true,
  value: [{ params: [1, 2, 3, 4, 5, 6] }],
});
const soundStore = {
  getState: () => soundProject,
  subscribe(channel, listener) {
    soundSubscribers.set(channel, listener);
    return () => soundSubscribers.delete(channel);
  },
  publish(changeSet, channels) {
    for (const channel of channels) soundSubscribers.get(channel)?.(changeSet, soundProject);
  },
};
const soundRoot = {
  BRKTRKStores: { project: soundStore },
  setStatus() {},
  renderAll() {},
};
const soundController = undo.install(soundRoot, { projectStore: soundStore, limit: 8 });
soundProject.instruments[0].params[1] = 77;
soundStore.publish({
  owner: "project",
  target: "project.instruments.0.params.1",
  persistsProject: true,
  affectsPlayback: true,
  transaction: { instrumentId: 0, parameterIndex: 1 },
  source: "unit-sound",
}, ["persistence"]);
assert.equal(soundController.snapshot().undoDepth, 1, "non-enumerable runtime Instrument edits must enter history");
assert.equal(soundController.undo().ok, true);
assert.equal(soundProject.instruments[0].params[1], 2, "Undo must restore preview Instrument runtime state");
assert.equal(Object.keys(soundProject).includes("instruments"), false, "Undo restore must keep preview Instruments out of portable enumerable state");
assert.equal(soundController.redo().ok, true);
assert.equal(soundProject.instruments[0].params[1], 77, "Redo must restore preview Instrument runtime state");
assert.equal(Object.keys(soundProject).includes("instruments"), false, "Redo restore must keep preview Instruments non-enumerable");
soundController.dispose();

console.log("M4.2A Undo/Redo tests passed");
