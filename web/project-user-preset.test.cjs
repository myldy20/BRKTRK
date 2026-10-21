// #474: user-saved presets. The owner's decision is a hard pin to the engine
// package a preset was captured from, with engine updates done manually — so a
// preset never silently reinterprets opaque patchState from another build.
const assert = require("node:assert/strict");

require("./production-instrument-domain.js");
const stores = require("./stores.js");
const userPresets = require("./project-user-preset.js");
const instrumentPresets = require("./project-instrument-preset.js");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function projectWith() {
  const model = {
    schemaVersion: 4,
    projectName: "USER PRESETS",
    tempo: 120,
    tracks: Array.from({ length: 8 }, (_, id) => ({ id })),
    song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
    chains: {}, phrases: {}, instrumentPool: {},
    tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {},
    assets: {}, presets: {}, mappings: {},
    sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
  };
  const project = new stores.ProjectStore(model);
  project.createProductionInstrument(1, {
    name: "BRK WAV",
    engineRef: {
      moduleId: "design.myldy.brk", engineId: "brk-wav",
      requestedVersion: "1.0.0", resolvedVersion: "1.0.0", resolvedPackageSha256: SHA_A,
      hostContract: "brktrk-synth-gateway-v1",
    },
    patchState: { schemaVersion: 1, encoding: "base64", data: "AQIDBA==" },
    parameterSnapshot: { cutoff: 0.42, level: 0.8 },
  });
  userPresets.install(project);
  instrumentPresets.install(project);
  return project;
}

// --- model.presets is the reserved home, and it is where a save lands --------
{
  const project = projectWith();
  assert.deepEqual(project.getState().presets, {}, "a fresh project starts with an empty preset library");

  const saved = project.userPresets.save(1, { name: "  My   Bass  ", source: "test" });
  assert.equal(saved.mutated, true);
  assert.equal(saved.value.name, "My Bass", "whitespace in a name is normalized, not stored raw");
  assert.equal(saved.value.bank, "User");
  assert.deepEqual(saved.value.parameterSnapshot, { cutoff: 0.42, level: 0.8 });
  assert.equal(saved.value.patchState.data, "AQIDBA==", "the opaque engine state is captured, not just named parameters");
  assert.deepEqual(saved.value.engine, {
    moduleId: "design.myldy.brk", engineId: "brk-wav", version: "1.0.0", packageSha256: SHA_A,
  }, "the preset records the exact engine package it was captured from");
  assert.equal(saved.value.schema, "brktrk-user-preset-v1", "stored user presets must carry an explicit record schema");
  assert.equal(saved.value.sourcePresetRef, null, "a fresh Instrument without preset provenance records that absence explicitly");

  const stored = project.getState().presets[saved.value.id];
  assert.ok(stored, "the preset lives in model.presets, so it travels in the .brktrk file");
  assert.equal(stored.stateSchemaVersion, 1, "the engine state schema version is recorded for a later compatibility policy");
}

// --- saving must not disturb playback ---------------------------------------
{
  // Every chain.transpose edit carries structuralPlayback: true and re-issues
  // the transport program (see #467). Capturing a sound that is already
  // playing adds nothing to the program and must not restart it.
  const project = projectWith();
  const saved = project.userPresets.save(1, { name: "Live capture" });
  assert.equal(saved.changeSet.affectsPlayback, false, "saving a preset must not be treated as a playback change");
  assert.equal(saved.changeSet.structuralPlayback, false, "saving a preset must never re-issue the transport program");
  assert.equal(saved.changeSet.persistsProject, true, "a saved preset must reach the project file");
}

// --- exact package pin + shared namespace hardening --------------------------
{
  const project = projectWith();

  const instrument = project.getState().instrumentPool[1];
  const originalRef = instrument.engineRef;

  instrument.engineRef = { ...originalRef, resolvedPackageSha256: null };
  assert.throws(
    () => project.userPresets.save(1, { name: "No hash" }),
    /exact resolved version \+ package SHA/,
    "opaque user preset state must never be saved without an exact package hash",
  );

  instrument.engineRef = { ...originalRef, resolvedVersion: null, requestedVersion: "^1.0.0" };
  assert.throws(
    () => project.userPresets.save(1, { name: "Range only" }),
    /exact resolved version \+ package SHA/,
    "a requested version/range is not an exact engine identity",
  );

  instrument.engineRef = originalRef;
  assert.throws(
    () => project.userPresets.save(1, { id: "__proto__", name: "Unsafe" }),
    /safe 1-96 character identifier/,
    "caller-supplied ids must not reach prototype-sensitive project keys",
  );

  project.getState().presets.foreign = { schema: "other-preset-v1", id: "foreign", name: "Not ours" };
  project.getState().presets["user-collision"] = { schema: "other-preset-v1", id: "user-collision" };
  assert.equal(project.userPresets.libraryFor(originalRef).presetCount, 0,
    "foreign records sharing project.presets must not become BRKTRK user presets");
  assert.throws(
    () => project.userPresets.save(1, { id: "user-collision", name: "Collision" }),
    /project preset key user-collision already exists/,
    "a foreign record key must still be treated as occupied rather than overwritten",
  );
}

// --- source preset provenance is metadata, never the load identity -----------
{
  const project = projectWith();
  const instrument = project.getState().instrumentPool[1];
  instrument.presetRef = {
    id: "factory-bass-07",
    name: "Factory Bass",
    bank: "Factory",
    origin: "brk-wav",
    readOnly: true,
  };
  const saved = project.userPresets.save(1, { name: "Derived Bass" });
  assert.deepEqual(saved.value.sourcePresetRef, instrument.presetRef,
    "a saved user preset must retain source preset provenance as metadata");
  const presented = project.userPresets.libraryFor(instrument.engineRef).presets[0];
  assert.deepEqual(presented.sourcePresetRef, instrument.presetRef,
    "source provenance must survive presentation without replacing the user preset identity");
}

// --- the engine pin decides applicability -----------------------------------
{
  const project = projectWith();
  const saved = project.userPresets.save(1, { name: "Pinned" });

  const same = project.userPresets.libraryFor({
    moduleId: "design.myldy.brk", engineId: "brk-wav", version: "1.0.0", packageSha256: SHA_A,
  });
  assert.equal(same.presetCount, 1);
  assert.equal(same.applicableCount, 1);
  assert.equal(same.presets[0].applicable, true, "the engine it was saved on can load it");

  for (const [label, ref] of [
    ["a newer version", { moduleId: "design.myldy.brk", engineId: "brk-wav", version: "1.1.0", packageSha256: SHA_A }],
    ["a repackaged build of the same version", { moduleId: "design.myldy.brk", engineId: "brk-wav", version: "1.0.0", packageSha256: SHA_B }],
    ["a different engine", { moduleId: "design.myldy.brk", engineId: "brk-fm4", version: "1.0.0", packageSha256: SHA_A }],
    ["a different module", { moduleId: "design.other", engineId: "brk-wav", version: "1.0.0", packageSha256: SHA_A }],
  ]) {
    const other = project.userPresets.libraryFor(ref);
    assert.equal(other.presetCount, 1, `${label} still sees the preset exists`);
    assert.equal(other.applicableCount, 0, `${label} must not be able to load it`);
    assert.equal(other.presets[0].applicable, false, `${label} must be refused`);
    assert.equal(other.presets[0].unavailableReason, "engine-version-mismatch");
    assert.equal(other.presets[0].savedForEngine.version, "1.0.0",
      `${label} must still say which engine the preset belongs to`);
  }

  const weak = project.userPresets.libraryFor({
    moduleId: "design.myldy.brk", engineId: "brk-wav", version: "1.0.0",
  });
  assert.equal(weak.applicableCount, 0, "missing package hash must not weaken an exact stored pin");

  // Refusal is visible, not hidden: the preset is still listed so the musician
  // can see the sound exists and why it will not load.
  assert.equal(saved.value.id, same.presets[0].id);
}

// --- a user preset loads through the existing canonical apply path ----------
{
  const project = projectWith();
  const saved = project.userPresets.save(1, { name: "Recall me" });

  // Diverge the Instrument, then recall the preset through the same domain a
  // factory preset uses. No second load path exists.
  project.setProductionInstrumentParameter(1, "cutoff", 0.9, { source: "test" });
  assert.equal(project.getState().instrumentPool[1].parameterSnapshot.cutoff, 0.9);

  const library = project.userPresets.libraryFor(project.getState().instrumentPool[1].engineRef);
  const recalled = library.presets.find((preset) => preset.id === saved.value.id);
  project.instrumentPresets.apply(1, recalled, { source: "test-recall" });

  const instrument = project.getState().instrumentPool[1];
  assert.equal(instrument.parameterSnapshot.cutoff, 0.42, "recalling a user preset restores the captured parameters");
  assert.equal(instrument.patchState.data, "AQIDBA==", "recalling restores the captured opaque engine state");
  assert.equal(instrument.presetRef.id, saved.value.id, "provenance points at the user preset");
  assert.equal(instrument.presetRef.readOnly, false, "a user preset is not read-only, unlike a factory preset");
  assert.equal(instrument.presetRef.bank, "User");
}

// --- identity is content-derived, so renaming cannot break provenance -------
{
  const project = projectWith();
  const saved = project.userPresets.save(1, { name: "First name" });
  const library = project.userPresets.libraryFor(project.getState().instrumentPool[1].engineRef);
  project.instrumentPresets.apply(1, library.presets[0], { source: "test" });

  const renamed = project.userPresets.rename(saved.value.id, "Second name");
  assert.equal(renamed.mutated, true);
  assert.equal(renamed.value.id, saved.value.id, "renaming must not change the id");
  assert.equal(project.getState().instrumentPool[1].presetRef.id, saved.value.id,
    "an Instrument keeps its provenance across a rename");

  assert.equal(project.userPresets.rename(saved.value.id, "Second name").mutated, false,
    "renaming to the same name is not a project change");
}

// --- overwrite replaces sound state without changing preset identity ----------
{
  const project = projectWith();
  const saved = project.userPresets.save(1, { name: "Mutable" });
  const library = project.userPresets.libraryFor(project.getState().instrumentPool[1].engineRef);
  project.instrumentPresets.apply(1, library.presets[0], { source: "test-overwrite-load" });

  project.replaceProductionInstrumentPatch(
    1,
    { schemaVersion: 1, encoding: "base64", data: "BQYHCA==" },
    { cutoff: 0.66, level: 0.3 },
    { source: "test-overwrite-diverge" },
  );
  const beforeInstrument = structuredClone(project.getState().instrumentPool[1]);
  const overwritten = project.userPresets.overwrite(saved.value.id, 1, { source: "test-overwrite" });

  assert.equal(overwritten.mutated, true);
  assert.equal(overwritten.value.id, saved.value.id, "overwrite must preserve durable preset identity");
  assert.equal(overwritten.value.name, "Mutable", "overwrite must preserve the user-facing name");
  assert.equal(overwritten.value.patchState.data, "BQYHCA==", "overwrite captures current opaque engine state");
  assert.deepEqual(overwritten.value.parameterSnapshot, { cutoff: 0.66, level: 0.3 }, "overwrite captures current parameter state");
  assert.equal(overwritten.value.sourcePresetRef, null,
    "overwriting a loaded user preset must not replace original source provenance with a self-reference");
  assert.equal(overwritten.changeSet.affectsPlayback, false);
  assert.equal(overwritten.changeSet.structuralPlayback, false);
  assert.deepEqual(project.getState().instrumentPool[1], beforeInstrument,
    "overwrite is library-only and must not mutate the currently sounding Instrument");

  const stored = project.userPresets.libraryFor(project.getState().instrumentPool[1].engineRef).presets
    .find((preset) => preset.id === saved.value.id);
  assert.equal(stored.patchState.data, "BQYHCA==");
  assert.deepEqual(stored.parameterSnapshot, { cutoff: 0.66, level: 0.3 });

  const originalRef = project.getState().instrumentPool[1].engineRef;
  project.getState().instrumentPool[1].engineRef = { ...originalRef, resolvedPackageSha256: SHA_B };
  assert.throws(
    () => project.userPresets.overwrite(saved.value.id, 1, { source: "test-wrong-engine-overwrite" }),
    /different exact engine package/,
    "overwrite must not silently repin opaque preset state to another package",
  );
}

// --- the same sound saved twice gets its own entry --------------------------
{
  const project = projectWith();
  const first = project.userPresets.save(1, { name: "Take one" });
  const second = project.userPresets.save(1, { name: "Take two" });
  assert.notEqual(first.value.id, second.value.id, "identical state saved twice must not overwrite the first");
  assert.equal(Object.keys(project.getState().presets).length, 2);
}

// --- deleting -----------------------------------------------------------------
{
  const project = projectWith();
  const saved = project.userPresets.save(1, { name: "Doomed" });
  const removed = project.userPresets.remove(saved.value.id, { source: "test" });
  assert.equal(removed.mutated, true);
  assert.equal(removed.changeSet.structuralPlayback, false, "deleting a preset must not restart playback either");
  assert.deepEqual(project.getState().presets, {}, "the preset is gone from the project");
  assert.throws(() => project.userPresets.remove(saved.value.id), /does not exist/,
    "deleting a preset that is not there fails closed rather than silently succeeding");
}

// --- fail closed --------------------------------------------------------------
{
  const project = projectWith();
  assert.throws(() => project.userPresets.save(99), /does not exist/,
    "saving from an Instrument slot that has no Instrument must fail closed");

  const library = project.userPresets.libraryFor(null);
  assert.equal(library.presetCount, 0);
  assert.equal(library.applicableCount, 0, "an unknown engine can load nothing");
}

// --- the library must actually survive a .brktrk round trip -----------------
// The whole reason model.presets is the home is that it travels in the project
// file. Prove it through the real serializer rather than asserting the claim.
{
  const projectFile = require("./project-file.js");
  const project = projectWith();
  const saved = project.userPresets.save(1, { name: "Round trip" });

  const text = projectFile.serializeProject(project.getState());
  const reopened = projectFile.prepareOpen(text);
  const model = reopened.project ?? reopened.model ?? reopened;

  // Guard against a vacuous round trip: this must be a freshly parsed object,
  // not the same model handed back.
  assert.notEqual(model, project.getState(), "prepareOpen must return a fresh model, or this test proves nothing");
  assert.notEqual(model.presets, project.getState().presets);

  const restored = model.presets?.[saved.value.id];
  assert.ok(restored, "a saved user preset must survive serialize -> open");
  assert.equal(restored.name, "Round trip");
  assert.equal(restored.patchState.data, "AQIDBA==", "the opaque engine state must survive the round trip intact");
  assert.deepEqual(restored.parameterSnapshot, { cutoff: 0.42, level: 0.8 });
  assert.deepEqual(restored.engine, {
    moduleId: "design.myldy.brk", engineId: "brk-wav", version: "1.0.0", packageSha256: SHA_A,
  }, "the engine pin must survive the round trip, or the preset could be reinterpreted by another build");

  // And it is still loadable in the reopened project.
  const reopenedStore = new stores.ProjectStore(model);
  userPresets.install(reopenedStore);
  const library = reopenedStore.userPresets.libraryFor(model.instrumentPool[1].engineRef);
  assert.equal(library.applicableCount, 1, "the reopened project can still load its own preset");
}

console.log("#474 user preset library: engine-pinned save/recall/rename/delete passed");
