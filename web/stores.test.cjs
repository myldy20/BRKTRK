const assert = require("node:assert/strict");
const stores = require("./stores.js");

const PREVIEW_EXTENSION = "org.myldydesign.brktrk.preview-instruments-v2";
const UNKNOWN_EXTENSION = "org.example.unknown";

const model = {
  projectName: "test",
  tempo: 120,
  song: [],
  chains: {},
  phrases: {},
  instruments: [],
  previewInstruments: { 0: { legacy: true } },
  compatibilityExtensions: {
    [PREVIEW_EXTENSION]: { retired: true },
    [UNKNOWN_EXTENSION]: { keep: true },
  },
};
const state = {
  view: "phrase",
  dock: "mix",
  scope: "phrase",
  playing: false,
  songRow: 0,
  track: 0,
  chain: 0,
  chainRow: 0,
  phrase: 0,
  phraseRow: 0,
  instrument: 0,
  lastChain: 0,
  lastPhrase: 0,
  focus: { pane: "phrase", row: 0, col: 0 },
};
const bundle = stores.createStores({ model, state, trackCount: 8 });

assert.equal(bundle.project.owner, "project");
assert.equal(bundle.navigation.owner, "navigation");
assert.equal(bundle.transport.owner, "transport");
assert.ok(bundle.ownership.project.includes("sourceEnvelope"));
assert.ok(bundle.ownership.navigation.includes("trackerCursor"));
assert.ok(bundle.ownership.navigation.includes("occurrenceContext"));
assert.ok(bundle.ownership.navigation.includes("mixReturn"));
assert.ok(bundle.ownership.navigation.includes("returnStack"));
assert.ok(bundle.ownership.transport.includes("queue"));

assert.equal(model.schemaVersion, stores.PROJECT_SCHEMA_VERSION);
assert.equal(model.projectName, "TEST", "project identity must normalize on store creation");
assert.equal(model.sourceFormat, "brktrk");
assert.equal(model.sourceVersion, null);
assert.deepEqual(model.sourceMetadata, {});
assert.equal(Object.hasOwn(model, "instruments"), false, "legacy preview Instrument owner must be deleted on store creation");
assert.equal(Object.hasOwn(model, "previewInstruments"), false, "preview runtime compatibility state must be deleted on store creation");
assert.equal(Object.hasOwn(model.compatibilityExtensions, PREVIEW_EXTENSION), false, "retired preview compatibility entry must be deleted on store creation");
assert.equal(model.compatibilityExtensions[UNKNOWN_EXTENSION].keep, true, "unrelated compatibility data must survive ProjectStore normalization");
assert.deepEqual(model.unknownData, []);
assert.equal(model.tracks.length, 8);
for (const domain of ["tables", "grooves", "scales", "modulation", "mixer", "master", "effects", "assets", "presets", "mappings"]) {
  assert.deepEqual(model[domain], {}, `${domain} must be reserved without fake UI state`);
}

const calls = { project: 0, persistence: 0, audio: 0, render: 0 };
const changes = {};
for (const channel of Object.keys(calls)) {
  bundle.project.subscribe(channel, (changeSet) => {
    calls[channel] += 1;
    changes[channel] = changeSet;
  });
}

const tempoMutation = bundle.project.setTempo(137, { source: "unit" });
assert.equal(tempoMutation.value, 137);
assert.equal(tempoMutation.mutated, true);
assert.equal(model.tempo, 137);
assert.deepEqual(calls, { project: 1, persistence: 1, audio: 1, render: 1 });
for (const channel of Object.keys(calls)) {
  assert.equal(changes[channel].kind, "project");
  assert.equal(changes[channel].target, "project.tempo");
  assert.deepEqual(changes[channel].path, ["tempo"]);
  assert.equal(changes[channel].before, 120);
  assert.equal(changes[channel].after, 137);
  assert.equal(changes[channel].affectsPlayback, true);
  assert.equal(changes[channel].persistsProject, true);
  assert.deepEqual(changes[channel].renderTargets, ["transport.tempo"]);
}

const unchangedTempo = bundle.project.setTempo(137);
assert.equal(unchangedTempo.mutated, false);
assert.deepEqual(calls, { project: 1, persistence: 1, audio: 1, render: 1 }, "unchanged tempo must not notify subscribers");
assert.equal(bundle.project.setTempo(999).after, 300);
assert.equal(bundle.project.select(stores.selectors.tempo), 300);
assert.throws(() => bundle.project.setTempo("nope"), /numeric/);

const beforeRename = { ...calls };
const renameMutation = bundle.project.renameProject("  night drive  ", { source: "unit" });
assert.equal(renameMutation.value, "NIGHT DRIVE");
assert.equal(renameMutation.mutated, true);
assert.equal(model.projectName, "NIGHT DRIVE");
assert.deepEqual(calls, {
  project: beforeRename.project + 1,
  persistence: beforeRename.persistence + 1,
  audio: beforeRename.audio,
  render: beforeRename.render + 1,
}, "project identity must not notify audio subscribers");
for (const channel of ["project", "persistence", "render"]) {
  assert.equal(changes[channel].target, "project.identity.name");
  assert.deepEqual(changes[channel].path, ["projectName"]);
  assert.equal(changes[channel].before, "TEST");
  assert.equal(changes[channel].after, "NIGHT DRIVE");
  assert.equal(changes[channel].affectsPlayback, false);
  assert.deepEqual(changes[channel].renderTargets, ["project.identity.name"]);
}

const unchangedNameCalls = { ...calls };
const unchangedName = bundle.project.renameProject("night drive");
assert.equal(unchangedName.mutated, false);
assert.deepEqual(calls, unchangedNameCalls, "unchanged project identity must not notify subscribers");
const longName = bundle.project.renameProject("abcdefghijklmnopqrstuvwxyz0123456789");
assert.equal(longName.after, "ABCDEFGHIJKLMNOPQRSTUVWX");
assert.equal(longName.after.length, 24);
assert.equal(bundle.project.select(stores.selectors.projectName), longName.after);
assert.throws(() => bundle.project.renameProject("   "), /must not be empty/);

let navigationCalls = 0;
let navigationChange = null;
bundle.navigation.subscribe("navigation", (changeSet) => {
  navigationCalls += 1;
  navigationChange = changeSet;
});
assert.equal(bundle.navigation.select(stores.selectors.activeWorkspace), "phrase");
const workspaceMutation = bundle.navigation.selectWorkspace("chain", { source: "unit" });
assert.equal(workspaceMutation.mutated, true);
assert.equal(workspaceMutation.value, "chain");
assert.equal(state.view, "chain");
assert.equal(state.p3.activeWorkspace, "chain");
assert.equal(navigationCalls, 1);
assert.equal(navigationChange.kind, "cursor");
assert.equal(navigationChange.target, "navigation.workspace");
assert.deepEqual(navigationChange.path, ["activeWorkspace"]);
assert.equal(navigationChange.before, "phrase");
assert.equal(navigationChange.after, "chain");
assert.equal(navigationChange.affectsPlayback, false);
assert.equal(navigationChange.persistsProject, false);
assert.deepEqual(navigationChange.renderTargets, ["navigation.workspace"]);
assert.equal(bundle.navigation.select(stores.selectors.activeWorkspace), "chain");
assert.equal(bundle.navigation.selectWorkspace("chain").mutated, false);
assert.equal(navigationCalls, 1, "unchanged workspace must not notify navigation subscribers");
assert.throws(() => bundle.navigation.selectWorkspace("tables"), /Unknown workspace/);

const cursorCallsBefore = navigationCalls;
const cursorMutation = bundle.navigation.selectTrackerCursor(
  { pane: "chain", row: 6, col: 1 },
  { chainRow: 6, phrase: 22, lastPhrase: 22 },
  { source: "unit-cursor" },
);
assert.equal(cursorMutation.mutated, true);
assert.deepEqual(cursorMutation.value, { pane: "chain", row: 6, col: 1 });
assert.deepEqual(state.focus, { pane: "chain", row: 6, col: 1 });
assert.equal(state.chainRow, 6);
assert.equal(state.phrase, 22);
assert.equal(state.lastPhrase, 22);
assert.equal(navigationCalls, cursorCallsBefore + 1);
assert.equal(navigationChange.target, "navigation.trackerCursor");
assert.deepEqual(navigationChange.path, ["trackerCursor"]);
assert.deepEqual(navigationChange.before.cursor, { pane: "phrase", row: 0, col: 0 });
assert.deepEqual(navigationChange.after.cursor, { pane: "chain", row: 6, col: 1 });
assert.equal(navigationChange.before.context.chainRow, 0);
assert.equal(navigationChange.after.context.chainRow, 6);
assert.equal(navigationChange.persistsProject, false);
assert.equal(navigationChange.affectsPlayback, false);
assert.deepEqual(navigationChange.renderTargets, ["navigation.focus", "navigation.context"]);
assert.deepEqual(bundle.navigation.select(stores.selectors.trackerCursor), { pane: "chain", row: 6, col: 1 });

const cursorCallsUnchanged = navigationCalls;
const unchangedCursor = bundle.navigation.selectTrackerCursor(
  { pane: "chain", row: 6, col: 1 },
  { chainRow: 6, phrase: 22, lastPhrase: 22 },
);
assert.equal(unchangedCursor.mutated, false);
assert.equal(navigationCalls, cursorCallsUnchanged, "unchanged cursor/context must not notify subscribers");

const clampedByNormalizer = bundle.navigation.selectTrackerCursor({ pane: "tables", row: -4, col: -2 });
assert.deepEqual(clampedByNormalizer.value, { pane: "chain", row: 0, col: 0 }, "Store must reject unknown panes and negative coordinates");
assert.deepEqual(state.focus, { pane: "chain", row: 0, col: 0 });

const parentContext = {
  view: "song",
  activeWorkspace: "song",
  dock: "mix",
  focus: { pane: "song", row: 3, col: 2 },
  songRow: 3,
  track: 2,
  chain: 7,
  chainRow: 4,
  phrase: 12,
  phraseRow: 6,
  instrument: 5,
  soundParam: 2,
  lastChain: 7,
  lastPhrase: 12,
};
const restoreBaseline = bundle.navigation.restoreContext(parentContext, { source: "unit-baseline" });
assert.equal(restoreBaseline.mutated, true);
assert.equal(bundle.navigation.select(stores.selectors.returnDepth), 0);

const occurrenceCallsBefore = navigationCalls;
const occurrenceContext = {
  ...parentContext,
  view: "chain",
  activeWorkspace: "chain",
  focus: { pane: "chain", row: 5, col: 1 },
  songRow: 11,
  track: 1,
  chain: 9,
  chainRow: 5,
  phrase: 14,
  lastChain: 9,
  lastPhrase: 14,
};
const occurrenceMutation = bundle.navigation.navigateOccurrence(occurrenceContext, { source: "unit-occurrence" });
assert.equal(occurrenceMutation.mutated, true);
assert.equal(navigationCalls, occurrenceCallsBefore + 1);
assert.equal(state.songRow, 11);
assert.equal(state.track, 1);
assert.equal(state.chain, 9);
assert.equal(state.chainRow, 5);
assert.equal(state.phrase, 14);
assert.deepEqual(state.focus, { pane: "chain", row: 5, col: 1 });
assert.equal(navigationChange.target, "navigation.occurrence");
assert.deepEqual(navigationChange.path, ["occurrenceContext"]);
assert.equal(navigationChange.persistsProject, false);
assert.equal(navigationChange.affectsPlayback, false);
assert.deepEqual(navigationChange.renderTargets, ["navigation.context", "navigation.focus"]);
occurrenceContext.focus.row = 99;
assert.deepEqual(state.focus, { pane: "chain", row: 5, col: 1 }, "occurrence context must be cloned by NavigationStore");
const unchangedOccurrenceCalls = navigationCalls;
assert.equal(bundle.navigation.navigateOccurrence(bundle.navigation.captureContext()).mutated, false);
assert.equal(navigationCalls, unchangedOccurrenceCalls, "unchanged occurrence must not notify subscribers");

const childContext = {
  ...parentContext,
  view: "chain",
  activeWorkspace: "chain",
  focus: { pane: "chain", row: 4, col: 0 },
  chain: 9,
  chainRow: 4,
  lastChain: 9,
};
const callsBeforeEnter = navigationCalls;
const entered = bundle.navigation.enterContext(childContext, { parent: parentContext, source: "unit-enter" });
assert.equal(entered.mutated, true);
assert.equal(entered.depthBefore, 0);
assert.equal(entered.depthAfter, 1);
assert.equal(navigationCalls, callsBeforeEnter + 1);
assert.equal(state.view, "chain");
assert.equal(state.p3.activeWorkspace, "chain");
assert.deepEqual(state.focus, { pane: "chain", row: 4, col: 0 });
assert.equal(state.chain, 9);
assert.equal(state.lastChain, 9);
assert.equal(bundle.navigation.select(stores.selectors.returnDepth), 1);
assert.equal(navigationChange.target, "navigation.hierarchy.enter");
assert.deepEqual(navigationChange.path, ["returnStack"]);
assert.equal(navigationChange.before.depth, 0);
assert.equal(navigationChange.after.depth, 1);
assert.equal(navigationChange.persistsProject, false);
assert.equal(navigationChange.affectsPlayback, false);
assert.deepEqual(navigationChange.renderTargets, ["navigation.workspace", "navigation.context", "navigation.focus"]);

childContext.focus.row = 99;
assert.deepEqual(state.focus, { pane: "chain", row: 4, col: 0 }, "NavigationStore must not retain caller-owned context objects");

const callsBeforeReturn = navigationCalls;
const returned = bundle.navigation.returnToParent({ source: "unit-return" });
assert.equal(returned.mutated, true);
assert.equal(returned.depthBefore, 1);
assert.equal(returned.depthAfter, 0);
assert.equal(navigationCalls, callsBeforeReturn + 1);
assert.equal(state.view, "song");
assert.equal(state.p3.activeWorkspace, "song");
assert.deepEqual(state.focus, { pane: "song", row: 3, col: 2 });
assert.equal(state.songRow, 3);
assert.equal(state.track, 2);
assert.equal(state.chain, 7);
assert.equal(state.phrase, 12);
assert.equal(state.instrument, 5);
assert.equal(state.p3.soundParam, 2);
assert.equal(state.lastChain, 7);
assert.equal(state.lastPhrase, 12);
assert.equal(bundle.navigation.select(stores.selectors.returnDepth), 0);
assert.equal(navigationChange.target, "navigation.hierarchy.return");
assert.deepEqual(navigationChange.path, ["returnStack"]);
assert.equal(navigationChange.before.depth, 1);
assert.equal(navigationChange.after.depth, 0);

const callsBeforeEmptyReturn = navigationCalls;
const emptyReturn = bundle.navigation.returnToParent();
assert.equal(emptyReturn.mutated, false);
assert.equal(navigationCalls, callsBeforeEmptyReturn, "empty return stack must not notify subscribers");
assert.deepEqual(bundle.navigation.select(stores.selectors.navigationContext), stores.normalizeNavigationContext(parentContext, state));

const mixParentContext = {
  ...parentContext,
  view: "phrase",
  activeWorkspace: "phrase",
  focus: { pane: "phrase", row: 5, col: 2 },
  phraseRow: 5,
  instrument: 6,
};
const mixSoundContext = {
  ...mixParentContext,
  view: "sound",
  dock: "sound",
  activeWorkspace: "sound",
};
const mixEnter = bundle.navigation.enterContext(mixSoundContext, { parent: mixParentContext, source: "unit-mix-parent" });
assert.equal(mixEnter.mutated, true);
assert.equal(bundle.navigation.select(stores.selectors.returnDepth), 1);
const callsBeforeMixOpen = navigationCalls;
const projectCallsBeforeMixOpen = { ...calls };
const openedMix = bundle.navigation.openMix({ source: "unit-mix-open" });
assert.equal(openedMix.mutated, true);
assert.equal(navigationCalls, callsBeforeMixOpen + 1);
assert.equal(state.view, "mix");
assert.equal(state.dock, "mix");
assert.equal(state.p3.activeWorkspace, "mix");
assert.deepEqual(state.focus, { pane: "phrase", row: 5, col: 2 });
assert.equal(bundle.navigation.select(stores.selectors.returnDepth), 1, "Mix open must not consume structural parents");
assert.deepEqual(bundle.navigation.select(stores.selectors.mixReturnContext), stores.normalizeNavigationContext(mixSoundContext, state));
assert.equal(navigationChange.target, "navigation.mix.open");
assert.deepEqual(navigationChange.path, ["mixReturn"]);
assert.equal(navigationChange.before.returnContext, null);
assert.equal(navigationChange.after.returnContext.activeWorkspace, "sound");
assert.equal(navigationChange.persistsProject, false);
assert.equal(navigationChange.affectsPlayback, false);
assert.deepEqual(calls, projectCallsBeforeMixOpen, "Mix open must not notify project subscribers");

mixSoundContext.focus.row = 99;
assert.equal(bundle.navigation.select(stores.selectors.mixReturnContext).focus.row, 5, "Mix return context must be cloned");
const callsBeforeDuplicateMix = navigationCalls;
const duplicateMix = bundle.navigation.openMix({ source: "unit-mix-open-duplicate" });
assert.equal(duplicateMix.mutated, false);
assert.equal(navigationCalls, callsBeforeDuplicateMix, "opening Mix twice must be a stable no-op");
assert.equal(bundle.navigation.select(stores.selectors.mixReturnContext).focus.row, 5, "duplicate Mix open must retain the original return target");

const callsBeforeMixReturn = navigationCalls;
const returnedFromMix = bundle.navigation.returnFromMix({ source: "unit-mix-return" });
assert.equal(returnedFromMix.mutated, true);
assert.equal(navigationCalls, callsBeforeMixReturn + 1);
assert.equal(state.view, "sound");
assert.equal(state.dock, "sound");
assert.equal(state.p3.activeWorkspace, "sound");
assert.deepEqual(state.focus, { pane: "phrase", row: 5, col: 2 });
assert.equal(state.instrument, 6);
assert.equal(bundle.navigation.select(stores.selectors.mixReturnContext), null);
assert.equal(bundle.navigation.select(stores.selectors.returnDepth), 1, "Mix return must preserve structural parents");
assert.equal(navigationChange.target, "navigation.mix.return");
assert.deepEqual(navigationChange.path, ["mixReturn"]);
assert.equal(navigationChange.before.returnContext.activeWorkspace, "sound");
assert.equal(navigationChange.after.returnContext, null);
assert.deepEqual(calls, projectCallsBeforeMixOpen, "Mix return must not notify project subscribers");

const callsBeforeEmptyMixReturn = navigationCalls;
const emptyMixReturn = bundle.navigation.returnFromMix({ source: "unit-mix-return-empty" });
assert.equal(emptyMixReturn.mutated, false);
assert.equal(navigationCalls, callsBeforeEmptyMixReturn, "consumed Mix return must be a stable no-op");
const returnedAfterMix = bundle.navigation.returnToParent({ source: "unit-mix-parent-return" });
assert.equal(returnedAfterMix.mutated, true);
assert.equal(state.view, "phrase");
assert.deepEqual(state.focus, { pane: "phrase", row: 5, col: 2 });
assert.equal(bundle.navigation.select(stores.selectors.returnDepth), 0);

const envelope = bundle.project.select(stores.selectors.sourceEnvelope);
assert.deepEqual(Object.keys(envelope), [
  "schemaVersion", "sourceFormat", "sourceVersion", "sourceMetadata", "unknownData",
]);
assert.equal(Object.hasOwn(envelope, "compatibilityExtensions"), false, "compatibility extensions stay Project-owned and do not leak through sourceEnvelope metadata");

console.log("M4.0A store tests passed with A4B2 preview cleanup + unrelated compatibility preservation");
