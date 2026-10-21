const assert = require("node:assert/strict");
const storeTypes = require("./stores.js");
const phraseStepTypes = require("./project-phrase-step.js");
const structureTypes = require("./project-structure.js");
const selectionTypes = require("./selection-clipboard.js");
const rowTypes = require("./phrase-row-operations.js");
const undoTypes = require("./undo-redo.js");

const emptyStep = () => ({
  note: -1,
  velocity: 100,
  instrument: -1,
  fx: [{ command: 0, value: 0 }, { command: 0, value: 0 }, { command: 0, value: 0 }],
  condition: { probability: 100, every: 1, offset: 0 },
  parameterEvents: [],
});
const step = (row) => ({
  note: 36 + row,
  velocity: 64 + row,
  instrument: row,
  fx: [
    { command: 4, value: row },
    { command: 5, value: row + 16 },
    { command: 0xE7, value: row + 32 },
  ],
  condition: {
    probability: 100 - row,
    every: (row % 4) + 1,
    offset: row % ((row % 4) + 1),
  },
  parameterEvents: row % 3 === 0
    ? [{ instrumentId: row, parameterId: "filter.cutoff", value: row / 15, interpolationOut: row % 2 ? "linear" : "step" }]
    : [],
});
const rows = Array.from({ length: 16 }, (_, row) => step(row));

const inserted = rowTypes.insertRowsTransform(rows, 2, 2, emptyStep);
assert.deepEqual(inserted.rows[2], emptyStep());
assert.deepEqual(inserted.rows[3], emptyStep());
assert.deepEqual(inserted.rows[4], rows[2]);
assert.deepEqual(inserted.truncatedRows, [rows[14], rows[15]]);

const deleted = rowTypes.deleteRowsTransform(rows, 2, 2, emptyStep);
assert.deepEqual(deleted.rows[2], rows[4]);
assert.deepEqual(deleted.rows[13], rows[15]);
assert.deepEqual(deleted.rows[14], emptyStep());
assert.deepEqual(deleted.rows[15], emptyStep());
assert.deepEqual(deleted.removedRows, [rows[2], rows[3]]);

const duplicated = rowTypes.duplicateRowsTransform(rows, 2, 2);
assert.equal(duplicated.insertionRow, 4);
assert.equal(duplicated.rowCount, 2);
assert.deepEqual(duplicated.rows[4], rows[2]);
assert.deepEqual(duplicated.rows[5], rows[3]);
assert.deepEqual(duplicated.rows[6], rows[4]);
assert.deepEqual(duplicated.truncatedRows, [rows[14], rows[15]]);
assert.equal(rowTypes.duplicateRowsTransform(rows, 15, 1).rowCount, 0, "row 0F duplicate must fail closed when no row exists below it");

const makeChain = () => Array.from({ length: 16 }, () => ({ phrase: -1, transpose: 0 }));
const model = {
  schemaVersion: 2,
  projectName: "M42B2 ROW OPS",
  tempo: 120,
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: { 0: makeChain() },
  phrases: { 0: rows.map((row) => structuredClone(row)) },
  instruments: Array.from({ length: 16 }, (_, id) => ({ id })),
};
const projectStore = new storeTypes.ProjectStore(model, { trackCount: 8 });
phraseStepTypes.install(projectStore);
structureTypes.install(projectStore);
const state = {
  view: "phrase",
  chain: 0,
  chainRow: 0,
  phrase: 0,
  phraseRow: 2,
  songRow: 0,
  track: 0,
  instrument: 2,
  focus: { pane: "phrase", row: 2, col: 0 },
  p3: { activeWorkspace: "phrase", activeSheet: null },
};
const navigationStore = new storeTypes.NavigationStore(state);
Object.defineProperty(navigationStore, "entryState", {
  value: Object.freeze({ getActiveSheet: () => state.p3.activeSheet ?? null }),
  enumerable: true,
});
const listeners = new Set();
const dispatchedCursorCommands = [];
const commands = {
  installed: true,
  async dispatch(command) {
    if (command.type !== "cursor.select") throw new Error(`Unexpected fake command: ${command.type}`);
    dispatchedCursorCommands.push({ ...command });
    state.focus = { pane: command.pane, row: command.row, col: command.col };
    if (command.pane === "phrase") {
      state.phraseRow = command.row;
      const visibleStep = projectStore.phraseSteps.read(state.phrase, command.row);
      if (visibleStep?.instrument >= 0) state.instrument = visibleStep.instrument;
    }
    for (const listener of [...listeners]) listener({ command: { ...command } });
    return { ok: true };
  },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
};
const diagnostics = new Map();
const documentListeners = new Map();
const documentMock = {
  addEventListener(type, listener) { documentListeners.set(type, listener); },
  removeEventListener(type, listener) { if (documentListeners.get(type) === listener) documentListeners.delete(type); },
  querySelector(selector) {
    if (selector === "#helpDialog" || selector === "#settingsDialog") return { open: false };
    return null;
  },
};
const statuses = [];
const root = {
  state,
  BRKTRKStores: { project: projectStore, navigation: navigationStore },
  BRKTRKStoreTypes: storeTypes,
  BRKTRKCommands: commands,
  BRKTRKDiagnostics: { registerSection(name, provider) { diagnostics.set(name, provider); } },
  document: null,
  addEventListener() {},
  removeEventListener() {},
  setStatus(message) { statuses.push(message); },
  renderAll() {},
  setTimeout(callback) { callback(); return 0; },
  clearTimeout() {},
};
const undoRedo = undoTypes.install(root, { projectStore });
root.BRKTRKUndoRedo = undoRedo;
// This unit test exercises selection semantics, not phone action-bar DOM injection.
// Install the selection owner without a document, then attach the minimal keyboard DOM
// before installing the row-operation controller.
const selection = selectionTypes.createController(root, { projectStore, navigationStore, storeTypes, commands, diagnostics: root.BRKTRKDiagnostics, state });
root.BRKTRKSelectionClipboard = selection;
root.document = documentMock;
const rowOps = rowTypes.createController(root, { projectStore, navigationStore, selectionController: selection, diagnostics: root.BRKTRKDiagnostics, state });

function keyEvent({ code, key = code, ctrlKey = false, metaKey = false, shiftKey = false, altKey = false } = {}) {
  const event = {
    code,
    key,
    ctrlKey,
    metaKey,
    shiftKey,
    altKey,
    defaultPrevented: false,
    immediateStopped: false,
    target: { matches: () => false },
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediateStopped = true; },
  };
  return event;
}

async function flushKeyboardOperation() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const original = Array.from({ length: 16 }, (_, row) => projectStore.phraseSteps.read(0, row));
  const keydown = documentListeners.get("keydown");
  assert.equal(typeof keydown, "function", "row operation keyboard handler must be installed");

  // Insert begins on the already-focused NOTE cell. Result selection enters Phrase
  // before selection construction and reconciles once more after it, both with
  // focus:true so the legacy no-op Note-sheet gesture cannot fire.
  const depthBeforeInsert = undoRedo.snapshot().undoDepth;
  const cursorCommandsBeforeInsert = dispatchedCursorCommands.length;
  const insertResult = await rowOps.dispatch({ type: "phrase.rows.insert", source: "unit-insert" });
  assert.equal(insertResult.ok, true);
  assert.equal(dispatchedCursorCommands.length, cursorCommandsBeforeInsert + 2, "row result must reconcile Phrase context before and after result selection");
  const insertCursorCommand = dispatchedCursorCommands.at(-1);
  assert.equal(insertCursorCommand.focus, true, "result cursor reconciliation must suppress no-op Note-sheet opening");
  assert.deepEqual({ pane: insertCursorCommand.pane, row: insertCursorCommand.row, col: insertCursorCommand.col }, { pane: "phrase", row: 2, col: 0 });
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeInsert + 1, "insert must be exactly one Undo entry");
  assert.deepEqual(projectStore.phraseSteps.read(0, 2), emptyStep());
  assert.deepEqual(projectStore.phraseSteps.read(0, 3), original[2], "current row must shift down intact, including FX, condition and ParameterEvents");
  assert.equal(selection.getSelection().rowMode, true);
  assert.equal(selection.getSelection().startRow, 2);
  undoRedo.undo();
  await flushKeyboardOperation();
  assert.deepEqual(Array.from({ length: 16 }, (_, row) => projectStore.phraseSteps.read(0, row)), original, "Undo Insert must restore all 16 rows exactly");
  assert.equal(state.instrument, 2, "Undo Insert must keep Instrument context coherent with restored focused row");

  await commands.dispatch({ type: "cursor.select", pane: "phrase", row: 2, col: 4, source: "unit" });
  await selection.dispatch({ type: "selection.begin", pane: "phrase", row: 2, col: 4, source: "unit" });
  await selection.dispatch({ type: "selection.extend", row: 3, col: 5, source: "unit" });
  state.focus = { pane: "song", row: 0, col: 0 };
  const depthBeforeDuplicate = undoRedo.snapshot().undoDepth;
  const duplicateResult = await rowOps.dispatch({ type: "phrase.rows.duplicate", source: "unit-duplicate" });
  assert.equal(duplicateResult.ok, true, "active Phrase selection must outrank stale non-Phrase focus inside Phrase workspace");
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeDuplicate + 1, "duplicate must be exactly one Undo entry");
  assert.deepEqual(projectStore.phraseSteps.read(0, 4), original[2]);
  assert.deepEqual(projectStore.phraseSteps.read(0, 5), original[3]);
  assert.deepEqual(projectStore.phraseSteps.read(0, 6), original[4]);
  let resultSelection = selection.getSelection();
  assert.equal(resultSelection.active, true, "stale-focus row operation must restore active Phrase result selection");
  assert.equal(resultSelection.rowMode, true, "row operation result must be a full-row selection");
  assert.equal(resultSelection.startRow, 4);
  assert.equal(resultSelection.endRow, 5);
  assert.deepEqual(state.focus, { pane: "phrase", row: 4, col: 0 }, "result cursor must finish on first result row");
  assert.equal(state.instrument, 2, "result Instrument must follow first duplicated row");

  // Relative extension must start from the selection owner's stored focus edge,
  // not from the deliberately reconciled first-row cursor.
  await selection.dispatch({ type: "selection.extend", deltaRow: 1, source: "unit-result-focus-edge" });
  resultSelection = selection.getSelection();
  assert.equal(resultSelection.startRow, 4);
  assert.equal(resultSelection.endRow, 6, "relative extension must grow from stored row-5 focus edge to row 6");
  await selection.dispatch({ type: "selection.extend", row: 5, rowMode: true, source: "unit-result-focus-restore" });
  await commands.dispatch({ type: "cursor.select", pane: "phrase", row: 4, col: 0, focus: true, source: "unit-result-focus-restore" });

  undoRedo.undo();
  await flushKeyboardOperation();
  assert.deepEqual(Array.from({ length: 16 }, (_, row) => projectStore.phraseSteps.read(0, row)), original);
  assert.equal(state.instrument, 4, "Undo Duplicate must reconcile Instrument context against restored row 4");

  // Keyboard shortcut eligibility must use the same active Phrase selection fallback as direct dispatch.
  await commands.dispatch({ type: "cursor.select", pane: "phrase", row: 2, col: 0, source: "unit-keyboard" });
  await selection.dispatch({ type: "selection.begin", pane: "phrase", row: 2, col: 0, rowMode: true, source: "unit-keyboard" });
  await selection.dispatch({ type: "selection.extend", row: 3, rowMode: true, source: "unit-keyboard" });
  state.focus = { pane: "song", row: 0, col: 0 };
  const depthBeforeKeyboardDuplicate = undoRedo.snapshot().undoDepth;
  const duplicateKey = keyEvent({ code: "KeyD", key: "d", ctrlKey: true });
  keydown(duplicateKey);
  await flushKeyboardOperation();
  assert.equal(duplicateKey.defaultPrevented, true, "handled stale-focus Phrase shortcut must prevent browser behavior");
  assert.equal(duplicateKey.immediateStopped, true, "handled stale-focus Phrase shortcut must own the key event");
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeKeyboardDuplicate + 1, "keyboard duplicate must remain one Undo entry");
  assert.deepEqual(projectStore.phraseSteps.read(0, 4), original[2]);
  assert.deepEqual(projectStore.phraseSteps.read(0, 5), original[3]);
  assert.equal(selection.getSelection().active, true, "keyboard stale-focus Duplicate must keep result selection active");
  undoRedo.undo();
  await flushKeyboardOperation();
  assert.deepEqual(Array.from({ length: 16 }, (_, row) => projectStore.phraseSteps.read(0, row)), original);

  // Phrase focus/selection is deliberately retained as structural parent under Sound.
  // Hidden row operations must therefore be blocked by activeWorkspace, not by focus alone.
  state.p3.activeWorkspace = "sound";
  const depthBeforeSoundGuard = undoRedo.snapshot().undoDepth;
  const hiddenDirect = await rowOps.dispatch({ type: "phrase.rows.duplicate", source: "unit-sound-direct" });
  assert.equal(hiddenDirect.ok, false);
  assert.equal(hiddenDirect.reason, "phrase-workspace-only");
  const hiddenKey = keyEvent({ code: "KeyD", key: "d", ctrlKey: true });
  keydown(hiddenKey);
  await flushKeyboardOperation();
  assert.equal(hiddenKey.defaultPrevented, false, "Sound workspace must retain keyboard ownership");
  assert.equal(hiddenKey.immediateStopped, false, "hidden Phrase row op must not stop Sound handlers");
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeSoundGuard, "Sound workspace row op must not mutate Project history");
  assert.deepEqual(Array.from({ length: 16 }, (_, row) => projectStore.phraseSteps.read(0, row)), original);
  state.p3.activeWorkspace = "phrase";

  // Active contextual sheets outrank row shortcuts so their own key handling cannot mutate Phrase data underneath.
  state.p3.activeSheet = "context";
  const depthBeforeSheetGuard = undoRedo.snapshot().undoDepth;
  const blockedKey = keyEvent({ code: "KeyD", key: "d", ctrlKey: true });
  keydown(blockedKey);
  await flushKeyboardOperation();
  assert.equal(blockedKey.defaultPrevented, false, "active-sheet row shortcut guard must leave the event to the sheet");
  assert.equal(blockedKey.immediateStopped, false, "active-sheet row shortcut guard must not stop downstream sheet handlers");
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeSheetGuard, "active-sheet shortcut must not mutate Project history");
  assert.deepEqual(Array.from({ length: 16 }, (_, row) => projectStore.phraseSteps.read(0, row)), original);
  state.p3.activeSheet = null;

  // Deleting complete rows must reconcile the Instrument context to the new row
  // now visible under the same NOTE cursor, and Undo/Redo must reconcile it again
  // after Project history restores either snapshot.
  await commands.dispatch({ type: "cursor.select", pane: "phrase", row: 4, col: 0, focus: true, source: "unit" });
  state.instrument = 4;
  await selection.dispatch({ type: "selection.begin", pane: "phrase", row: 4, col: 0, rowMode: true, source: "unit" });
  await selection.dispatch({ type: "selection.extend", row: 5, rowMode: true, source: "unit" });
  const depthBeforeDelete = undoRedo.snapshot().undoDepth;
  const deleteResult = await rowOps.dispatch({ type: "phrase.rows.delete", source: "unit-delete" });
  assert.equal(deleteResult.ok, true);
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeDelete + 1, "delete must be exactly one Undo entry");
  assert.deepEqual(projectStore.phraseSteps.read(0, 4), original[6]);
  assert.deepEqual(projectStore.phraseSteps.read(0, 13), original[15]);
  assert.deepEqual(projectStore.phraseSteps.read(0, 14), emptyStep());
  assert.deepEqual(projectStore.phraseSteps.read(0, 15), emptyStep());
  assert.equal(state.instrument, 6, "Delete must reconcile Instrument context to the shifted visible row");
  assert.equal(dispatchedCursorCommands.at(-1).focus, true, "Delete result reconciliation must use safe focus:true cursor.select");

  undoRedo.undo();
  await flushKeyboardOperation();
  assert.deepEqual(Array.from({ length: 16 }, (_, row) => projectStore.phraseSteps.read(0, row)), original);
  assert.equal(state.instrument, 4, "Undo Delete must reconcile Instrument to the restored row payload");

  undoRedo.redo();
  await flushKeyboardOperation();
  assert.deepEqual(projectStore.phraseSteps.read(0, 4), original[6]);
  assert.equal(state.instrument, 6, "Redo Delete must reconcile Instrument to the shifted row payload again");

  undoRedo.undo();
  await flushKeyboardOperation();
  assert.deepEqual(Array.from({ length: 16 }, (_, row) => projectStore.phraseSteps.read(0, row)), original);
  assert.equal(state.instrument, 4, "second Undo Delete must restore Instrument context again");

  await selection.dispatch({ type: "selection.cancel", source: "unit" });
  await commands.dispatch({ type: "cursor.select", pane: "phrase", row: 15, col: 0, focus: true, source: "unit" });
  const depthBeforeNoRoom = undoRedo.snapshot().undoDepth;
  const noRoom = await rowOps.dispatch({ type: "phrase.rows.duplicate", source: "unit-no-room" });
  assert.equal(noRoom.reason, "no-room");
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeNoRoom, "no-room duplicate must not create history");

  // Review regression: an unchanged transform is not a successful/undoable operation.
  // Empty row 0F Insert produces the exact same fixed 16-row Phrase.
  projectStore.phraseSteps.replaceRows(0, 15, [emptyStep()], { source: "unit-no-change-setup" });
  await selection.dispatch({ type: "selection.cancel", source: "unit-no-change" });
  await commands.dispatch({ type: "cursor.select", pane: "phrase", row: 15, col: 0, focus: true, source: "unit-no-change" });
  const depthBeforeNoChange = undoRedo.snapshot().undoDepth;
  const noChange = await rowOps.dispatch({ type: "phrase.rows.insert", source: "unit-no-change" });
  assert.equal(noChange.ok, false, "unchanged row transform must not report success");
  assert.equal(noChange.reason, "no-change");
  assert.equal(noChange.mutated, false);
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeNoChange, "unchanged row transform must not create history");
  assert.match(statuses.at(-1), /NO ROW CHANGE/, "unchanged row transform must report an explicit no-change status");

  const diagnostic = diagnostics.get("phraseRowOperations")();
  assert.equal(diagnostic.workspaceRequired, "phrase");
  assert.equal(diagnostic.semantics.insert, "blank-at-start-shift-down-truncate-0F");
  assert.equal(diagnostic.semantics.delete, "remove-shift-up-empty-fill-0F");
  assert.equal(diagnostic.semantics.duplicate, "copy-after-selection-shift-down-truncate-0F");
  assert.equal(diagnostic.lastOperation?.mutated, false, "diagnostics must distinguish the last no-change attempt from a mutation");
  assert(!Object.hasOwn(diagnostic, "rows"), "diagnostics must not duplicate Phrase payloads");

  console.log("M4.2B2 deterministic Phrase row ops + stale-focus result selection + focus-edge extension + history Instrument reconciliation + workspace/sheet/no-change + one-Undo tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
