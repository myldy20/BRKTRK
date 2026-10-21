const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "app-model.js"), "utf8");
const context = {
  console: { warn() {}, error() {}, log() {} },
  localStorage: { getItem() { return null; }, setItem() {} },
  window: { clearTimeout() {}, setTimeout() { return 0; } },
};
context.globalThis = context;
vm.runInNewContext(`${source}\n;globalThis.__a5 = { makeInitialModel, phraseEvents, instrumentReferencePresentation, model, state };`, context, { filename: "app-model.js" });

const { makeInitialModel, phraseEvents, instrumentReferencePresentation, model, state } = context.__a5;
const plain = (value) => JSON.parse(JSON.stringify(value));

// A fresh Project may keep the preview notes, but it must not pretend that
// Instrument 00 exists while the canonical Instrument pool is empty.
{
  const fresh = makeInitialModel();
  assert.deepEqual(Object.keys(fresh.instrumentPool), []);
  const assigned = Object.values(fresh.phrases)
    .flat()
    .filter((step) => step.note >= 0)
    .map((step) => step.instrument);
  assert.ok(assigned.length > 0, "the first-run preview should still exercise the Phrase path");
  assert.ok(assigned.every((instrumentId) => instrumentId === -1), "fresh preview notes must be explicitly unassigned");
}

// Playback compilation must preserve that unassigned truth. In particular it
// must not fall back to the currently browsed Sound slot and silently turn -1
// into synthetic Instrument 00.
{
  state.instrument = 0;
  model.instrumentPool = {};
  const events = phraseEvents(0, 0);
  assert.equal(events[0].notes[0], 48);
  assert.equal(events[0].instrumentIds[0], -1);
}

// Once a real Instrument exists and the Phrase explicitly assigns it, the same
// compilation path becomes playable without any fallback/substitution rule.
{
  model.instrumentPool[0] = { name: "VALID", engineRef: { moduleId: "m", engineId: "e" } };
  model.phrases[0][0].instrument = 0;
  const events = phraseEvents(0, 0);
  assert.equal(events[0].instrumentIds[0], 0);
  model.phrases[0][0].instrument = -1;
  model.instrumentPool = {};
}

// Historical/imported unresolved references remain lossless, but their UI
// presentation must be visibly different from a valid Instrument reference.
{
  assert.deepEqual(
    plain(instrumentReferencePresentation(-1, {})),
    { state: "empty", text: "--", title: "Instrument unassigned" },
  );
  assert.deepEqual(
    plain(instrumentReferencePresentation(0, {})),
    { state: "unresolved", text: "?00", title: "Unresolved Instrument 00 — preserved from Project" },
  );
  assert.deepEqual(
    plain(instrumentReferencePresentation(0, { 0: { name: "VALID" } })),
    { state: "resolved", text: "00", title: "Instrument 00" },
  );
}

// After the user creates the first verified Instrument, the untouched
// two-note preview becomes playable. Only that exact preview may be bound.
{
  require("./production-instrument-domain.js");
  require("./track-insert-fx-domain.js");
  const { ProjectStore } = require("./stores.js");
  const project = new ProjectStore(plain(makeInitialModel()));
  const instrument = {
    name: "VALID",
    engineRef: { moduleId: "design.myldy.dev", engineId: "brk-dev-poly", requestedVersion: "0.1.0-dev1" },
    patchState: { schemaVersion: 1, encoding: "base64", data: null },
    parameterSnapshot: {},
  };
  project.createProductionInstrument(0, instrument);
  const changes = [];
  project.subscribe("audio", (change) => changes.push(change));
  const attached = project.assignStarterPhraseInstrument(0);
  assert.equal(attached.mutated, true);
  assert.deepEqual([0, 4, 8, 12].map((row) => project.getState().phrases[0][row].instrument), [0, 0, 0, 0]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].structuralPlayback, true);
  assert.deepEqual(plain(changes[0].before.map((step) => step.instrument)), Array(16).fill(-1));
  assert.equal(project.assignStarterPhraseInstrument(0).mutated, false, "starter must only bind once");

  const edited = new ProjectStore(plain(makeInitialModel()));
  edited.createProductionInstrument(0, instrument);
  edited.getState().phrases[0][0].note = 66;
  assert.equal(edited.assignStarterPhraseInstrument(0).mutated, false);
  assert.equal(edited.getState().phrases[0][0].instrument, -1, "custom note must never be assigned implicitly");

  const restored = new ProjectStore(plain(makeInitialModel()));
  restored.createProductionInstrument(0, instrument);
  restored.getState().projectName = "MY SONG";
  assert.equal(restored.assignStarterPhraseInstrument(0).mutated, false, "existing user song must be untouched");
}

require("./a5-event-plan-instrument-truth.test.cjs");
require("./a5-instrument-reference-runtime.test.cjs");

console.log("A5 first-run Instrument truth regressions passed");
