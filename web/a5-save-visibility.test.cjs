"use strict";

const assert = require("node:assert/strict");
const stores = require("./stores.js");
const storage = require("./project-storage.js");
const sessionDomain = require("./project-file-session.js");
const sessionUiDomain = require("./project-file-session-ui.js");

function projectFixture() {
  const project = {
    schemaVersion: 2,
    projectName: "A5 SAVE VISIBILITY",
    tempo: 120,
    tracks: [{ mix: { gain: 1, mute: false, pan: 0 } }],
    song: [[0]],
    chains: { 0: [{ phrase: 0, transpose: 0 }] },
    phrases: { 0: [{ note: 60, velocity: 100, instrument: -1, fx: [0, 0, 0] }] },
    instruments: [],
    compatibilityExtensions: {},
  };
  storage.installRuntimeProject(project);
  return project;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function descriptorOf(snapshot, safetyCopy = {}) {
  return sessionUiDomain.describeSaveState(snapshot, safetyCopy);
}

function stateOf(snapshot, safetyCopy = {}) {
  return descriptorOf(snapshot, safetyCopy).state;
}

(async () => {
  assert.equal(stateOf({ bindingMode: "none", dirty: false }), "not-saved");
  assert.equal(stateOf({ bindingMode: "handle", dirty: false }), "saved");
  assert.equal(stateOf({ bindingMode: "upload", dirty: false, fileName: "opened.brktrk" }), "saved");
  assert.equal(stateOf({ bindingMode: "recovery", dirty: false, fileName: null }), "not-saved", "an unsaved recovered baseline must not be presented as SAVED");
  assert.equal(
    stateOf({ bindingMode: "recovery", dirty: false, fileName: "known.brktrk" }),
    "not-saved",
    "recovery may remember a file name but has no durable handle/version authority, so it must not claim SAVED",
  );
  assert.equal(stateOf({ bindingMode: "recovery", dirty: true, fileName: "known.brktrk" }), "dirty", "recovered unsaved work remains visibly DIRTY");
  assert.equal(stateOf({ bindingMode: "handle", dirty: true }), "dirty");
  assert.equal(stateOf({ bindingMode: "handle", dirty: true, saveInFlight: true }), "writing");
  assert.equal(stateOf({ bindingMode: "handle", dirty: true, saveInFlight: true, externalConflict: { kind: "modified" } }), "conflict");

  const runtimeFailure = {
    state: "failed",
    writeCount: 0,
    lastFailure: { code: "BRKTRK_CANONICAL_WRITE_FAILED" },
    boot: { kind: "ready" },
  };
  assert.equal(
    stateOf({ bindingMode: "handle", dirty: false }, runtimeFailure),
    "safety-copy-failed",
    "runtime safety-copy failure must override ordinary SAVED chrome until a durable retry succeeds",
  );
  assert.match(descriptorOf({ bindingMode: "handle", dirty: false }, runtimeFailure).label, /SAFETY COPY FAILED/);
  assert.equal(
    stateOf(
      { bindingMode: "handle", dirty: true },
      { ...runtimeFailure, state: "scheduled" },
    ),
    "safety-copy-failed",
    "scheduling a retry must not hide a still-unresolved safety-copy failure",
  );
  assert.match(
    descriptorOf(
      { bindingMode: "handle", dirty: true, externalConflict: { kind: "modified" } },
      runtimeFailure,
    ).label,
    /COPY FAILED/,
    "external conflict and safety-copy failure must remain simultaneously visible",
  );
  assert.equal(
    stateOf(
      { bindingMode: "handle", dirty: false },
      { state: "idle", writeCount: 0, lastFailure: null, boot: { kind: "staging-cleanup-failed" } },
    ),
    "safety-copy-failed",
    "boot-time storage failures must persist in the authoritative save surface",
  );
  assert.equal(
    stateOf(
      { bindingMode: "handle", dirty: false },
      { state: "healthy", writeCount: 1, lastFailure: null, boot: { kind: "staging-cleanup-failed" } },
    ),
    "saved",
    "a verified later canonical write may clear prior boot-time storage failure presentation",
  );

  const model = projectFixture();
  const navigation = {
    view: "phrase", dock: "mix", songRow: 0, track: 0, chain: 0, chainRow: 0,
    phrase: 0, phraseRow: 0, instrument: 0,
    focus: { pane: "phrase", row: 0, col: 0 }, lastChain: 0, lastPhrase: 0,
    p3: { activeWorkspace: "phrase", soundParam: 0, parents: [], mixReturn: null },
  };
  const bundle = stores.createStores({ model, state: navigation, trackCount: 8 });
  const write = deferred();
  let saveAsCalls = 0;
  const adapter = {
    capabilities: { directOpen: false, directSave: true, uploadFallback: true, downloadFallback: true },
    async openFile() { return { ok: false, cancelled: true }; },
    saveAs(text, fileName) {
      saveAsCalls += 1;
      return write.promise.then((result) => ({ ...result, fileName: result.fileName ?? fileName }));
    },
    async confirmDiscard() { return true; },
  };
  const root = {
    BRKTRK_VERSION: "a5-save-visibility-test",
    BRKTRKStores: bundle,
    BRKTRKCommands: { installed: true },
    BRKTRKSelectionClipboard: { cancelSelection() {} },
    stopPlayback() {}, renderAll() {}, focusSelectedCell() {}, setStatus() {},
  };
  const session = sessionDomain.createController(root, {
    projectStore: bundle.project,
    navigationStore: bundle.navigation,
    commands: root.BRKTRKCommands,
    adapter,
    createInitialProject: projectFixture,
  });

  assert.equal(stateOf(session.snapshot()), "not-saved", "fresh local Project must not claim a durable save");
  bundle.project.setTempo(121, { source: "a5.save-visibility.dirty" });
  assert.equal(session.snapshot().dirty, true);
  assert.equal(stateOf(session.snapshot()), "dirty");

  const observed = [];
  const unsubscribe = session.subscribe((snapshot) => observed.push(snapshot));
  const savePromise = session.dispatch({ type: "project.saveAs", source: "a5.save-visibility" });

  assert.equal(saveAsCalls, 1, "Save As must reach the delayed writer synchronously before awaiting I/O");
  assert.equal(session.snapshot().saveInFlight, true, "file-session authority must know a write is active");
  assert.equal(stateOf(session.snapshot()), "writing");
  assert.equal(
    observed.some((snapshot) => snapshot.saveInFlight === true),
    true,
    "#372 regression: subscribers must receive WRITE IN PROGRESS immediately when save ownership starts",
  );

  write.resolve({
    ok: true,
    handle: { name: "a5-save-visibility.brktrk" },
    fileName: "a5-save-visibility.brktrk",
    mode: "handle",
    durableWriteConfirmed: true,
  });
  const result = await savePromise;
  assert.equal(result.ok, true);
  assert.equal(session.snapshot().saveInFlight, false);
  assert.equal(session.snapshot().dirty, false);
  assert.equal(stateOf(session.snapshot()), "saved");
  unsubscribe();

  console.log("A5 #372/#353 authoritative save + safety-copy presentation regression passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
