"use strict";

const assert = require("node:assert/strict");
const storesTypes = require("./stores.js");
const inputSafety = require("./input-safety.js");

function makeProject() {
  return {
    schemaVersion: 4,
    projectName: "G1 UI BOUNDARY",
    tempo: 120,
    tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
    song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
    chains: {}, phrases: {}, instrumentPool: {},
    tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
    sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
  };
}

function addInstrument(projectStore) {
  projectStore.createProductionInstrument(3, {
    id: 3,
    name: "UI BOUNDARY FIXTURE",
    engineRef: {
      moduleId: "design.myldy.fixture", engineId: "fixture", requestedVersion: "^1.0.0", resolvedVersion: "1.0.0",
      resolvedPackageSha256: "a".repeat(64), hostContract: "1.x",
    },
    patchState: { schemaVersion: 1, encoding: "opaque", data: null },
    parameterSnapshot: { cutoff: 0.25 },
    provenance: {}, compatibilityData: {}, unknownData: [],
  }, { source: "g1.ui-boundary.setup" });
}

function targetFor(kind) {
  const panel = { dataset: { presetLoadedId: "factory-dark", presetLoadedSelectorValue: "brktrk-user:factory-dark:2" } };
  const selectKind = kind === "preset" || kind === "instrument";
  const buttonKind = kind === "preset-reset" || kind === "library";
  return {
    tagName: selectKind ? "SELECT" : buttonKind ? "BUTTON" : "INPUT",
    value: kind === "instrument" ? "9" : kind === "preset" ? "engine:factory-dark:0" : "",
    closest(selector) {
      if (kind === "range" && selector === "#instrumentInspector .a4a-param input[type=range]") return this;
      if (kind === "instrument" && selector === "#instrumentInspector .a4a-sound-toolbar select[aria-label='Production Instrument slot']") return this;
      if (kind === "preset" && selector === "#instrumentInspector .a4b-preset-panel select[data-preset-load-action='true']") return this;
      if (kind === "preset-reset" && selector === "#instrumentInspector .a4b-preset-panel button[data-preset-load-action='true']") return this;
      if (kind === "library" && selector === "#instrumentInspector .a4b-preset-panel button[data-preset-library-action]") return this;
      if (kind === "preset" && selector === "#instrumentInspector .a4b-preset-panel") return panel;
      return null;
    },
  };
}

function boundaryEvent(target) {
  return {
    target,
    defaultPrevented: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
  };
}

const listeners = new Map();
const document = {
  visibilityState: "visible",
  addEventListener(type, listener) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(listener);
  },
  querySelector() { return null; },
};
const windowListeners = new Map();
const model = makeProject();
const state = {
  view: "sound", dock: "sound", songRow: 0, track: 0, chain: 0, chainRow: 0, phrase: 0, phraseRow: 0, instrument: 3,
  focus: { pane: "phrase", row: 0, col: 0 }, lastChain: 0, lastPhrase: 0,
  p3: { activeWorkspace: "sound", soundParam: 0, parents: [], mixReturn: null },
};
const bundle = storesTypes.createStores({ model, state, trackCount: 8 });
addInstrument(bundle.project);
let baseKeyDownCount = 0;
const heldKeys = new Set();
const root = {
  document,
  heldKeys,
  BRKTRKStores: bundle,
  BRKTRKCommandBindings: {},
  BRKTRKCommands: {
    installed: true,
    runtime: { activeWorkspace: "sound", modifierPresses: new Map() },
    stores: { navigation: {} },
    keyDown() { baseKeyDownCount += 1; return null; },
    keyUp() { return null; },
  },
  addEventListener(type, listener) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(listener);
  },
  setStatus() {},
};
const safety = inputSafety.install(root);
assert.ok(safety?.installed, "input-safety must install in the UI-boundary harness");

function fireDocument(type, event = {}) {
  for (const listener of listeners.get(type) ?? []) listener(event);
}
function fireWindow(type, event = {}) {
  for (const listener of windowListeners.get(type) ?? []) listener(event);
}
function pending() {
  return bundle.project.continuousGestureDurabilitySnapshot().pendingCount;
}
function beginPending(id, value) {
  bundle.project.setProductionInstrumentParameter(3, "cutoff", value, {
    source: "g1.ui-boundary",
    transient: true,
    transaction: {
      gestureId: id,
      gestureFamily: "sound",
      gestureKind: "pointer-range",
      gesturePhase: "update",
    },
  });
  assert.equal(pending(), 1);
}

beginPending("instrument-picker", 0.4);
fireDocument("change", { target: targetFor("instrument") });
assert.equal(pending(), 0, "Instrument picker change must durably close a pending gesture before navigation changes slot");
assert.equal(bundle.project.continuousGestureDurabilitySnapshot().lastFinalize.transaction.gestureEndReason, "instrument-switch");

beginPending("preset-load", 0.5);
assert.ok((listeners.get("change") ?? []).length > 0, "preset selector structural boundary must have a capture listener");
fireDocument("change", { target: targetFor("preset") });
assert.equal(pending(), 0, "Preset selector change must durably close the current gesture before full-Instrument mutation");
assert.equal(bundle.project.continuousGestureDurabilitySnapshot().lastFinalize.transaction.gestureEndReason, "preset-load");

beginPending("preset-reset", 0.55);
fireDocument("click", { target: targetFor("preset-reset") });
assert.equal(pending(), 0, "Preset RESET must remain a structural full-Instrument boundary");
assert.equal(bundle.project.continuousGestureDurabilitySnapshot().lastFinalize.transaction.gestureEndReason, "preset-load");

beginPending("preset-library", 0.575);
fireDocument("click", { target: targetFor("library") });
assert.equal(pending(), 0, "preset library writes must durably close a pending gesture before they persist the Project");
assert.equal(bundle.project.continuousGestureDurabilitySnapshot().lastFinalize.transaction.gestureEndReason, "preset-library",
  "library actions must use their own durability boundary rather than masquerading as preset-load");

beginPending("keyboard-instrument", 0.6);
heldKeys.add("KeyA");
root.BRKTRKCommands.keyDown("ArrowRight", false);
assert.equal(baseKeyDownCount, 1, "instrument-switch boundary must still deliver the semantic key event");
assert.equal(pending(), 0, "A+Arrow Instrument switch must close a pending Sound gesture before semantic navigation");
assert.equal(bundle.project.continuousGestureDurabilitySnapshot().lastFinalize.transaction.gestureEndReason, "instrument-switch");
heldKeys.clear();

beginPending("pagehide", 0.7);
fireWindow("pagehide", {});
assert.equal(pending(), 0, "pagehide must close the final live value synchronously");
assert.equal(bundle.project.continuousGestureDurabilitySnapshot().lastFinalize.transaction.gestureEndReason, "pagehide");

beginPending("visibility", 0.8);
document.visibilityState = "hidden";
fireDocument("visibilitychange", {});
assert.equal(pending(), 0, "visibilitychange -> hidden must close the final live value synchronously");
assert.equal(bundle.project.continuousGestureDurabilitySnapshot().lastFinalize.transaction.gestureEndReason, "visibility-hidden");

// A structural boundary must not continue into a preset or Instrument switch
// after persistence/recovery notification failed. The desired edit is already
// committed, but allowing the next structural action would overwrite context
// after durability explicitly reported failure.
bundle.project.subscribe("persistence", () => { throw new Error("fixture structural durability failure"); });

beginPending("preset-failure", 0.85);
const presetTarget = targetFor("preset");
const presetFailure = boundaryEvent(presetTarget);
fireDocument("change", presetFailure);
assert.equal(pending(), 0, "failed notification still consumes the already-committed gesture exactly once");
assert.equal(presetFailure.defaultPrevented, true, "preset boundary must prevent the target action after durability failure");
assert.equal(presetFailure.immediatePropagationStopped, true, "preset boundary must stop target handlers after durability failure");
assert.equal(presetTarget.value, "brktrk-user:factory-dark:2",
  "failed preset switch must restore the authoritative selector identity even when durable factory/user ids collide");

beginPending("library-failure", 0.875);
const libraryFailure = boundaryEvent(targetFor("library"));
fireDocument("click", libraryFailure);
assert.equal(pending(), 0, "failed notification still consumes the pending gesture before a preset library write");
assert.equal(libraryFailure.defaultPrevented, true, "preset library action must be prevented after durability failure");
assert.equal(libraryFailure.immediatePropagationStopped, true, "preset library target handler must not run after durability failure");
assert.equal(bundle.project.continuousGestureDurabilitySnapshot().lastFinalize.transaction.gestureEndReason, "preset-library");

beginPending("instrument-failure", 0.9);
const instrumentTarget = targetFor("instrument");
const instrumentFailure = boundaryEvent(instrumentTarget);
fireDocument("change", instrumentFailure);
assert.equal(pending(), 0);
assert.equal(instrumentFailure.defaultPrevented, true, "Instrument boundary must prevent target action after durability failure");
assert.equal(instrumentFailure.immediatePropagationStopped, true, "Instrument boundary must stop target handlers after durability failure");
assert.equal(instrumentTarget.value, "3", "failed Instrument switch must restore the authoritative navigation selection");

console.log("G1 Instrument/preset/page lifecycle boundary contract passed");
