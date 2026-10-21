const assert = require("node:assert/strict");
const storeTypes = require("./stores.js");
const phraseStepTypes = require("./project-phrase-step.js");
const structureTypes = require("./project-structure.js");
const selectionTypes = require("./selection-clipboard.js");
const undoTypes = require("./undo-redo.js");

assert.deepEqual(selectionTypes.normalizeRange(7, 3), {
  anchorRow: 7, focusRow: 3, startRow: 3, endRow: 7, rowCount: 5,
});
assert.deepEqual(selectionTypes.normalizeRectangle(7, 4, 3, 1, 16, 9), {
  anchorRow: 7, focusRow: 3, startRow: 3, endRow: 7, rowCount: 5,
  anchorCol: 4, focusCol: 1, startCol: 1, endCol: 4, colCount: 4,
});
const clipped = selectionTypes.clipRectangle([[1, 2], [3, 4], [5, 6]], 14, 8, 16, 9);
assert.equal(clipped.rowCount, 2);
assert.equal(clipped.colCount, 1);
assert.equal(clipped.clipped, true);
assert.deepEqual(clipped.cells, [[1], [3]]);

const emptyStep = () => ({
  note: -1,
  velocity: 100,
  instrument: -1,
  fx: [{ command: 0, value: 0 }, { command: 0, value: 0 }, { command: 0, value: 0 }],
  condition: { probability: 100, every: 1, offset: 0 },
  parameterEvents: [],
});
const makeStep = (row) => ({
  note: row === 0 ? 48 : row === 1 ? 52 : -1,
  velocity: 90 + row,
  instrument: row < 2 ? row + 2 : -1,
  fx: [
    { command: row === 0 ? 4 : row === 1 ? 5 : 0, value: row === 0 ? 0x40 : row === 1 ? 0x60 : 0 },
    { command: row === 0 ? 0xE7 : 0, value: row === 0 ? 0xC4 : 0 },
    { command: 0, value: 0 },
  ],
  condition: row === 0
    ? { probability: 73, every: 4, offset: 2 }
    : row === 1
      ? { probability: 100, every: 2, offset: 1 }
      : { probability: 100, every: 1, offset: 0 },
  parameterEvents: row === 0
    ? [{ instrumentId: 2, parameterId: "filter.cutoff", value: 0.42, interpolationOut: "step" }]
    : row === 1
      ? [{ instrumentId: 3, parameterId: "amp.gain", value: 0.8, interpolationOut: "linear" }]
      : [],
});
const makeChain = () => Array.from({ length: 16 }, () => ({ phrase: -1, transpose: 0 }));
const chain0 = makeChain();
chain0[0] = { phrase: 0, transpose: 3 };
chain0[1] = { phrase: 1, transpose: -5 };
chain0[4] = { phrase: -1, transpose: 12 };
chain0[5] = { phrase: -1, transpose: 7 };
const model = {
  schemaVersion: 2,
  projectName: "M42B RECT TEST",
  tempo: 120,
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: { 0: chain0, 1: makeChain(), 2: makeChain(), 3: makeChain() },
  phrases: {
    0: Array.from({ length: 16 }, (_, row) => makeStep(row)),
    1: Array.from({ length: 16 }, emptyStep),
  },
  instruments: Array.from({ length: 16 }, (_, id) => ({ id })),
};
model.song[0][0] = 0;
model.song[0][1] = 1;
model.song[1][0] = 2;
model.song[1][1] = 3;

const projectStore = new storeTypes.ProjectStore(model, { trackCount: 8 });
phraseStepTypes.install(projectStore);
structureTypes.install(projectStore);

const state = {
  view: "phrase",
  chain: 0,
  chainRow: 0,
  phrase: 0,
  phraseRow: 0,
  songRow: 0,
  track: 0,
  focus: { pane: "phrase", row: 0, col: 0 },
  p3: { activeWorkspace: "phrase" },
};
const navigationStore = new storeTypes.NavigationStore(state);
const commandListeners = new Set();
const commands = {
  installed: true,
  async dispatch(command) {
    if (command.type !== "cursor.select") throw new Error(`Unexpected fake command: ${command.type}`);
    state.focus = { pane: command.pane, row: command.row, col: command.col };
    if (command.pane === "phrase") state.phraseRow = command.row;
    if (command.pane === "chain") state.chainRow = command.row;
    if (command.pane === "song") { state.songRow = command.row; state.track = command.col; }
    const record = { command: { ...command } };
    for (const listener of [...commandListeners]) listener(record);
    return { ok: true };
  },
  subscribe(listener) { commandListeners.add(listener); return () => commandListeners.delete(listener); },
};
const diagnosticSections = new Map();
const root = {
  state,
  BRKTRKStores: { project: projectStore, navigation: navigationStore },
  BRKTRKStoreTypes: storeTypes,
  BRKTRKCommands: commands,
  BRKTRKDiagnostics: { registerSection(name, provider) { diagnosticSections.set(name, provider); } },
  setStatus() {},
  renderAll() {},
  setTimeout(callback) { callback(); return 0; },
  clearTimeout() {},
};
const undoRedo = undoTypes.install(root, { projectStore });
root.BRKTRKUndoRedo = undoRedo;
const controller = selectionTypes.createController(root, {
  projectStore, navigationStore, storeTypes, commands, diagnostics: root.BRKTRKDiagnostics, state,
});
assert.equal(commands.selectionClipboard, controller);
assert.equal(navigationStore.selectionClipboard, controller);

const focus = async (pane, row, col) => {
  await commands.dispatch({ type: "cursor.select", pane, row, col, source: "unit-cursor" });
};
const pointerFocus = async (pane, row, col) => {
  await commands.dispatch({ type: "cursor.select", pane, row, col, source: "pointer-cell" });
};

(async () => {
  // Phrase Note+Velocity rectangle copies by value and preserves untouched fields.
  await focus("phrase", 0, 0);
  await controller.dispatch({ type: "selection.begin", pane: "phrase", row: 0, col: 0, source: "unit" });
  await controller.dispatch({ type: "selection.extend", row: 1, col: 1, source: "unit" });
  let selection = controller.getSelection();
  assert.equal(selection.pane, "phrase");
  assert.equal(selection.startRow, 0);
  assert.equal(selection.endRow, 1);
  assert.equal(selection.startCol, 0);
  assert.equal(selection.endCol, 1);
  assert.equal(selection.rowCount, 2);
  assert.equal(selection.colCount, 2);
  const source0 = structuredClone(projectStore.phraseSteps.read(0, 0));
  const source1 = structuredClone(projectStore.phraseSteps.read(0, 1));
  await controller.dispatch({ type: "clipboard.copy", source: "unit" });
  assert.deepEqual(controller.getClipboardMetadata().fields, ["note", "velocity"]);
  assert.equal(controller.getClipboardMetadata().referenceSemantics, "value");
  assert.equal(controller.snapshot().pasteTarget.armed, true, "Copy must arm direct paste-target navigation");
  assert.equal(undoRedo.snapshot().undoDepth, 0, "selection/copy must not enter Project history");

  // After Copy, a plain pointer-cell click collapses to the paste destination without Escape or Project mutation.
  const destination4Before = structuredClone(projectStore.phraseSteps.read(0, 4));
  const destination5Before = structuredClone(projectStore.phraseSteps.read(0, 5));
  await pointerFocus("phrase", 4, 0);
  selection = controller.getSelection();
  assert.equal(selection.startRow, 4);
  assert.equal(selection.endRow, 4);
  assert.equal(selection.startCol, 0);
  assert.equal(selection.endCol, 0);
  assert.equal(selection.rowCount, 1);
  assert.equal(selection.colCount, 1);
  assert.equal(controller.getClipboardMetadata().rowCount, 2, "retargeting must preserve clipboard payload");
  assert.equal(controller.getClipboardMetadata().colCount, 2);
  assert.equal(undoRedo.snapshot().undoDepth, 0, "paste-target navigation must remain session-only");

  const depthBeforePhrasePaste = undoRedo.snapshot().undoDepth;
  const phrasePaste = await controller.dispatch({ type: "clipboard.paste", source: "unit-phrase-paste" });
  assert.equal(phrasePaste.rowCount, 2);
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforePhrasePaste + 1, "rectangular Phrase paste must be one Undo entry");
  const destination4After = projectStore.phraseSteps.read(0, 4);
  const destination5After = projectStore.phraseSteps.read(0, 5);
  assert.equal(destination4After.note, source0.note);
  assert.equal(destination4After.velocity, source0.velocity);
  assert.equal(destination4After.instrument, destination4Before.instrument);
  assert.deepEqual(destination4After.fx, destination4Before.fx);
  assert.deepEqual(destination4After.condition, destination4Before.condition, "partial Phrase paste must preserve destination condition");
  assert.deepEqual(destination4After.parameterEvents, destination4Before.parameterEvents, "partial Phrase paste must preserve destination ParameterEvents");
  assert.equal(destination5After.note, source1.note);
  assert.equal(destination5After.velocity, source1.velocity);
  assert.equal(destination5After.instrument, destination5Before.instrument);
  assert.deepEqual(destination5After.condition, destination5Before.condition, "partial Phrase paste must preserve destination condition");
  assert.deepEqual(destination5After.parameterEvents, destination5Before.parameterEvents, "partial Phrase paste must preserve destination ParameterEvents");

  // Successful Paste keeps the same clipboard armed so another plain click can choose another destination.
  const depthAfterPhrasePaste = undoRedo.snapshot().undoDepth;
  await pointerFocus("phrase", 8, 0);
  selection = controller.getSelection();
  assert.equal(selection.startRow, 8);
  assert.equal(selection.endRow, 8);
  assert.equal(selection.startCol, 0);
  assert.equal(selection.endCol, 0);
  assert.equal(controller.snapshot().pasteTarget.armed, true);
  assert.equal(undoRedo.snapshot().undoDepth, depthAfterPhrasePaste, "repeated retargeting must not mutate the project");

  // An explicit selection operation disarms paste-target mode and restores rectangle-extension semantics.
  await controller.dispatch({ type: "selection.begin", pane: "phrase", row: 8, col: 0, source: "unit-explicit-selection" });
  assert.equal(controller.snapshot().pasteTarget.armed, false);
  await pointerFocus("phrase", 9, 1);
  selection = controller.getSelection();
  assert.equal(selection.startRow, 8);
  assert.equal(selection.endRow, 9);
  assert.equal(selection.startCol, 0);
  assert.equal(selection.endCol, 1);

  // Desktop FX command/value are independently addressable, and full FX pairs can move lane-to-lane.
  await controller.dispatch({ type: "selection.cancel", source: "unit" });
  await focus("phrase", 0, 3);
  await controller.dispatch({ type: "selection.begin", pane: "phrase", row: 0, col: 3, source: "unit-fx" });
  await controller.dispatch({ type: "selection.extend", row: 0, col: 4, source: "unit-fx" });
  await controller.dispatch({ type: "clipboard.copy", source: "unit-fx-copy" });
  assert.deepEqual(controller.getClipboardMetadata().fields, ["fx1.command", "fx1.value"]);
  await controller.dispatch({ type: "selection.cancel", source: "unit-fx-reset" });
  await focus("phrase", 3, 5);
  const fxPaste = await controller.dispatch({ type: "clipboard.paste", source: "unit-fx-paste" });
  assert.equal(fxPaste.ok, true);
  assert.deepEqual(projectStore.phraseSteps.read(0, 3).fx[1], source0.fx[0], "FX command+value pair must move between lanes");

  // Single FX command can be copied independently from its value.
  await controller.dispatch({ type: "selection.cancel", source: "unit-fx-command-reset" });
  projectStore.phraseSteps.setFxSlot(0, 6, 1, { command: 1, value: 0x55 }, { source: "unit-setup" });
  await focus("phrase", 0, 3);
  await controller.dispatch({ type: "clipboard.copy", source: "unit-fx-command-copy" });
  assert.deepEqual(controller.getClipboardMetadata().fields, ["fx1.command"]);
  await focus("phrase", 6, 5);
  await controller.dispatch({ type: "clipboard.paste", source: "unit-fx-command-paste" });
  assert.equal(projectStore.phraseSteps.read(0, 6).fx[1].command, source0.fx[0].command);
  assert.equal(projectStore.phraseSteps.read(0, 6).fx[1].value, 0x55, "command-only paste must preserve an already-valid destination value");

  // Incompatible semantic columns fail closed instead of reinterpreting values.
  await controller.dispatch({ type: "selection.cancel", source: "unit-field-mismatch-reset" });
  await focus("phrase", 0, 1);
  await controller.dispatch({ type: "clipboard.copy", source: "unit-velocity-copy" });
  await focus("phrase", 6, 0);
  const badPaste = await controller.dispatch({ type: "clipboard.paste", source: "unit-bad-paste" });
  assert.equal(badPaste.reason, "field-mismatch");

  // Song ranges copy Chain refs, preserve sharing, and mutate atomically.
  await controller.dispatch({ type: "selection.cancel", source: "unit" });
  await focus("song", 0, 0);
  await controller.dispatch({ type: "selection.begin", pane: "song", row: 0, col: 0, source: "unit-song" });
  await controller.dispatch({ type: "selection.extend", row: 1, col: 1, source: "unit-song" });
  await controller.dispatch({ type: "clipboard.copy", source: "unit-song-copy" });
  assert.equal(controller.getClipboardMetadata().pane, "song");
  assert.equal(controller.getClipboardMetadata().referenceSemantics, "shared-reference");
  const chainKeysBefore = Object.keys(projectStore.getState().chains).sort();
  await controller.dispatch({ type: "selection.cancel", source: "unit" });
  await focus("song", 2, 2);
  const depthBeforeSongPaste = undoRedo.snapshot().undoDepth;
  const songPaste = await controller.dispatch({ type: "clipboard.paste", source: "unit-song-paste" });
  assert.equal(songPaste.rowCount, 2);
  assert.equal(songPaste.colCount, 2);
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeSongPaste + 1);
  assert.deepEqual([[model.song[2][2], model.song[2][3]], [model.song[3][2], model.song[3][3]]], [[0, 1], [2, 3]]);
  assert.deepEqual(Object.keys(projectStore.getState().chains).sort(), chainKeysBefore, "Song copy must not clone Chains");

  // Chain Phrase refs and Transpose are independently selectable.
  await controller.dispatch({ type: "selection.cancel", source: "unit" });
  state.chain = 0;
  await focus("chain", 0, 0);
  await controller.dispatch({ type: "selection.begin", pane: "chain", row: 0, col: 0, source: "unit-chain" });
  await controller.dispatch({ type: "selection.extend", row: 1, col: 0, source: "unit-chain" });
  await controller.dispatch({ type: "clipboard.copy", source: "unit-chain-copy" });
  const phraseKeysBefore = Object.keys(projectStore.getState().phrases).sort();
  await controller.dispatch({ type: "selection.cancel", source: "unit" });
  await focus("chain", 4, 0);
  const chainPaste = await controller.dispatch({ type: "clipboard.paste", source: "unit-chain-paste" });
  assert.equal(chainPaste.rowCount, 2);
  assert.equal(model.chains[0][4].phrase, 0);
  assert.equal(model.chains[0][5].phrase, 1);
  assert.equal(model.chains[0][4].transpose, 12);
  assert.equal(model.chains[0][5].transpose, 7);
  assert.deepEqual(Object.keys(projectStore.getState().phrases).sort(), phraseKeysBefore, "Chain copy must not clone Phrases");

  // Whole-row mode spans all nine Phrase data columns and remains one Undo operation.
  await controller.dispatch({ type: "selection.cancel", source: "unit" });
  await focus("phrase", 0, 2);
  await controller.dispatch({ type: "selection.begin", pane: "phrase", row: 0, rowMode: true, source: "unit-row-mode" });
  assert.equal(controller.getSelection().colCount, 9);
  await controller.dispatch({ type: "selection.extend", row: 1, rowMode: true, source: "unit-row-mode" });
  await controller.dispatch({ type: "clipboard.copy", source: "unit-row-copy" });
  await controller.dispatch({ type: "selection.cancel", source: "unit-row-copy-reset" });
  await focus("phrase", 10, 0);
  const rowPaste = await controller.dispatch({ type: "clipboard.paste", source: "unit-row-paste" });
  assert.equal(rowPaste.rowCount, 2);
  assert.deepEqual(projectStore.phraseSteps.read(0, 10), source0, "row-mode Phrase copy must include hidden condition and ParameterEvent state");
  assert.deepEqual(projectStore.phraseSteps.read(0, 11), source1, "row-mode Phrase copy must include hidden condition and ParameterEvent state");

  await controller.dispatch({ type: "selection.cancel", source: "unit-row-clear-reset" });
  await focus("phrase", 0, 2);
  await controller.dispatch({ type: "selection.begin", pane: "phrase", row: 0, rowMode: true, source: "unit-row-clear" });
  await controller.dispatch({ type: "selection.extend", row: 1, rowMode: true, source: "unit-row-clear" });
  const depthBeforeClear = undoRedo.snapshot().undoDepth;
  await controller.dispatch({ type: "selection.clear", source: "unit-clear" });
  assert.equal(undoRedo.snapshot().undoDepth, depthBeforeClear + 1);
  assert.deepEqual(projectStore.phraseSteps.read(0, 0), emptyStep());
  assert.deepEqual(projectStore.phraseSteps.read(0, 1), emptyStep());
  undoRedo.undo();
  assert.deepEqual(projectStore.phraseSteps.read(0, 0), source0);
  assert.deepEqual(projectStore.phraseSteps.read(0, 1), source1);

  const diagnostic = diagnosticSections.get("selectionClipboard")();
  assert.equal(diagnostic.clipboard.available, true);
  assert.equal(diagnostic.selection.pane, "phrase");
  assert.equal(typeof diagnostic.pasteTarget.armed, "boolean");
  assert(!Object.hasOwn(diagnostic.clipboard, "cells"));
  assert(!Object.hasOwn(state.p3.internalClipboard, "cells"));

  console.log("M4.2B command/value-aware Phrase + structural rectangle + direct paste-target tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});