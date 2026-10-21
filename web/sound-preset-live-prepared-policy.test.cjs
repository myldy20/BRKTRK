const assert = require("node:assert/strict");

let playing = true;
let application = null;
globalThis.BRKTRKStores = {
  transport: {
    runtime: { snapshot: () => Object.freeze({ playing }) },
    preparedInstrumentState: { get: () => application },
  },
};
globalThis.BRKTRKProductionEngineStoreSync = {
  preparedPresetAvailability(input) {
    return Object.freeze({ eligible: input.preset?.id !== "blocked", code: input.preset?.id === "blocked" ? "engine-topology-changed" : "same-exact-topology" });
  },
};

const surface = require("./sound-preset-surface.js");
const policy = require("./sound-preset-live-prepared-policy.js");
const packageSha256 = "a".repeat(64);
const presetRef = Object.freeze({
  id: "factory-a",
  moduleId: "design.example.fixture",
  engineId: "fixture-synth",
  version: "2.0.0",
  packageSha256,
});
const patchState = Object.freeze({ schemaVersion: 1, encoding: "base64", data: "AQIDBA==" });
const parameterSnapshot = Object.freeze({ cutoff: 0.25, resonance: 0.5 });
const preset = Object.freeze({ id: "factory-a", applicable: true, readOnly: true, patchState, parameterSnapshot });
const instrument = Object.freeze({ id: 3, presetRef, patchState, parameterSnapshot });
const view = Object.freeze({
  entry: Object.freeze({
    moduleId: "design.example.fixture",
    engineId: "fixture-synth",
    version: "2.0.0",
    packageSha256,
  }),
});

assert.equal(policy.factoryPresetExact({ instrument, preset, selectedPresetId: "factory-a" }), true);

let context = policy.context({ slot: 3, instrument, preset, view, selectedPresetId: null });
assert.equal(context.playing, true);
assert.equal(context.availability.eligible, true);
assert.equal(context.presentation.disabled, false);
assert.equal(context.presentation.live, true);
assert.match(context.presentation.text, /LIVE PRESET READY/);

application = Object.freeze({ instrumentId: 3, commitId: 1, state: "requested", desiredPresetId: "factory-a" });
context = policy.context({ slot: 3, instrument, preset, view, selectedPresetId: "factory-a" });
assert.equal(context.presentation.disabled, true);
assert.match(context.presentation.text, /QUEUED/);

application = Object.freeze({ instrumentId: 3, commitId: 1, state: "applying", desiredPresetId: "factory-a" });
context = policy.context({ slot: 3, instrument, preset, view, selectedPresetId: "factory-a" });
assert.equal(context.presentation.disabled, true);
assert.match(context.presentation.text, /APPLYING/);

application = Object.freeze({ instrumentId: 3, commitId: 1, state: "applied", desiredPresetId: "factory-a" });
context = policy.context({ slot: 3, instrument, preset, view, selectedPresetId: "factory-a" });
assert.equal(context.presentation.disabled, false);
assert.equal(context.presentation.text, "PRESET APPLIED LIVE");

application = Object.freeze({ instrumentId: 3, commitId: 2, state: "failed", desiredPresetId: "factory-a", code: "native-state-read" });
context = policy.context({ slot: 3, instrument, preset, view, selectedPresetId: "factory-a" });
assert.equal(context.presentation.disabled, true, "failed live commit must not offer a no-op same-Project retry while audio still needs structural recovery");
assert.equal(context.presentation.error, true);
assert.match(context.presentation.text, /STOP PLAYBACK TO RECOVER PRESET/);
assert.match(context.presentation.text, /native-state-read/);

application = null;
const blocked = Object.freeze({ id: "blocked", applicable: true });
context = policy.context({ slot: 3, instrument, preset: blocked, view, selectedPresetId: null });
assert.equal(context.availability.eligible, false);
assert.equal(context.presentation.disabled, true);
assert.equal(context.presentation.live, false);
assert.equal(context.presentation.text, "STOP PLAYBACK TO APPLY PRESET");
assert.equal(context.presentation.blockedCode, "engine-topology-changed");
assert.equal(context.presentation.blockedReason, null);

const incomplete = Object.freeze({ id: "bad", applicable: false, unavailableReason: "parameter-snapshot-incomplete", missingParameters: ["cutoff", "resonance"] });
context = policy.context({ slot: 3, instrument, preset: incomplete, view, selectedPresetId: null });
assert.equal(context.presentation.disabled, true);
assert.match(context.presentation.text, /2 PARAMS MISSING/);

playing = false;
context = policy.context({ slot: 3, instrument, preset, view, selectedPresetId: "factory-a" });
assert.equal(context.availability, null);
assert.equal(context.application, null);
assert.equal(context.presentation.live, false);
assert.equal(context.presentation.text, "CURRENT FACTORY PRESET");

const modifiedInstrument = Object.freeze({
  ...instrument,
  parameterSnapshot: Object.freeze({ ...parameterSnapshot, cutoff: 0.75 }),
});
const provenancePresetId = surface.currentPresetId(modifiedInstrument, view);
assert.equal(provenancePresetId, "factory-a", "presetRef provenance must remain attached after a live parameter diverges");
assert.equal(policy.factoryPresetExact({ instrument: modifiedInstrument, preset, selectedPresetId: provenancePresetId }), false);
context = policy.context({ slot: 3, instrument: modifiedInstrument, preset, view, selectedPresetId: provenancePresetId });
assert.equal(
  context.presentation.text,
  "MODIFIED",
  "factory provenance must not be presented as current factory equality after parameterSnapshot divergence",
);
assert.equal(modifiedInstrument.presetRef.id, "factory-a", "MODIFIED presentation must not erase factory provenance");

const modifiedPatchInstrument = Object.freeze({
  ...instrument,
  patchState: Object.freeze({ ...patchState, data: "BQYHCA==" }),
});
assert.equal(policy.factoryPresetExact({ instrument: modifiedPatchInstrument, preset, selectedPresetId: "factory-a" }), false);
context = policy.context({ slot: 3, instrument: modifiedPatchInstrument, preset, view, selectedPresetId: "factory-a" });
assert.equal(context.presentation.text, "MODIFIED", "opaque full-state divergence must also invalidate CURRENT factory truth");

playing = true;
application = Object.freeze({ instrumentId: 3, commitId: 3, state: "applied", desiredPresetId: "factory-a" });
context = policy.context({ slot: 3, instrument: modifiedInstrument, preset, view, selectedPresetId: "factory-a" });
assert.equal(context.presentation.text, "MODIFIED", "a stale applied-live marker must not hide later current-state divergence");
assert.equal(context.presentation.disabled, false);

playing = false;
application = null;
context = policy.context({ slot: 3, instrument, preset, view, selectedPresetId: "factory-a" });
assert.equal(context.presentation.text, "CURRENT FACTORY PRESET", "returning exactly to the factory snapshot must clear MODIFIED");

const userPreset = Object.freeze({
  ...preset,
  id: "user-deadbeef",
  name: "Saved Bass",
  bank: "User",
  origin: "brktrk-user",
  readOnly: false,
});
const userRefInstrument = Object.freeze({
  ...instrument,
  presetRef: Object.freeze({ ...presetRef, id: userPreset.id, name: userPreset.name, bank: "User", origin: "brktrk-user", readOnly: false }),
});
context = policy.context({ slot: 3, instrument: userRefInstrument, preset: userPreset, view, selectedPresetId: userPreset.id });
assert.equal(context.presentation.text, "CURRENT USER PRESET", "exact user preset state must never be mislabeled as factory state");

const incompatibleUserPreset = Object.freeze({
  id: "user-other-engine",
  name: "Other Engine",
  bank: "User",
  origin: "brktrk-user",
  readOnly: false,
  applicable: false,
  unavailableReason: "engine-version-mismatch",
});
context = policy.context({ slot: 3, instrument, preset: incompatibleUserPreset, view, selectedPresetId: null });
assert.equal(context.presentation.disabled, true);
assert.equal(context.presentation.text, "USER PRESET REQUIRES ITS SAVED ENGINE PACKAGE",
  "an exact-pin mismatch must report engine incompatibility, not pretend package preset metadata is incomplete");

console.log("A5 #371 factory/user preset provenance/equality presentation contract passed");
