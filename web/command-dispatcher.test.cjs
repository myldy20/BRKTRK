const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
require("./command-state.js");
require("./p3-contract.js");
require("./field-schema.js");
const { resolveInputCommand } = require("./command-dispatcher.js");

assert.deepEqual(resolveInputCommand({ code: "ArrowRight", workspace: "phrase", modifiers: { edit: true } }), { type: "field.adjust", direction: "ArrowRight", source: "input" });
assert.deepEqual(resolveInputCommand({ code: "ArrowRight", workspace: "phrase", modifiers: { edit: true, shift: true } }), { type: "hierarchy.openChild", source: "input" }, "Z hierarchy must win over stale S");
assert.deepEqual(resolveInputCommand({ code: "ArrowDown", workspace: "chain", modifiers: { shift: true } }), { type: "workspace.openMix", source: "input" });
assert.deepEqual(resolveInputCommand({ code: "ArrowRight", workspace: "mix", modifiers: {} }), { type: "mix.selectTrack", direction: "ArrowRight", source: "input" });
assert.deepEqual(resolveInputCommand({ code: "ArrowUp", workspace: "mix", modifiers: { edit: true } }), { type: "mix.adjustGain", direction: "ArrowUp", source: "input" });
assert.deepEqual(resolveInputCommand({ code: "ArrowUp", workspace: "sound", modifiers: { edit: true } }), { type: "sound.adjustParam", direction: "ArrowUp", source: "input" });
assert.equal(resolveInputCommand({ code: "KeyS", workspace: "phrase", modifiers: { option: true } }), null, "S tap is resolved on keyup so it can act as a modifier without an accidental insert");

const dispatcherSource = readFileSync(require.resolve("./command-dispatcher.js"), "utf8");
assert.ok(dispatcherSource.includes("function fieldCursor(command = null)"), "field commands must accept an explicit non-navigation cursor");
assert.ok(dispatcherSource.includes("const candidate = command?.cursor"), "field commands must read their explicit cursor from the semantic command");
assert.ok(dispatcherSource.includes("const limits = env.focusLimits(pane)"), "explicit field cursors must be normalized to the target pane");
const applyCursorBlock = dispatcherSource.match(/function applyCursor\(command, cursor, shouldFocus\) \{([\s\S]*?)\n    \}\n\n    function selectCursor/)?.[1] ?? "";
const selectCursorBlock = dispatcherSource.match(/function selectCursor\(command\) \{([\s\S]*?)\n    \}\n\n    function moveCursor/)?.[1] ?? "";
const moveCursorBlock = dispatcherSource.match(/function moveCursor\(command\) \{([\s\S]*?)\n    \}\n\n    function enterHierarchy/)?.[1] ?? "";
assert.ok(applyCursorBlock.includes("navigationStore.selectTrackerCursor"), "primary tracker cursor must write through NavigationStore");
assert.ok(selectCursorBlock.includes("applyCursor"), "cursor.select must use the shared Store-backed cursor path");
assert.ok(moveCursorBlock.includes("applyCursor"), "cursor.move must use the shared Store-backed cursor path");
for (const [name, block] of [["applyCursor", applyCursorBlock], ["selectCursor", selectCursorBlock], ["moveCursor", moveCursorBlock]]) {
  for (const forbidden of ["legacy.setFocus(", "env.state.focus ="]) {
    assert.equal(block.includes(forbidden), false, `${name} contains a direct legacy cursor mutation: ${forbidden}`);
  }
  assert.equal(/env\.state\.focus\.(pane|row|col)\s*=/.test(block), false, `${name} assigns a tracker cursor field directly`);
}

const occurrenceBlock = dispatcherSource.match(/function applyOccurrence\(command, before, target, status\) \{([\s\S]*?)\n    \}\n\n    function occurrenceNavigate\(command\) \{([\s\S]*?)\n    \}\n\n    function setMixTrack/)?.slice(1).join("\n") ?? "";
assert.ok(occurrenceBlock.includes("navigationStore.navigateOccurrence") || occurrenceBlock.includes("navigationStore.restoreContext"), "occurrence navigation must apply one complete context through NavigationStore");
assert.ok(occurrenceBlock.includes('target: "navigation.occurrence"'), "occurrence history must use the stable NavigationStore target");
assert.ok(occurrenceBlock.includes('["occurrenceContext"]'), "occurrence changes must retain their owned navigation path");
for (const forbidden of [
  "env.state.track =",
  "env.state.songRow =",
  "env.state.chain =",
  "env.state.chainRow =",
  "env.state.phrase =",
  "env.state.lastChain =",
  "env.state.lastPhrase =",
  "env.state.focus =",
  "legacy.setFocus(",
  "legacy.persist(",
  "env.audio.",
]) {
  assert.equal(occurrenceBlock.includes(forbidden), false, `occurrence navigation contains a direct legacy path: ${forbidden}`);
}

const storeSource = readFileSync(require.resolve("./stores.js"), "utf8");
const occurrenceStoreBlock = storeSource.match(/navigateOccurrence\(value, metadata = \{\}\) \{([\s\S]*?)\n    \}\n\n    restoreContext/)?.[1] ?? "";
assert.ok(occurrenceStoreBlock.includes('target: "navigation.occurrence"'), "NavigationStore must own the occurrence target");
assert.ok(occurrenceStoreBlock.includes('path: ["occurrenceContext"]'), "NavigationStore must own the occurrence context path");
assert.equal(storeSource.includes('"occurrenceContext", "mixReturn", "returnStack"'), true, "NavigationStore ownership list must include occurrenceContext and mixReturn");

const returnHierarchyBlock = dispatcherSource.match(/function returnHierarchy\(command\) \{([\s\S]*?)\n    \}\n\n    function openMix/)?.[1] ?? "";
const openMixBlock = dispatcherSource.match(/function openMix\(command\) \{([\s\S]*?)\n    \}\n\n    function fieldDescriptor/)?.[1] ?? "";
const dockToggleBlock = dispatcherSource.match(/case "dock\.toggle": \{([\s\S]*?)\n        \}\n        case "dock\.select":/)?.[1] ?? "";
assert.ok(dockToggleBlock.includes("navigationStore.enterContext"), "Instrument top-bar toggle must create a returnable NavigationStore context");
assert.ok(dockToggleBlock.includes("navigationStore.openMix"), "Mixer top-bar toggle must create a returnable NavigationStore context");
assert.ok(dockToggleBlock.includes("navigationStore.returnToParent"), "Instrument top-bar close/switch must consume its return context");
assert.ok(dockToggleBlock.includes("navigationStore.returnFromMix"), "Mixer top-bar close/switch must consume its return context");
assert.ok(returnHierarchyBlock.includes("navigationStore.returnFromMix"), "Mix return must use NavigationStore.returnFromMix");
assert.ok(openMixBlock.includes("navigationStore.openMix"), "Mix open must use NavigationStore.openMix");
assert.ok(returnHierarchyBlock.includes('target: "navigation.mix.return"'), "Mix return history must use the stable Store target");
assert.ok(openMixBlock.includes('target: "navigation.mix.open"'), "Mix open history must use the stable Store target");
for (const [name, block] of [["returnHierarchy", returnHierarchyBlock], ["openMix", openMixBlock]]) {
  for (const forbidden of [
    "env.state.p3.mixReturn",
    "env.state.p3.activeWorkspace =",
    "env.state.view =",
    "env.state.dock =",
    "legacy.persist(",
    "env.audio.",
  ]) {
    assert.equal(block.includes(forbidden), false, `${name} contains a direct Mix-return path: ${forbidden}`);
  }
}
assert.ok(storeSource.includes("openMix(metadata = {})"), "NavigationStore Mix-open contract is missing");
assert.ok(storeSource.includes("returnFromMix(metadata = {})"), "NavigationStore Mix-return contract is missing");
assert.ok(storeSource.includes('path: ["mixReturn"]'), "NavigationStore must own the Mix-return path");

const appBindingSource = readFileSync(require.resolve("./app-bind.js"), "utf8");
const mobileTabsBlock = appBindingSource.match(/\$\("#mobileTabs"\)\.addEventListener\("click",([\s\S]*?)\n  \}\);/)?.[1] ?? "";
assert.ok(mobileTabsBlock.includes('type: "workspace.openMix"'), "phone Mix tab must open a returnable Mix context");
assert.ok(mobileTabsBlock.includes('type: "workspace.select"'), "structural phone tabs must retain workspace.select");

const touchActionsSource = readFileSync(require.resolve("./touch-actions.js"), "utf8");
assert.ok(touchActionsSource.includes("navigationSelectors?.mixReturnContext"), "phone Back availability must use the Store Mix-return selector");
assert.equal(touchActionsSource.includes("state.p3?.mixReturn"), false, "touch actions must not read Mix return state directly");

const noteEntrySource = readFileSync(require.resolve("./note-entry-ui.js"), "utf8");
const preparedNoteBlock = noteEntrySource.match(/async function writePreparedNote\(value\) \{([\s\S]*?)\n  \}\n\n  async function editCurrentColumn/)?.[1] ?? "";
assert.ok(preparedNoteBlock.includes('type: "note.write"'), "prepared Note entry must dispatch the semantic project command");
assert.ok(preparedNoteBlock.includes('type: "cursor.select"'), "prepared Note auto-advance must dispatch the shared cursor command");
assert.ok(preparedNoteBlock.includes('source: "prepared-note-auto-advance"'), "prepared Note auto-advance must expose a stable semantic source");
assert.ok(preparedNoteBlock.includes("transient: true"), "prepared Note auto-advance must not create a second project/history transaction");
assert.ok(preparedNoteBlock.includes("nextRow !== startRow"), "Edit Step zero and bottom-row clamps must remain stable no-ops");
for (const forbidden of ["keyDown(", "keyUp(", 'source: "keyboard"', "openTouchController", "keyboard-or-aszx"]) {
  assert.equal(preparedNoteBlock.includes(forbidden), false, `touch Note entry must not depend on synthetic keys or the retired ASZX controller: ${forbidden}`);
}

assert.ok(noteEntrySource.includes("if (!prepared.applying && !prepared.locked) syncPreparedValuesFromStep()"), "prepared Note row sync must preserve a locked Velocity/Instrument pair through NavigationStore");
const writeNoteBlock = dispatcherSource.match(/function writeNote\(command\) \{([\s\S]*?)\n    \}\n\n    async function dispatch/)?.[1] ?? "";
for (const required of [
  'command.transaction?.kind === "prepared-note-entry"',
  "projectStore.phraseSteps.writeStep",
  "transaction?.target ?? descriptor.id",
]) {
  assert.ok(writeNoteBlock.includes(required), `prepared Note ProjectStore contract is missing: ${required}`);
}
for (const forbidden of [
  "targetStep.note =",
  "targetStep.velocity =",
  "targetStep.instrument =",
  "legacy.persist(",
  "legacy.renderAll(",
  "legacy.setFocus(",
]) {
  assert.equal(writeNoteBlock.includes(forbidden), false, `note.write contains a legacy Phrase-step path: ${forbidden}`);
}

const noteVelocityBlock = dispatcherSource.match(/case "note\.velocity": \{([\s\S]*?)\n        \}\n        case "note\.octave"/)?.[1] ?? "";
assert.ok(noteVelocityBlock.includes("fields.write"), "note.velocity must use the Field Schema ProjectStore path");
for (const forbidden of ["legacy.persist(", "legacy.renderAll(", "env.phrase("]) {
  assert.equal(noteVelocityBlock.includes(forbidden), false, `note.velocity contains a legacy Phrase-step path: ${forbidden}`);
}

const fieldSchemaSource = readFileSync(require.resolve("./field-schema.js"), "utf8");
for (const required of [
  "phraseStepDomain(env).setField",
  '"note", value',
  '"velocity", value',
  '"instrument", value',
]) {
  assert.ok(fieldSchemaSource.includes(required), `Phrase Field Schema Store path is missing: ${required}`);
}

for (const required of [
  "WHITE_KEYS",
  "BLACK_KEYS",
  'dataset.noteEntry = "p3.5-sticky"',
  'dataset.pitchLayout = "piano"',
  'dataset.valueModel = "sticky-row"',
  'dataset.entryLock = "e6"',
  "syncPreparedValuesFromStep",
  "syncMobileSheetViewport",
  "BRKTRKContextualSheetViewport?.sync",
  "BRKTRKContextualSheetViewport?.revealSelectedCell",
  'data-p33-adjust="velocity"',
  'data-p33-adjust="instrument"',
  "p33EntryLock",
  "transitionLockedFieldEdit",
  "queueAdjustment",
]) {
  assert.ok(noteEntrySource.includes(required), `mobile Note Editor contract is missing: ${required}`);
}
for (const forbidden of ["fitGridAboveSheet", "originalGridStyles", "fittedGrids"]) {
  assert.equal(noteEntrySource.includes(forbidden), false, `Note Editor retains a removed contextual geometry owner: ${forbidden}`);
}
for (const forbidden of ["THIS ROW", "NEW NOTES", "p33NextVelocity", "p33NextInstrument", "p33-value-help"]) {
  assert.equal(noteEntrySource.includes(forbidden), false, `obsolete dual-scope Note Editor UI remains: ${forbidden}`);
}
const currentAdjustBlock = noteEntrySource.match(/async function adjustCurrentField\(key, delta\) \{([\s\S]*?)\n  \}\n\n  document\.addEventListener/)?.[1] ?? "";
assert.ok(currentAdjustBlock.includes('type: "field.setExact"'), "inline controls must mutate the selected row through the semantic field command");
assert.ok(currentAdjustBlock.includes("cursor,"), "inline controls must target the underlying Phrase field explicitly");
assert.equal(currentAdjustBlock.includes('type: "cursor.select"'), false, "inline controls must not move the visible Note cursor during hold-repeat");
assert.ok(currentAdjustBlock.includes("entryState.setPreparedValue") && currentAdjustBlock.includes("entryState.setPreparedEntry"), "inline edits must update canonical prepared state for both unlocked and locked paths");

for (const forbidden of [
  "state.p3.nextVelocity =",
  "state.p3.nextInstrument =",
  "state.p3.notePreview =",
  "state.p3.applyPreparedEntry =",
  "state.p3.editStep =",
]) {
  assert.equal(noteEntrySource.includes(forbidden), false, `Note Editor contains a direct prepared-entry write: ${forbidden}`);
}
const noteOctaveBlock = dispatcherSource.match(/case "note\.octave": \{([\s\S]*?)\n        \}\n        case "note\.editStep"/)?.[1] ?? "";
const noteEditStepBlock = dispatcherSource.match(/case "note\.editStep": \{([\s\S]*?)\n        \}\n        case "tempo\.set"/)?.[1] ?? "";
assert.ok(noteOctaveBlock.includes('entryState.setPreparedValue'), "note.octave must use NavigationStore preparedEntry");
assert.ok(noteEditStepBlock.includes('entryState.setPreparedValue'), "note.editStep must use NavigationStore preparedEntry");

const noteEntryCss = readFileSync(require.resolve("./note-entry-ui.css"), "utf8");
for (const required of [
  "-webkit-user-select: none",
  "user-select: none",
  "-webkit-touch-callout: none",
  "touch-action: none",
  "-webkit-tap-highlight-color: transparent",
  "grid-template-rows: auto auto",
  ".p33-entry-lock[aria-pressed=\"true\"]",
]) {
  assert.ok(noteEntryCss.includes(required), `mobile long-press/layout contract is missing: ${required}`);
}
for (const id of ["p33Preview", "p3NoteOff", "p3NoteEmpty"]) {
  assert.ok(new RegExp(`#${id}\\s*\\{[^}]*grid-row:\\s*2`, "s").test(noteEntryCss), `${id} must stay on the shared second control row`);
}

const valueDockSource = readFileSync(require.resolve("./value-dock.js"), "utf8");
for (const required of [
  "entryState.openValueSheet",
  "entryState.closeValueSheet",
  "entryState.getValueReturn",
  "async function reopenReturnTarget",
  'source: "value-dock-note-return"',
  'returnSheet: options.returnSheet ?? null',
  'if (entryState.getValueReturn().returnSheet === "note") await close()',
  "draftOnly = Boolean(options.draftOnly)",
  "Object.hasOwn(options, \"initialValue\")",
]) {
  assert.ok(valueDockSource.includes(required), `Value Dock NavigationStore return/draft contract is missing: ${required}`);
}
for (const forbidden of ["restoreNoteDock", "restoreNoteCursor", "activeCell"]) {
  assert.equal(valueDockSource.includes(forbidden), false, `Value Dock contains a migrated local owner: ${forbidden}`);
}

console.log("M4.0A command-dispatcher tests passed");
