"use strict";

// G0 slice 2 — physical Sound range input authority after retiring the rAF
// range coalescer.
//
// The retired wrapper queued `a4-sound-range` writes until the next animation
// frame. On physical Chrome it coalesced nothing (1007 input events -> 0
// coalesced) while introducing three ordering/data-loss hazards, each of which
// was reproduced against the wrapper before it was removed:
//
//   H1 a queued pointer sample outlived a preset/full-state/project/history
//      boundary and landed *after* it;
//   H2 a later direct/keyboard write was overwritten by an older queued
//      pointer sample at the next frame;
//   H3 `commitPending()` cleared the whole pending Map before applying it, so
//      one throwing canonical setter silently discarded every other final
//      value in the batch.
//
// This regression pins the contract that replaces it: physical Sound input is
// one direct canonical write, in the order the user produced it, with no queue
// to go stale, reorder, or lose records.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");

const storeTypes = require("./stores.js");
require("./production-instrument-domain.js");

// --- the retired module must not come back -----------------------------------

assert.equal(
  fs.existsSync(path.join(__dirname, "production-sound-range-coalescer.js")),
  false,
  "the rAF Sound range coalescer is retired and must not return",
);
for (const consumer of ["app-bind.js", "sw.js", "production-engine-diagnostics.js"]) {
  assert.equal(
    read(consumer).includes("production-sound-range-coalescer"),
    false,
    `${consumer} must not reference the retired Sound range coalescer`,
  );
}

// --- ProjectStore keeps sole ownership of its canonical setter ---------------

const model = {
  schemaVersion: 4,
  projectName: "G0 RANGE INPUT",
  tempo: 120,
  tracks: Array.from({ length: 8 }, (_, id) => ({ id, mix: { gain: 1, mute: false, pan: 0 } })),
  song: Array.from({ length: 64 }, () => Array(8).fill(-1)),
  chains: {},
  phrases: {},
  instrumentPool: {},
  tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  sourceFormat: "brktrk", sourceVersion: null, sourceMetadata: {}, compatibilityExtensions: {}, unknownData: [],
};
const projectStore = new storeTypes.ProjectStore(model);
const canonicalSetter = projectStore.setProductionInstrumentParameter;

projectStore.createProductionInstrument(3, {
  id: 3,
  name: "FOLD REED LEAD",
  engineRef: { moduleId: "design.myldy.fixture", engineId: "fixture", requestedVersion: "^1.0.0", hostContract: "1.x" },
  patchState: { schemaVersion: 1, encoding: "opaque", data: null },
  parameterSnapshot: { cutoff: 0.5, resonance: 0.5, drive: 0.5 },
  provenance: {}, compatibilityData: {}, unknownData: [],
}, { source: "g0.setup" });

const cutoff = () => projectStore.getState().instrumentPool[3].parameterSnapshot.cutoff;

// --- the renderer's write path is direct and ordered -------------------------

const rendererSandbox = {
  console,
  Object, Number, String, Boolean, Array, Math, JSON, Map, Set,
  Error, TypeError, RangeError,
  BRKTRKStores: { project: projectStore },
  // If the renderer ever reintroduces deferral, these must never be reached.
  requestAnimationFrame() { throw new Error("physical Sound input must not be deferred to an animation frame"); },
  setTimeout() { throw new Error("physical Sound input must not be deferred to a timer"); },
  queueMicrotask() {},
};
rendererSandbox.globalThis = rendererSandbox;
vm.createContext(rendererSandbox);
vm.runInContext(read("sound-edit-renderer.js"), rendererSandbox, { filename: "sound-edit-renderer.js" });

const renderer = rendererSandbox.BRKTRKSoundEditRenderer;
assert.ok(renderer?.writeProductionParameter, "the renderer must expose one direct canonical Sound write path");
assert.ok(renderer?.soundInputSnapshot, "the renderer must expose physical Sound input accounting");

assert.strictEqual(
  projectStore.setProductionInstrumentParameter,
  canonicalSetter,
  "no module may wrap or reassign the canonical ProjectStore parameter setter",
);

// --- C1: a range write is applied immediately, never deferred ---------------

renderer.writeProductionParameter(3, "cutoff", 0.9, "a4-sound-range");
assert.equal(cutoff(), 0.9, "a physical range sample must reach ProjectStore immediately");

// --- C2: a later direct/keyboard write always wins --------------------------
//
// This is H2. Under the retired queue the older pointer sample landed at the
// next frame and clobbered this value.

renderer.writeProductionParameter(3, "cutoff", 0.8, "a4-sound-range");
projectStore.setProductionInstrumentParameter(3, "cutoff", 0.35, { source: "field-schema-keyboard" });
assert.equal(cutoff(), 0.35, "a later direct/keyboard write must win over an earlier pointer sample");

// Nothing may resurrect the older sample afterwards. There is no queue left to
// drain, so any deferred mechanism would have to surface here.
for (let tick = 0; tick < 4; tick += 1) {
  assert.equal(cutoff(), 0.35, "no deferred pointer sample may resurrect after a later direct write");
}

// --- C3: a full-state/preset boundary cannot be crossed ---------------------
//
// This is H1. Under the retired queue the pointer sample applied after the
// preset and pulled the Instrument back off the applied full state.

renderer.writeProductionParameter(3, "cutoff", 0.95, "a4-sound-range");
projectStore.replaceProductionInstrumentPatch(
  3,
  { schemaVersion: 1, encoding: "opaque", data: null },
  { cutoff: 0.2, resonance: 0.2, drive: 0.2 },
  { source: "g0.preset" },
);
assert.equal(cutoff(), 0.2, "an applied full state must not be overwritten by an earlier pointer sample");

// A live edit *after* the preset still wins — that is G0 slice 1's final-wins
// contract, and retiring the queue must not weaken it.
renderer.writeProductionParameter(3, "cutoff", 0.6, "a4-sound-range");
assert.equal(cutoff(), 0.6, "a live edit after full-state application remains later-wins");

// --- C4: one rejected write cannot discard unrelated values -----------------
//
// This is H3. Under the retired queue a throwing canonical setter aborted the
// commit loop after the pending Map had already been cleared, so every other
// final value in the batch was lost with no retry path.

renderer.writeProductionParameter(3, "resonance", 0.71, "a4-sound-range");
assert.throws(
  () => renderer.writeProductionParameter(3, "", 0.5, "a4-sound-range"),
  /parameter key must not be empty/,
  "an invalid parameter write must fail loudly",
);
renderer.writeProductionParameter(3, "drive", 0.73, "a4-sound-range");

const snapshotState = projectStore.getState().instrumentPool[3].parameterSnapshot;
assert.equal(snapshotState.resonance, 0.71, "a rejected write must not discard an earlier unrelated final value");
assert.equal(snapshotState.drive, 0.73, "a rejected write must not block a later unrelated final value");

// --- C5: input accounting stays honest and observable -----------------------

const accounting = renderer.soundInputSnapshot();
assert.equal(accounting.owner, "sound-edit-renderer");
assert.equal(accounting.coalescing, "retired", "the DEBUG snapshot must state that Sound input coalescing is retired");
assert.equal(Object.hasOwn(accounting, "coalescedInputEvents"), false, "a retired mechanism must not keep reporting a coalescing counter");
assert.equal(accounting.rejectedMutations, 1, "a rejected physical write must be visible in diagnostics");
assert.equal(accounting.rangeInputEvents, 7, "every physical range sample must be counted exactly once, rejected ones included");
assert.equal(accounting.enumInputEvents, 0, "no enum input was produced by this contract");
assert.equal(accounting.lastParameterId, "drive");

// An unchanged write is reported separately from a committed one, so a physical
// session can tell "no-op" traffic from real mutation cost (input for G1).
const committedBefore = accounting.committedMutations;
renderer.writeProductionParameter(3, "drive", 0.73, "a4-sound-range");
const after = renderer.soundInputSnapshot();
assert.equal(after.committedMutations, committedBefore, "a repeated identical value must not count as a committed mutation");
assert.equal(after.unchangedMutations, accounting.unchangedMutations + 1, "unchanged physical writes must be counted separately");

console.log("G0 Sound range input authority contract OK");
