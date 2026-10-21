const assert = require("node:assert/strict");
const policy = require("./touch-action-policy.js");

const chainRef = { id: "song.chainRef", type: "reference", referenceKind: "chain", editorKind: "reference" };
const phraseRef = { id: "chain.phraseRef", type: "reference", referenceKind: "phrase", editorKind: "reference" };
const transpose = { id: "chain.transpose", type: "integer", editorKind: "numeric" };
const note = { id: "phrase.note", type: "note", editorKind: "note" };
const instrument = { id: "phrase.instrument", type: "reference", referenceKind: "instrument", editorKind: "reference" };

let state = policy.describe({ workspace: "song", pane: "song", descriptor: chainRef, value: -1, childValue: -1, childKind: "chain" });
assert.equal(state.open.mode, "fresh");
assert.equal(state.open.label, "NEW CHAIN");
assert.equal(state.edit.label, "LINK CHAIN");
assert.equal(state.clear.enabled, false);
assert.equal(state.back.enabled, false);
assert.equal(state.back.visible, false, "Song is the root workspace and must not show a dead TOP action");

state = policy.describe({ workspace: "song", pane: "song", descriptor: chainRef, value: 0xAF, childValue: 0xAF, childKind: "chain", childExists: true });
assert.equal(state.open.mode, "open");
assert.equal(state.open.label, "OPEN CAF");
assert.equal(state.clear.label, "UNLINK",
  "UX0-04 (#373): the label must not read as duplicate-and-repoint; it clears one reference and keeps the object");
assert.equal(state.clear.confirm, true);

state = policy.describe({ workspace: "chain", pane: "chain", descriptor: phraseRef, value: 0x0C, childValue: 0x0C, childKind: "phrase", childExists: false });
assert.equal(state.open.mode, "repair");
assert.equal(state.open.label, "CREATE P0C");
assert.equal(state.edit.label, "EDIT REF");
assert.equal(state.back.label, "‹ SONG");
assert.equal(state.back.visible, true);
assert.equal(state.clear.label, "UNLINK",
  "UX0-04 (#373): the label must not read as duplicate-and-repoint; it clears one reference and keeps the object");

state = policy.describe({ workspace: "chain", pane: "chain", descriptor: transpose, value: 12, childValue: 0x0C, childKind: "phrase", childExists: false });
assert.equal(state.open.enabled, false, "OPEN belongs to the selected structural reference field, not a neighboring Transpose cell");
assert.equal(state.edit.label, "EDIT VALUE");
assert.equal(state.clear.label, "RESET ±0");

state = policy.describe({ workspace: "phrase", pane: "phrase", descriptor: note, value: 60 });
assert.equal(state.open.label, "SOUND");
assert.equal(state.edit.label, "EDIT NOTE");
assert.equal(state.clear.label, "EMPTY");
assert.equal(state.back.label, "‹ CHAIN");

state = policy.describe({ workspace: "phrase", pane: "phrase", descriptor: note, value: policy.EMPTY });
assert.equal(state.clear.label, "NOTE OFF");

state = policy.describe({ workspace: "phrase", pane: "phrase", descriptor: instrument, value: 3 });
assert.equal(state.clear.label, "FALLBACK");
assert.equal(state.clear.confirm, false);

state = policy.describe({ workspace: "sound", pane: "phrase", descriptor: note, value: 60, canReturn: true });
assert.equal(state.visible, true);
assert.equal(state.back.enabled, true);
assert.equal(state.back.label, "‹ PHRASE");
assert.equal(state.open.enabled, false);

state = policy.describe({ workspace: "mix", pane: "chain", descriptor: transpose, value: 0, canReturn: false });
assert.equal(state.visible, true);
assert.equal(state.back.enabled, false);
assert.equal(state.back.label, "‹ RETURN");

// UX0-03 (#373): the phone half of duplicate-and-repoint. The action keeps its
// slot on every structural reference so a column of references does not reflow
// under a moving thumb, and it is live only where there is sharing to leave.
state = policy.describe({ workspace: "song", pane: "song", descriptor: chainRef, value: 0x0A, childValue: 0x0A, childKind: "chain", childExists: true, sharedCount: 3 });
assert.equal(state.unique.visible, true);
assert.equal(state.unique.enabled, true, "a Chain reached from three Song cells is exactly what this action is for");
assert.equal(state.unique.label, "MAKE UNIQUE");
assert.equal(state.unique.command, "structure.duplicateAndRepoint",
  "UX0-03 (#373): phone and desktop must reach one semantic command, not two implementations");
assert.equal(state.unique.tone, "amber");
assert.equal(state.sharedCount, 3);
assert.notEqual(state.unique.label, state.clear.label,
  "UX0-04 (#373): the two actions must not be able to read as each other");

state = policy.describe({ workspace: "song", pane: "song", descriptor: chainRef, value: 0x0A, childValue: 0x0A, childKind: "chain", childExists: true, sharedCount: 1 });
assert.equal(state.unique.visible, true, "the slot stays so the strip keeps its shape as the cursor moves");
assert.equal(state.unique.enabled, false, "an object reached from one place is already this occurrence's own");

state = policy.describe({ workspace: "chain", pane: "chain", descriptor: phraseRef, value: policy.EMPTY, childValue: policy.EMPTY, childKind: "phrase", sharedCount: 0 });
assert.equal(state.unique.enabled, false, "an Empty cell is not an occurrence and there is nothing to copy");

// Two cells can point at a Phrase that was never created. OPEN offers to
// create it; copying something that does not exist could only ever refuse.
state = policy.describe({ workspace: "chain", pane: "chain", descriptor: phraseRef, value: 0x0C, childValue: 0x0C, childKind: "phrase", childExists: false, sharedCount: 2 });
assert.equal(state.open.mode, "repair", "the repair path is the one that applies to a reference resolving to nothing");
assert.equal(state.unique.visible, true);
assert.equal(state.unique.enabled, false, "there is no object behind this reference to copy");

state = policy.describe({ workspace: "chain", pane: "chain", descriptor: phraseRef, value: 0x0C, childValue: 0x0C, childKind: "phrase", childExists: true, sharedCount: 2 });
assert.equal(state.unique.enabled, true);
assert.equal(state.unique.visible, true);

// Not a reference: there is no object behind the cell to duplicate.
state = policy.describe({ workspace: "chain", pane: "chain", descriptor: transpose, value: 12, sharedCount: 4 });
assert.equal(state.unique.visible, false, "Transpose is a value, not a reference to a shared object");
state = policy.describe({ workspace: "phrase", pane: "phrase", descriptor: note, value: 60, sharedCount: 9 });
assert.equal(state.unique.visible, false);
state = policy.describe({ workspace: "phrase", pane: "phrase", descriptor: instrument, value: 3, sharedCount: 9 });
assert.equal(state.unique.visible, false, "Instruments are shared by design and are not duplicated by this operation");

// Every branch answers the question, so no caller ever reads undefined.
state = policy.describe({ workspace: "sound", pane: "phrase", descriptor: note, value: 60, canReturn: true });
assert.equal(state.unique.visible, false);
state = policy.describe({ workspace: "mix", pane: "chain", descriptor: transpose, value: 0, canReturn: false });
assert.equal(state.unique.visible, false);

// Absence of an answer is not an answer. A caller with no reference graph
// reports nothing, and nothing must not read as sharing.
for (const absent of [undefined, null, "", NaN, -4]) {
  const view = policy.describe({ workspace: "song", pane: "song", descriptor: chainRef, value: 0x0A, childValue: 0x0A, childKind: "chain", childExists: true, sharedCount: absent });
  assert.equal(view.unique.enabled, false, `sharedCount ${String(absent)} is not evidence of sharing`);
  assert.equal(view.sharedCount, 0, "no answer is reported as no occurrences, never as a negative or a NaN on screen");
}

// Occurrences are whole. A fractional count is one occurrence and a bug
// upstream, not two, so the action stays dark rather than offering a copy of
// something the graph could not count.
assert.equal(policy.describe({ workspace: "song", pane: "song", descriptor: chainRef, value: 0x0A, childValue: 0x0A, childKind: "chain", childExists: true, sharedCount: 1.9 }).unique.enabled, false);

// A count that arrives as text is read as the number it spells, the same way
// this module already reads value and childValue. The graph returns a number;
// this only says the surface does not become stricter than its neighbours.
assert.equal(policy.describe({ workspace: "song", pane: "song", descriptor: chainRef, value: 0x0A, childValue: 0x0A, childKind: "chain", childExists: true, sharedCount: "3" }).unique.enabled, true);

console.log("P3.4 touch-action policy tests passed");
