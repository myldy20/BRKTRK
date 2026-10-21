const assert = require("node:assert/strict");
const stores = require("./stores.js");
const entryStateTypes = require("./navigation-entry-state.js");

const state = {
  view: "phrase",
  focus: { pane: "phrase", row: 4, col: 0 },
  instrument: 3,
  p3: {
    activeWorkspace: "phrase",
    noteDockOpen: true,
    nextVelocity: 92,
    nextInstrument: 5,
    noteOctave: 6,
    editStep: 2,
    notePreview: false,
    applyPreparedEntry: false,
  },
};

const store = new stores.NavigationStore(state);
const changes = [];
store.subscribe("navigation", (changeSet) => changes.push(changeSet));
const domain = entryStateTypes.install(store);

assert.equal(store.entryState, domain);
assert.equal(entryStateTypes.install(store), domain, "entry state must install exactly once");
assert.equal(domain.getActiveSheet(), "note");
assert.deepEqual(domain.getValueReturn(), { originCursor: null, returnSheet: null, returnCursor: null });
assert.deepEqual(domain.getPreparedEntry(), {
  velocity: 92,
  instrument: 5,
  octave: 6,
  editStep: 2,
  preview: false,
  applying: false,
  locked: false,
});

assert.deepEqual(Object.keys(entryStateTypes.COMPATIBILITY_ALIASES), ["noteOctave", "editStep"]);
assert.deepEqual(entryStateTypes.RETIRED_COMPATIBILITY_ALIASES, [
  "nextVelocity",
  "nextInstrument",
  "notePreview",
  "applyPreparedEntry",
]);
assert.deepEqual(domain.retiredCompatibilityAliases, entryStateTypes.RETIRED_COMPATIBILITY_ALIASES);
for (const retired of entryStateTypes.RETIRED_COMPATIBILITY_ALIASES) {
  assert.equal(Object.hasOwn(state.p3, retired), false, `${retired} must be retired after one-time migration`);
}
for (const alias of [...Object.keys(entryStateTypes.COMPATIBILITY_ALIASES), "noteDockOpen"]) {
  const descriptor = Object.getOwnPropertyDescriptor(state.p3, alias);
  assert.equal(typeof descriptor?.get, "function", `${alias} must be a bounded compatibility getter`);
  assert.equal(typeof descriptor?.set, "function", `${alias} must route writes through NavigationStore`);
}

let mutation = domain.setPreparedEntry({ velocity: 140, instrument: -8, editStep: 3, preview: true }, { source: "test-prepared" });
assert.equal(mutation.mutated, true);
assert.deepEqual(mutation.after, {
  velocity: 127,
  instrument: -1,
  octave: 6,
  editStep: 1,
  preview: true,
  applying: false,
  locked: false,
});
assert.equal(mutation.navigationChangeSet.owner, "navigation");
assert.equal(mutation.navigationChangeSet.subtype, "preparedEntry");
assert.deepEqual(mutation.navigationChangeSet.path, ["preparedEntry"]);
assert.equal(mutation.navigationChangeSet.persistsProject, false);
assert.equal(mutation.navigationChangeSet.affectsPlayback, false);
assert.equal(state.p3.noteOctave, 6);
assert.equal(state.p3.editStep, 1);
assert.equal(changes.length, 1);
for (const retired of entryStateTypes.RETIRED_COMPATIBILITY_ALIASES) {
  assert.equal(Object.hasOwn(state.p3, retired), false, `${retired} must not be recreated by canonical writes`);
}

domain.setPreparedValue("applying", true, { source: "test-applying" });
assert.equal(domain.getPreparedEntry().applying, true);
assert.equal(changes.at(-1).source, "test-applying");
assert.equal(changes.length, 2);
domain.setPreparedValue("applying", true, { source: "test-applying-no-op" });
assert.equal(changes.length, 2, "No-op canonical writes must not notify");

domain.setPreparedLock(true, { source: "test-lock" });
assert.equal(domain.getPreparedEntry().locked, true);
assert.equal(changes.at(-1).source, "test-lock");
assert.equal(changes.at(-1).persistsProject, false);
assert.equal(changes.at(-1).affectsPlayback, false);
assert.equal(changes.length, 3);
domain.setPreparedLock(true, { source: "test-lock-no-op" });
assert.equal(changes.length, 3, "Repeated lock enable must be a stable no-op");

const lockedPrepared = {
  velocity: 110,
  instrument: 3,
  octave: 5,
  editStep: 4,
  preview: true,
  applying: false,
  locked: true,
};
const rowStep = { note: -1, velocity: 100, instrument: -1, fx: [0, 0, 0] };
assert.deepEqual(entryStateTypes.preparedPairFromStep(rowStep), { velocity: 100, instrument: -1 });
assert.deepEqual(entryStateTypes.transitionPreparedLock(lockedPrepared, rowStep, true), lockedPrepared, "Enabling lock must preserve the displayed pair");
assert.deepEqual(entryStateTypes.transitionPreparedLock(lockedPrepared, rowStep, false), {
  ...lockedPrepared,
  velocity: 100,
  instrument: -1,
  locked: false,
}, "Explicit unlock must reload both values from the row");
const inlineInstrument = entryStateTypes.transitionLockedFieldEdit(lockedPrepared, rowStep, "instrument", 1);
assert.equal(inlineInstrument.value, 4);
assert.deepEqual(inlineInstrument.prepared, {
  ...lockedPrepared,
  velocity: 100,
  instrument: 4,
  locked: false,
}, "Locked INST + must start from locked INST, preserve row VEL and unlock");
const inlineVelocity = entryStateTypes.transitionLockedFieldEdit(lockedPrepared, rowStep, "velocity", -1);
assert.equal(inlineVelocity.value, 109);
assert.deepEqual(inlineVelocity.prepared, {
  ...lockedPrepared,
  velocity: 109,
  instrument: -1,
  locked: false,
}, "Locked VEL - must start from locked VEL, preserve row INST and unlock");
assert.deepEqual(entryStateTypes.transitionLockedExactCommit(lockedPrepared, { velocity: 118, instrument: 7 }), {
  ...lockedPrepared,
  velocity: 118,
  instrument: 7,
  locked: false,
});
assert.throws(() => entryStateTypes.transitionLockedFieldEdit(lockedPrepared, rowStep, "octave", 1), /Unknown locked prepared field/);

state.p3.noteDockOpen = false;
assert.equal(domain.getActiveSheet(), null);
assert.equal(changes.at(-1).target, "navigation.activeSheet");
assert.equal(changes.length, 4);
state.p3.noteDockOpen = true;
assert.equal(domain.getActiveSheet(), "note");
assert.equal(state.p3.noteDockOpen, true);
assert.equal(changes.length, 5);
state.p3.noteOctave = 8;
assert.equal(domain.getPreparedEntry().octave, 8);
assert.equal(changes.at(-1).source, "compatibility.noteOctave");
state.p3.editStep = 4;
assert.equal(domain.getPreparedEntry().editStep, 4);
assert.equal(changes.at(-1).source, "compatibility.editStep");

mutation = domain.openValueSheet({
  originCursor: { pane: "phrase", row: 4, col: 1 },
  returnSheet: "note",
  returnCursor: { pane: "phrase", row: 4, col: 0 },
}, { source: "test-value-sheet" });
assert.equal(mutation.mutated, true);
assert.equal(mutation.before, "note");
assert.equal(mutation.after, "value");
assert.equal(state.p3.noteDockOpen, false, "Only one sheet can own input at a time");
assert.deepEqual(domain.getValueReturn(), {
  originCursor: { pane: "phrase", row: 4, col: 1 },
  returnSheet: "note",
  returnCursor: { pane: "phrase", row: 4, col: 0 },
});
assert.equal(mutation.valueReturnMutation.navigationChangeSet.target, "navigation.valueReturn");
assert.deepEqual(mutation.valueReturnMutation.navigationChangeSet.path, ["valueReturn"]);
assert.equal(mutation.valueReturnMutation.navigationChangeSet.persistsProject, false);
assert.equal(mutation.valueReturnMutation.navigationChangeSet.affectsPlayback, false);
assert.equal(mutation.sheetMutation.navigationChangeSet.subtype, "activeSheet");

mutation = domain.closeSheet("note", { source: "wrong-sheet" });
assert.equal(mutation.mutated, false);
assert.equal(domain.getActiveSheet(), "value");

mutation = domain.closeValueSheet({ source: "close-value" });
assert.equal(mutation.mutated, true);
assert.equal(domain.getActiveSheet(), null);
assert.deepEqual(mutation.returnTarget, {
  originCursor: { pane: "phrase", row: 4, col: 1 },
  returnSheet: "note",
  returnCursor: { pane: "phrase", row: 4, col: 0 },
});
assert.deepEqual(domain.getValueReturn(), { originCursor: null, returnSheet: null, returnCursor: null });

const noOpClose = domain.closeValueSheet({ source: "close-value-again" });
assert.equal(noOpClose.mutated, false, "Repeated Value Dock close must be a stable no-op");

domain.openValueSheet({
  originCursor: { pane: "chain", row: 2, col: 0 },
  returnSheet: "note",
  returnCursor: { pane: "phrase", row: 4, col: 0 },
}, { source: "switch-away-value" });
mutation = domain.openSheet("context", { source: "open-context" });
assert.equal(mutation.before, "value");
assert.equal(mutation.after, "context");
assert.equal(mutation.mutated, true);
assert.equal(mutation.valueReturnMutation?.mutated, true, "Leaving Value Dock for another sheet must clear stale exact-return state");
assert.deepEqual(domain.getValueReturn(), { originCursor: null, returnSheet: null, returnCursor: null });

for (const sheet of ["follow-scope", "note"]) {
  mutation = domain.openSheet(sheet, { source: `open-${sheet}` });
  assert.equal(domain.getActiveSheet(), sheet, `${sheet} must become the only active sheet`);
  assert.equal(mutation.after, sheet);
}

// The ASZX touch controller was retired: phone editing is native touch and gestures.
// A retired sheet name must not be re-openable, or the surface silently comes back.
assert.equal(entryStateTypes.SHEETS.includes("aszx"), false, "the retired ASZX sheet must not be registered");
assert.equal(entryStateTypes.normalizeSheet("aszx"), null, "a retired sheet name must normalize away, never to itself");
domain.openSheet("note", { source: "open-note-before-retired" });
assert.throws(
  () => domain.openSheet("aszx", { source: "open-retired-sheet" }),
  /Unknown active sheet: aszx/,
  "reopening the retired ASZX sheet must fail loudly, not silently close every sheet",
);
assert.equal(domain.getActiveSheet(), "note", "a rejected sheet name must leave the live sheet untouched");
mutation = domain.closeAll({ source: "close-all-sheets" });
assert.equal(mutation.mutated, true);
assert.equal(domain.getActiveSheet(), null);
assert.equal(domain.closeAll({ source: "close-all-again" }).mutated, false, "Repeated global close must be a stable no-op");

assert.deepEqual(entryStateTypes.normalizeValueReturn({
  originCursor: { pane: "phrase", row: 2, col: 1 },
  returnSheet: "value",
  returnCursor: { pane: "unknown", row: -1, col: 0 },
}), {
  originCursor: { pane: "phrase", row: 2, col: 1 },
  returnSheet: null,
  returnCursor: null,
});
assert.throws(() => domain.openSheet("unknown"), /Unknown active sheet/);
assert.throws(() => domain.setPreparedValue("unknown", 1), /Unknown prepared-entry field/);

console.log("NavigationStore E6 prepared-entry lock tests passed");
