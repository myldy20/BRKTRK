const assert = require("node:assert/strict");
require("./production-instrument-domain.js");
const stores = require("./stores.js");
const historyDomain = require("./undo-redo.js");

// The UI must never turn a live-sounding instrument into a different ABI.
const soundRenderer = require("./sound-edit-renderer.js");
globalThis.BRKTRKStores = { transport: { runtime: { snapshot: () => ({ phase: "playing", playing: true }) } } };
assert.equal(soundRenderer.transportStoppedForEngineSwap(), false);
globalThis.BRKTRKStores.transport.runtime.snapshot = () => ({ phase: "stopping", playing: false });
assert.equal(soundRenderer.transportStoppedForEngineSwap(), false);
globalThis.BRKTRKStores.transport.runtime.snapshot = () => ({ phase: "stopped", playing: false });
assert.equal(soundRenderer.transportStoppedForEngineSwap(), true);
delete globalThis.BRKTRKStores;

const A = "a".repeat(64), B = "b".repeat(64);
const model = {
  schemaVersion: 5, projectName: "ENGINE SWAP TEST", tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {}, phrases: {}, instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};
const project = new stores.ProjectStore(model);
const old = {
  name: "MY LEAD",
  engineRef: { moduleId: "myldy.old", engineId: "old", requestedVersion: "1.0", resolvedVersion: "1.0", resolvedPackageSha256: A },
  patchState: { schemaVersion: 4, encoding: "base64", data: "AQID" },
  parameterSnapshot: { old_parameter: 0.42 },
  presetRef: { id: "dark", engineId: "old", packageSha256: A },
  assetRef: { schema: "brktrk-pcm-asset-ref-v1", format: "pcm-s16-interleaved", sha256: A, sampleRateHz: 48000, channelCount: 1, frameCount: 64, byteSize: 128 },
  provenance: { source: "old-preset" },
  unknownData: [{ preserved: true }],
};
project.createProductionInstrument(3, old);
const undo = historyDomain.install({ setStatus() {}, renderAll() {} }, { projectStore: project });
const captured = structuredClone(project.getState().instrumentPool[3]);
const seen = [];
project.subscribe("audio", change => seen.push(change));
const replacement = {
  name: "IGNORED NEW DEFAULT", 
  engineRef: { moduleId: "myldy.new", engineId: "new", requestedVersion: "2.0", resolvedVersion: "2.0", resolvedPackageSha256: B, channel: "stable" },
  patchState: { schemaVersion: 9, encoding: "base64", data: null },
  parameterSnapshot: { new_parameter: 0.7 },
  presetRef: null,
  provenance: { source: "engine-catalog", packageSha256: B },
};
assert.throws(() => project.replaceProductionInstrumentEngine(3, {...replacement,engineRef:null}), /engineRef/);
assert.deepEqual(project.getState().instrumentPool[3], captured, "invalid replacement must never mutate the original");
const result = project.replaceProductionInstrumentEngine(3, replacement, { source: "sound.engine.replace" });
const actual = project.getState().instrumentPool[3];
assert.equal(result.mutated, true);
assert.equal(actual.id, 3, "Song/Phrase Instrument byte references must remain valid");
assert.equal(actual.name, "MY LEAD", "user's Instrument identity/name must survive the engine swap");
assert.equal(actual.engineRef.resolvedPackageSha256, B, "replace must use the exact new verified package identity");
assert.deepEqual(actual.parameterSnapshot, { new_parameter: 0.7 }, "old cross-engine parameter IDs must not leak into new engine");
assert.deepEqual(actual.patchState, replacement.patchState, "old opaque patch bytes must be reset");
assert.equal(actual.presetRef, null, "factory preset identity from previous engine must not survive");
assert.equal(Object.hasOwn(actual, "assetRef"), false, "foreign engine attachment must not silently follow the new engine");
assert.deepEqual(actual.unknownData, [], "engine-specific unknown fields must not leak to another ABI");
assert.equal(result.changeSet.subtype, "instrument.engine-replace");
assert.equal(result.changeSet.structuralPlayback, true);
assert.equal(result.changeSet.affectsPlayback, true);
assert.equal(result.changeSet.transaction.safeBoundaryRequired, true);
assert.equal(result.changeSet.transaction.oldPackageSha256, A);
assert.equal(result.changeSet.transaction.newPackageSha256, B);
assert.equal(seen.length, 1, "one atomic structural audio notification");
assert.equal(undo.snapshot().undoDepth, 1, "one Undo event rather than multiple partial writes");
assert.throws(() => project.replaceProductionInstrumentEngine(3, replacement), /different verified engine/);
assert.equal(undo.snapshot().undoDepth, 1, "same-package destructive reset must not enter history");
assert.equal(undo.undo().ok, true);
assert.deepEqual(project.getState().instrumentPool[3], captured, "Undo must recover exact previous engine, patch, asset and provenance");
assert.equal(seen.at(-1).subtype, "history.undo");
assert.equal(seen.at(-1).structuralPlayback, true);
assert.equal(undo.redo().ok, true);
assert.deepEqual(project.getState().instrumentPool[3], actual, "Redo must restore the complete replacement state");
assert.equal(seen.at(-1).subtype, "history.redo");
undo.dispose();
console.log("Atomic stopped-boundary Instrument engine replacement and full-state Undo/Redo PASS");
