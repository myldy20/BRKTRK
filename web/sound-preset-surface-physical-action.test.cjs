const assert = require("node:assert/strict");

require("./production-instrument-domain.js");
const stores = require("./stores.js");
const presetDomain = require("./project-instrument-preset.js");
const userPresetDomain = require("./project-user-preset.js");

const SHA = "a".repeat(64);
const model = {
  schemaVersion: 4,
  projectName: "PRESET PHYSICAL ACTION",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {}, phrases: {}, instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};
const project = new stores.ProjectStore(model);
project.createProductionInstrument(1, {
  name: "BRK WAV",
  engineRef: {
    moduleId: "design.myldy.brk",
    engineId: "brk-wav",
    requestedVersion: "1.0.0",
    resolvedVersion: "1.0.0",
    resolvedPackageSha256: SHA,
    hostContract: "brktrk-synth-gateway-v1",
  },
  patchState: { schemaVersion: 1, encoding: "base64", data: null },
  parameterSnapshot: { cutoff: 1, level: 0.5 },
});
presetDomain.install(project);
userPresetDomain.install(project);

let playing = false;
let transportListener = null;
globalThis.BRKTRKStores = {
  project,
  transport: {
    runtime: { snapshot: () => Object.freeze({ phase: playing ? "playing" : "stopped", playing }) },
    preparedInstrumentState: { get: () => null },
    subscribe(_channel, listener) {
      transportListener = listener;
      return () => { if (transportListener === listener) transportListener = null; };
    },
  },
};
globalThis.BRKTRKProductionEngineStoreSync = {
  preparedPresetAvailability() {
    return Object.freeze({ eligible: false, code: "fixture-stop-required", reason: "fixture requires stopped transport" });
  },
};
require("./sound-preset-live-prepared-policy.js");

const preset = Object.freeze({
  id: "factory-dark", name: "Dark", bank: "Factory", origin: "brk-wav", readOnly: true, applicable: true,
  patchState: Object.freeze({ schemaVersion: 1, encoding: "base64", data: "AQIDBA==" }),
  parameterSnapshot: Object.freeze({ cutoff: 0.2, level: 0.75 }),
});
const brightPreset = Object.freeze({
  id: "factory-bright", name: "Bright", bank: "Factory", origin: "brk-wav", readOnly: true, applicable: true,
  patchState: Object.freeze({ schemaVersion: 1, encoding: "base64", data: "BQYHCA==" }),
  parameterSnapshot: Object.freeze({ cutoff: 0.85, level: 0.6 }),
});
const view = Object.freeze({
  entry: Object.freeze({ moduleId: "design.myldy.brk", engineId: "brk-wav", version: "1.0.0", packageSha256: SHA }),
  presets: Object.freeze({ presets: Object.freeze([preset, brightPreset]) }),
});

class FakeClassList { toggle() {} remove() {} add() {} }
class FakeElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.classList = new FakeClassList(); this.listeners = {}; this.isConnected = true; this.value = ""; this.disabled = false; this.replacedWith = null; }
  append(...children) { this.children.push(...children); if (this.tagName === "select" && !this.value) { const first = children.find((c) => c?.value); if (first) this.value = first.value; } }
  setAttribute() {}
  addEventListener(type, fn) { this.listeners[type] = fn; }
  replaceWith(next) { this.replacedWith = next; this.isConnected = false; if (next) next.isConnected = true; }
  click() { return this.listeners.click?.({ target: this }); }
}
globalThis.document = { createElement: (tag) => new FakeElement(tag) };

// The preset selector groups its banks, so its direct children are optgroups.
// Flatten one level to reach the options themselves.
const selectOptions = (select) => select.children.flatMap((child) => (child.tagName === "optgroup" ? child.children : [child]));
const bankOf = (select, option) => select.children
  .find((child) => child.tagName === "optgroup" && child.children.includes(option))?.label ?? null;

const surface = require("./sound-preset-surface.js");
assert.equal(surface.currentPresetId(project.getState().instrumentPool[1], view), null,
  "fresh Instrument must not claim a factory preset before explicit selection");

async function main() {
  let rerenders = 0;
  const saveOnlyView = Object.freeze({ ...view, presets: Object.freeze({ presets: Object.freeze([]) }) });
  const saveOnlyPanel = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view: saveOnlyView,
    rerender: () => { rerenders += 1; },
  });
  assert.ok(saveOnlyPanel, "verified engine without a factory bank must still expose the BRKTRK user-preset surface");
  assert.equal(saveOnlyPanel.dataset.factoryPresetCount, "0");
  const emptySelect = saveOnlyPanel.children[1].children[0];
  assert.equal(selectOptions(emptySelect)[0].textContent, "NO PRESETS · USE SAVE",
    "an engine with no factory bank must say so, not offer an empty phantom library");
  assert.equal(emptySelect.disabled, true, "empty preset menu cannot select a nonexistent factory preset");
  assert.match(emptySelect.title, /MODEL is a sound parameter, not a preset/,
    "MODEL choices are engine modes, not stored preset records");
  assert.equal(saveOnlyPanel.children[1].children[1].disabled, false,
    "empty factory banks must still allow saving the current Project sound");
  assert.equal(saveOnlyPanel.children[1].children[1].textContent, "SAVE",
    "SAVE belongs in the selector row, not in a permanent second row");
  assert.equal(saveOnlyPanel.children[2].hidden, true,
    "the name field must stay out of the way until SAVE is pressed");

  const panel = surface.renderPresetPanel({ slot: 1, instrument: project.getState().instrumentPool[1], view, rerender: () => { rerenders += 1; } });
  assert.ok(panel, "factory preset panel must render");
  const row = panel.children[1];
  const select = row.children[0];
  const reset = row.children[2];
  assert.equal(reset.textContent, "RESET", "preset row must reserve explicit action only for resetting a modified current preset");
  assert.equal(select.dataset.presetLoadAction, "true", "selector must remain an explicit full-Instrument load boundary");
  assert.equal(reset.dataset.presetLoadAction, "true", "RESET must remain an explicit full-Instrument load boundary");
  assert.equal(reset.hidden, true, "RESET must stay hidden for a fresh unmodified selection");
  assert.equal(select.value, "", "fresh Instrument must start on an explicit preset chooser rather than pretending the first factory preset is current");
  select.value = "factory-dark";
  select.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));

  const instrument = project.getState().instrumentPool[1];
  assert.equal(instrument.patchState.data, "AQIDBA==", "preset selection must deliver factory full-state bytes to Project Instrument state");
  assert.deepEqual(instrument.parameterSnapshot, { cutoff: 0.2, level: 0.75 }, "preset selection must deliver parameter snapshot atomically");
  assert.equal(instrument.presetRef.id, "factory-dark", "preset selection must retain factory provenance");
  assert.equal(surface.currentPresetId(instrument, view), "factory-dark", "Sound surface must resolve the just-applied factory preset");
  assert.equal(rerenders, 1, "successful preset selection must rerender the Sound surface exactly once");

  const livePanel = surface.renderPresetPanel({ slot: 1, instrument, view, rerender: () => { rerenders += 1; } });
  const liveRow = livePanel.children[1];
  const liveSelect = liveRow.children[0];
  playing = true;
  liveSelect.value = "factory-bright";
  liveSelect.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(project.getState().instrumentPool[1].presetRef.id, "factory-dark", "blocked live selection must not partially mutate Project Instrument state");
  assert.equal(liveSelect.value, "factory-bright", "blocked live selection must remain explicit pending intent rather than reverting to the loaded preset");
  assert.equal(livePanel.dataset.presetBlockedCode, "fixture-stop-required", "blocked live selection must expose the exact refusal gate");
  // The machine code stays addressable for diagnostics, but what a musician
  // reads is the human reason. The code used to be the visible text with the
  // reason hidden in a title tooltip, which a phone cannot reveal at all.
  assert.equal(liveRow.children[3].textContent, "fixture requires stopped transport",
    "blocked gate must explain itself in words, not in a machine code");
  assert.equal(livePanel.dataset.presetBlockedReason, "fixture requires stopped transport",
    "the human reason must stay addressable on the panel");
  assert.match(livePanel.children[0].children[1].textContent, /STOP PLAYBACK TO APPLY PRESET/, "blocked live selection must explain the safe action");
  assert.equal(livePanel.children[1].children[1].disabled, true,
    "SAVE must not capture the old sounding state while the selector displays a pending preset intent");

  playing = false;
  transportListener?.();
  await new Promise((resolve) => setImmediate(resolve));
  const afterStop = project.getState().instrumentPool[1];
  assert.equal(afterStop.presetRef.id, "factory-bright", "stopping transport must auto-apply the pending preset without a second selector action");
  assert.equal(afterStop.patchState.data, "BQYHCA==", "after-Stop auto-apply must preserve the full-state preset bytes");
  assert.deepEqual(afterStop.parameterSnapshot, { cutoff: 0.85, level: 0.6 }, "after-Stop auto-apply must preserve the parameter snapshot");
  assert.equal(rerenders, 2, "pending selection must rerender once when it auto-applies after Stop");

  const savePanel = surface.renderPresetPanel({ slot: 1, instrument: afterStop, view, rerender: () => { rerenders += 1; } });
  const saveButton = savePanel.children[1].children[1];
  const saveForm = savePanel.children[2];
  assert.equal(saveButton.textContent, "SAVE", "preset panel must expose one ordinary user-preset save action");
  assert.equal(saveButton.dataset.presetLibraryAction, "save", "SAVE must be marked as library-only, not preset-load structural work");
  assert.equal(saveForm.hidden, true, "the save form must be closed until SAVE asks for a name");
  saveButton.click();
  assert.equal(saveForm.hidden, false, "SAVE must open the name field rather than saving straight away");
  const saveName = saveForm.children[0];
  const saveCategory = saveForm.children[1];
  const confirmSave = saveForm.children[2];
  const cancelSave = saveForm.children[3];
  assert.equal(cancelSave.textContent, "CANCEL", "an opened save form must be dismissable without writing anything");
  assert.equal(saveName.value, "Bright",
    "the name field must open carrying the selected preset's name, so keeping it is the replace gesture");
  assert.equal(saveCategory.value, "",
    "a factory preset files nothing, so its copy starts with no category chosen");
  saveName.value = "My Bright";
  saveCategory.value = "Bass";
  const rerendersBeforeSave = rerenders;
  const listenerBeforeSave = transportListener;
  await confirmSave.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(savePanel.replacedWith, "SAVE must replace only the preset panel rather than remounting the whole Sound shell");
  assert.equal(rerenders, rerendersBeforeSave, "SAVE must not call the outer full-Sound rerender callback");
  assert.notEqual(transportListener, listenerBeforeSave, "panel-local SAVE rerender must transfer the active transport subscription");

  const userIds = Object.keys(project.getState().presets);
  assert.equal(userIds.length, 1, "SAVE must write one durable ProjectStore user preset");
  const userId = userIds[0];
  const stored = project.getState().presets[userId];
  assert.equal(stored.name, "My Bright");
  assert.equal(stored.category, "Bass", "the save form's category must reach the durable record");
  assert.equal(stored.patchState.data, "BQYHCA==", "SAVE must capture opaque engine state");
  assert.deepEqual(stored.parameterSnapshot, { cutoff: 0.85, level: 0.6 }, "SAVE must capture the stable parameter snapshot");
  assert.equal(stored.engine.packageSha256, SHA, "SAVE must keep the exact engine package pin");
  assert.equal(project.getState().instrumentPool[1].presetRef.id, "factory-bright", "saving must not silently change the sounding Instrument provenance");
  assert.ok(transportListener, "replacement preset panel must own the active transport subscription after SAVE");

  project.setProductionInstrumentParameter(1, "cutoff", 0.1, { source: "test-user-preset-diverge" });
  const userPanel = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view,
    rerender: () => { rerenders += 1; },
  });
  assert.equal(userPanel.dataset.factoryPresetCount, "2");
  assert.equal(userPanel.dataset.userPresetCount, "1");
  const userSelect = userPanel.children[1].children[0];
  const userOption = selectOptions(userSelect).find((option) => option.value === userId);
  assert.ok(userOption && userOption.textContent === "My Bright",
    "Factory and User presets must share one selector");
  assert.equal(bankOf(userSelect, userOption), "User \u00b7 Bass",
    "a category files the preset inside its own bank instead of flattening the list");
  userSelect.value = userId;
  userSelect.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));

  const recalled = project.getState().instrumentPool[1];
  assert.equal(recalled.presetRef.id, userId, "User preset must load through the ordinary preset selection path");
  assert.equal(recalled.presetRef.bank, "User");
  assert.equal(recalled.patchState.data, "BQYHCA==");
  assert.deepEqual(recalled.parameterSnapshot, { cutoff: 0.85, level: 0.6 });
  const recalledPanel = surface.renderPresetPanel({ slot: 1, instrument: recalled, view });
  assert.equal(recalledPanel.children[0].children[1].textContent, "CURRENT USER PRESET",
    "an exact loaded user preset must be named as user state, not factory state");

  const manageRow = recalledPanel.children[3];
  assert.equal(manageRow.hidden, false, "loaded User preset must expose its compact management row");
  const manageName = manageRow.children[0];
  const renameButton = manageRow.children[1];
  const overwriteButton = manageRow.children[2];
  const deleteButton = manageRow.children[3];
  assert.equal(renameButton.dataset.presetLibraryAction, "rename");
  assert.equal(overwriteButton.dataset.presetLibraryAction, "overwrite");
  assert.equal(deleteButton.dataset.presetLibraryAction, "delete");

  const beforeRenameInstrument = structuredClone(project.getState().instrumentPool[1]);
  manageName.value = "My Bright Renamed";
  await renameButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(project.getState().presets[userId].name, "My Bright Renamed", "RENAME must mutate only durable user-preset metadata");
  assert.deepEqual(project.getState().instrumentPool[1], beforeRenameInstrument,
    "RENAME must not mutate the currently sounding Instrument");

  project.setProductionInstrumentParameter(1, "cutoff", 0.33, { source: "test-user-preset-overwrite-diverge" });
  const overwriteInstrument = structuredClone(project.getState().instrumentPool[1]);
  const overwritePanel = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view,
    rerender: () => { rerenders += 1; },
  });
  const overwriteManageRow = overwritePanel.children[3];
  const overwriteAction = overwriteManageRow.children[2];
  assert.equal(overwriteAction.disabled, false, "loaded User preset may update its saved sound after the Instrument diverges");
  await overwriteAction.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(project.getState().presets[userId].parameterSnapshot.cutoff, 0.33,
    "UPDATE SOUND must capture the current Project-owned Instrument state");
  assert.deepEqual(project.getState().instrumentPool[1], overwriteInstrument,
    "UPDATE SOUND must not re-issue or otherwise mutate the sounding Instrument");

  // Keeping the name in the save form is the replace gesture: same record, new
  // sound, no second preset filed under the same name. The selector says so
  // beforehand - a loaded preset whose sound has drifted is marked, so a
  // musician can see there is something to save before they open the form.
  project.setProductionInstrumentParameter(1, "cutoff", 0.41, { source: "test-user-preset-save-replace" });
  const replacePanel = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view,
    rerender: () => { rerenders += 1; },
  });
  const replaceSelect = replacePanel.children[1].children[0];
  assert.equal(replaceSelect.dataset.presetModified, "true",
    "a loaded preset whose sound has drifted must be marked as modified");
  const markedOption = selectOptions(replaceSelect).find((option) => option.value === userId);
  assert.equal(markedOption.textContent, "My Bright Renamed *",
    "the mark must survive a collapsed select, where only the selected option's text is visible");
  const replaceSave = replacePanel.children[1].children[1];
  const replaceForm = replacePanel.children[2];
  replaceSave.click();
  assert.equal(replaceForm.hidden, false, "SAVE must open the form on a modified preset too");
  assert.equal(replaceForm.children[0].value, "My Bright Renamed",
    "the form must open on the loaded preset's current name");
  assert.equal(replaceForm.children[1].value, "Bass", "the form must open on the preset's own category");
  const presetsBeforeReplace = Object.keys(project.getState().presets).length;
  await replaceForm.children[2].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Object.keys(project.getState().presets).length, presetsBeforeReplace,
    "keeping the name must replace the selected User preset instead of filing a second one");
  assert.equal(project.getState().presets[userId].parameterSnapshot.cutoff, 0.41,
    "replacing must capture the current Instrument sound into the same record");
  assert.equal(project.getState().presets[userId].name, "My Bright Renamed", "replacing must not rename the record");
  assert.equal(project.getState().presets[userId].category, "Bass", "replacing must keep the preset's own filing");

  const failingOverwritePanel = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view,
    rerender: () => { rerenders += 1; },
  });
  const failingOverwriteAction = failingOverwritePanel.children[3].children[2];
  assert.equal(failingOverwriteAction.disabled, false);
  project.getState().presets[userId].engine.packageSha256 = "b".repeat(64);
  await failingOverwriteAction.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(failingOverwritePanel.children[0].children[1].textContent, /UPDATE FAILED · .*different exact engine package/,
    "failed library mutation must remain visible after controls refresh");
  project.getState().presets[userId].engine.packageSha256 = SHA;

  const deletePanel = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view,
    rerender: () => { rerenders += 1; },
  });
  const deleteManageRow = deletePanel.children[3];
  const deleteAction = deleteManageRow.children[3];
  const beforeDeleteInstrument = structuredClone(project.getState().instrumentPool[1]);
  await deleteAction.click();
  assert.equal(deleteAction.textContent, "CONFIRM DELETE", "DELETE must require an explicit second click");
  assert.ok(project.getState().presets[userId], "first DELETE click must not remove the preset");
  await deleteAction.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(project.getState().presets[userId], undefined, "confirmed DELETE must remove only the user-preset library record");
  assert.deepEqual(project.getState().instrumentPool[1], beforeDeleteInstrument,
    "deleting a loaded User preset must leave the current Instrument state and provenance untouched");

  const staleSaved = project.userPresets.save(1, { name: "Old Build", source: "test-stale-user-preset" });
  project.getState().presets[staleSaved.value.id].engine.packageSha256 = "b".repeat(64);
  const beforeStaleSelection = structuredClone(project.getState().instrumentPool[1]);
  const stalePanel = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view,
    rerender: () => { rerenders += 1; },
  });
  const staleSelect = stalePanel.children[1].children[0];
  const staleOption = selectOptions(staleSelect).find((option) => option.textContent === "Old Build · unavailable");
  assert.ok(staleOption, "preset from another exact package must stay visible as unavailable");
  assert.equal(bankOf(staleSelect, staleOption), "User", "an unavailable user preset stays in the User bank");
  staleSelect.value = staleOption.value;
  staleSelect.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleSelect.value, staleOption.value,
    "unavailable User preset must remain selected as a management target instead of snapping back");
  assert.deepEqual(project.getState().instrumentPool[1], beforeStaleSelection,
    "selecting an incompatible User preset for management must not mutate the Instrument");
  assert.match(stalePanel.children[0].children[1].textContent, /REQUIRES ITS SAVED ENGINE PACKAGE/);
  const staleManageRow = stalePanel.children[3];
  assert.equal(staleManageRow.hidden, false);
  assert.equal(staleManageRow.children[1].disabled, false, "stale User preset must remain renameable");
  assert.equal(staleManageRow.children[2].disabled, true, "stale User preset cannot overwrite sound from another package");
  assert.equal(staleManageRow.children[3].disabled, false, "stale User preset must remain deletable");
  await staleManageRow.children[3].click();
  await staleManageRow.children[3].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(project.getState().presets[staleSaved.value.id], undefined,
    "stale incompatible User preset must be removable without loading it");
  assert.deepEqual(project.getState().instrumentPool[1], beforeStaleSelection,
    "deleting an incompatible User preset must leave current sound untouched");

  // Package metadata is presentation, not ProjectStore ownership. Even a
  // factory row that spoofs User/brktrk-user/readOnly=false must never gain
  // rename/update/delete authority over a colliding real user preset.
  project.userPresets.save(1, { id: "spoof-owned", name: "Real User", source: "test-spoof-owner" });
  const spoofFactory = Object.freeze({
    id: "spoof-owned", name: "Spoof Factory", bank: "User", origin: "brktrk-user", readOnly: false, applicable: true,
    patchState: Object.freeze({ schemaVersion: 1, encoding: "base64", data: "AQIDBA==" }),
    parameterSnapshot: Object.freeze({ cutoff: 0.2, level: 0.75 }),
  });
  const spoofView = Object.freeze({
    ...view,
    presets: Object.freeze({ presets: Object.freeze([spoofFactory]) }),
  });
  const spoofPanel = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view: spoofView,
    rerender: () => { rerenders += 1; },
  });
  const spoofSelect = spoofPanel.children[1].children[0];
  const spoofFactoryOption = selectOptions(spoofSelect).find((option) => option.textContent === "Spoof Factory");
  assert.ok(spoofFactoryOption, "spoofed factory row must still be present as a factory-library row");
  assert.equal(bankOf(spoofSelect, spoofFactoryOption), "User",
    "bank metadata only places the row in a bank - it never confers ownership");
  spoofSelect.value = spoofFactoryOption.value;
  spoofSelect.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const spoofCurrent = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view: spoofView,
  });
  assert.equal(spoofCurrent.children[3].hidden, true,
    "factory metadata must never grant ProjectStore user-preset management authority");
  assert.ok(project.getState().presets["spoof-owned"],
    "selecting a spoofed factory row must not mutate/delete the colliding ProjectStore user preset");
  project.userPresets.remove("spoof-owned", { source: "test-spoof-cleanup" });

  // Factory ids belong to an engine package while user ids belong to
  // ProjectStore. They are independent namespaces, so the browser must not use
  // the durable id itself as the unique DOM selector identity.
  project.userPresets.save(1, { id: "factory-dark", name: "User Collision", source: "test-collision" });
  const collisionPanel = surface.renderPresetPanel({
    slot: 1,
    instrument: project.getState().instrumentPool[1],
    view,
    rerender: () => { rerenders += 1; },
  });
  const collisionSelect = collisionPanel.children[1].children[0];
  const factoryOption = selectOptions(collisionSelect).find((option) => option.textContent === "Dark");
  const userCollisionOption = selectOptions(collisionSelect).find((option) => option.textContent === "User Collision");
  assert.ok(factoryOption && userCollisionOption, "both colliding durable preset ids must remain visible");
  assert.notEqual(factoryOption.value, userCollisionOption.value, "factory/user id collision must be disambiguated only in browser identity");

  userCollisionOption && (collisionSelect.value = userCollisionOption.value);
  collisionSelect.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const collisionLoaded = project.getState().instrumentPool[1];
  assert.equal(collisionLoaded.presetRef.id, "factory-dark", "durable user preset id must remain unchanged by browser disambiguation");
  assert.equal(collisionLoaded.presetRef.bank, "User", "colliding user preset must not resolve to the factory preset");

  const collisionCurrent = surface.renderPresetPanel({ slot: 1, instrument: collisionLoaded, view });
  const selectedOption = selectOptions(collisionCurrent.children[1].children[0]).find(
    (option) => option.value === collisionCurrent.children[1].children[0].value,
  );
  assert.equal(selectedOption?.textContent, "User Collision",
    "provenance must select the user row, not the factory row with the same durable id");
  // The bank moved from the row's text into its group, so the distinction the
  // durable-id collision turns on has to be asserted where it now lives.
  assert.equal(bankOf(collisionCurrent.children[1].children[0], selectedOption), "User",
    "the selected row must sit under its own bank, not merely carry a matching name");

  console.log("A5 unified Factory/User preset select + SAVE/RENAME/UPDATE/DELETE regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
