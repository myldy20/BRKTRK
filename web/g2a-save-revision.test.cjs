"use strict";

const assert = require("node:assert/strict");
const stores = require("./stores.js");
const storage = require("./project-storage.js");
const sessionDomain = require("./project-file-session.js");
const recoveryDomain = require("./project-recovery.js");
const undoRedo = require("./undo-redo.js");

function runtimeProject(name = "G2A SAVE REVISION", tempo = 120) {
  const project = {
    schemaVersion: 2,
    projectName: name,
    tempo,
    tracks: [{ mix: { gain: 1, mute: false, pan: 0 } }],
    song: [[0]],
    chains: { 0: [{ phrase: 0, transpose: 0 }] },
    phrases: { 0: [{ note: 60, velocity: 100, instrument: 0, fx: [0, 0, 0] }] },
    instruments: [{ params: [1, 2, 3, 4, 5, 6] }],
    compatibilityExtensions: {},
  };
  storage.installRuntimeProject(project);
  return project;
}

function localStorageHarness() {
  const values = new Map();
  const counts = { get: 0, set: 0, remove: 0 };
  return {
    counts,
    getItem(key) { counts.get += 1; return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { counts.set += 1; values.set(String(key), String(value)); },
    removeItem(key) { counts.remove += 1; values.delete(String(key)); },
    value(key) { return values.get(String(key)) ?? null; },
    resetCounts() { counts.get = 0; counts.set = 0; counts.remove = 0; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function createHarness(label = "G2A SAVE REVISION") {
  const model = runtimeProject(label);
  const state = {
    view: "phrase", dock: "mix", songRow: 0, track: 0, chain: 0, chainRow: 0,
    phrase: 0, phraseRow: 0, instrument: 0,
    focus: { pane: "phrase", row: 0, col: 0 }, lastChain: 0, lastPhrase: 0,
    p3: { activeWorkspace: "phrase", soundParam: 0, parents: [], mixReturn: null },
  };
  const bundle = stores.createStores({ model, state, trackCount: 8 });
  const handle = { name: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.brktrk` };
  const writes = [];
  const pendingWrites = [];
  const disk = new Map();
  let saveAsCount = 0;

  function delayedWrite(kind, text, fileName, boundHandle = null) {
    const gate = deferred();
    const write = { kind, text, fileName, handle: boundHandle, gate };
    writes.push(write);
    pendingWrites.push(write);
    return gate.promise.then((result) => {
      if (result?.ok && result.durableWriteConfirmed === true) {
        const outputHandle = result.handle ?? boundHandle;
        if (outputHandle) disk.set(outputHandle, text);
      }
      return result;
    });
  }

  const adapter = {
    capabilities: { directOpen: true, directSave: true, uploadFallback: true, downloadFallback: true },
    async openFile() { return { ok: false, cancelled: true }; },
    readHandleVersion(boundHandle) {
      const text = disk.get(boundHandle);
      if (typeof text !== "string") return { ok: false, reason: "version-unavailable" };
      return {
        ok: true,
        text,
        fileName: boundHandle.name,
        size: Buffer.byteLength(text),
        lastModified: 1000,
      };
    },
    saveAs(text, fileName) {
      saveAsCount += 1;
      if (saveAsCount === 1) {
        writes.push({ kind: "saveAs-baseline", text, fileName, handle });
        disk.set(handle, text);
        return Promise.resolve({ ok: true, handle, fileName: handle.name, mode: "handle", durableWriteConfirmed: true });
      }
      return delayedWrite("saveAs", text, fileName, null);
    },
    writeHandle(boundHandle, text) {
      assert.equal(boundHandle, handle);
      return delayedWrite("handle", text, boundHandle.name, boundHandle);
    },
    async confirmDiscard() { return true; },
  };

  const root = {
    BRKTRK_VERSION: "g2a-test",
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
    createInitialProject: () => runtimeProject("NEW", 100),
  });
  const history = undoRedo.install(root, { projectStore: bundle.project });
  root.BRKTRKUndoRedo = history;

  const baseline = await session.dispatch({ type: "project.saveAs", source: "g2a.baseline" });
  assert.equal(baseline.ok, true);
  assert.equal(baseline.durableWriteConfirmed, true);
  assert.equal(session.snapshot().dirty, false);
  assert.equal(session.snapshot().revision, 0);
  assert.equal(session.snapshot().cleanRevision, 0);
  assert.equal(session.snapshot().saveInFlight, false, "completed baseline Save As must release file-session ownership before its promise resolves");

  const local = localStorageHarness();
  const recovery = recoveryDomain.createController(root, {
    projectStore: bundle.project,
    fileSession: session,
    localStorage: local,
    now: (() => { let tick = 1000; return () => ++tick; })(),
  });
  assert.equal(recovery.snapshot().journalPresent, false);

  return { model, state, bundle, handle, writes, pendingWrites, disk, adapter, root, session, history, local, recovery };
}

function resolveSuccess(write, options = {}) {
  const outputHandle = options.handle ?? write.handle ?? { name: options.fileName ?? write.fileName };
  write.gate.resolve({
    ok: true,
    handle: outputHandle,
    fileName: options.fileName ?? outputHandle?.name ?? write.fileName,
    mode: "handle",
    durableWriteConfirmed: true,
  });
}

(async () => {
  // Core TOCTOU: A0 clean -> A1 dirty -> Save A1 starts -> A2 arrives while
  // direct File System Access I/O is unresolved. A1 reaching disk must establish
  // A1, not live A2, as the clean baseline.
  {
    const h = await createHarness("G2A STALE SUCCESS");
    h.bundle.project.setTempo(130, { source: "g2a.a1" });
    assert.equal(h.session.snapshot().revision, 1);
    assert.equal(h.session.snapshot().dirty, true);
    assert.equal(h.recovery.snapshot().journalPresent, true);

    const savePromise = h.session.dispatch({ type: "project.save", source: "g2a.delayed" });
    assert.equal(h.pendingWrites.length, 1, "Save must hand A1 bytes to the direct writer after synchronous version verification and before awaiting writer I/O");
    assert.equal(JSON.parse(h.pendingWrites[0].text).project.tempo, 130, "delayed writer must hold the exact A1 snapshot");

    h.bundle.project.setTempo(140, { source: "g2a.a2" });
    assert.equal(h.model.tempo, 140);
    assert.equal(h.session.snapshot().revision, 2);
    assert.equal(h.session.snapshot().dirty, true);
    assert.equal(h.recovery.snapshot().journalPresent, true, "newer A2 must be recovery-protected while A1 write is pending");
    h.local.resetCounts();

    resolveSuccess(h.pendingWrites[0], { handle: h.handle });
    const savedA1 = await savePromise;
    assert.equal(savedA1.ok, true);
    assert.equal(savedA1.durableWriteConfirmed, true);
    assert.equal(savedA1.writtenRevision, 1);
    assert.equal(savedA1.currentRevision, 2);
    assert.equal(savedA1.currentChangedSinceWrite, true);
    assert.equal(JSON.parse(savedA1.text).project.tempo, 130, "reported saved bytes must remain A1");
    assert.equal(h.model.tempo, 140, "newer A2 desired state must remain current after A1 write resolves");
    assert.equal(h.session.snapshot().dirty, true, "successful stale A1 write must not mark newer current A2 clean");
    assert.equal(h.session.snapshot().cleanRevision, 1, "clean revision must identify the exact written A1 revision");
    assert.equal(h.session.snapshot().revision, 2, "current revision must retain the newer A2 mutation");
    assert.equal(h.recovery.snapshot().journalPresent, true, "successful stale A1 write must retain recovery for newer A2");
    assert.equal(h.local.counts.remove, 0, "stale write success must not false-clean and remove the recovery journal");

    assert.equal(h.history.undo().ok, true, "one Undo must return A2 to the exact written A1 baseline");
    assert.equal(h.model.tempo, 130);
    assert.equal(h.session.snapshot().dirty, false, "Undo to exact written A1 bytes must become clean");
    assert.equal(h.recovery.snapshot().journalPresent, false, "Undo to written clean baseline must clear recovery journal");
  }

  // Failed delayed write: neither the pre-write baseline nor recovery protection
  // may move just because a newer edit occurred while the failed I/O was pending.
  {
    const h = await createHarness("G2A STALE FAILURE");
    h.bundle.project.setTempo(131, { source: "g2a.failure.a1" });
    const savePromise = h.session.dispatch({ type: "project.save", source: "g2a.failure.save" });
    assert.equal(h.pendingWrites.length, 1);
    assert.equal(JSON.parse(h.pendingWrites[0].text).project.tempo, 131);
    h.bundle.project.setTempo(132, { source: "g2a.failure.a2" });
    assert.equal(h.recovery.snapshot().journalPresent, true);
    h.local.resetCounts();
    h.pendingWrites[0].gate.resolve({ ok: false, error: new Error("disk full") });
    const failed = await savePromise;
    assert.equal(failed.ok, false);
    assert.equal(h.model.tempo, 132);
    assert.equal(h.session.snapshot().revision, 2);
    assert.equal(h.session.snapshot().cleanRevision, 0, "failed write must not advance the clean revision");
    assert.equal(h.session.snapshot().dirty, true, "failed write must keep newer current state dirty");
    assert.equal(h.recovery.snapshot().journalPresent, true, "failed write must retain recovery for newer current state");
    assert.equal(h.local.counts.remove, 0, "failed write must not clear recovery journal");
  }

  // Overlap contract: Save/Save As is serialized by the file-session owner.
  // The queued Save As does not capture/write until the first direct Save has
  // completed, then it captures the then-current revision exactly.
  {
    const h = await createHarness("G2A OVERLAP");
    h.bundle.project.setTempo(150, { source: "g2a.overlap.a1" });
    const firstPromise = h.session.dispatch({ type: "project.save", source: "g2a.overlap.save" });
    assert.equal(h.pendingWrites.length, 1);
    assert.equal(JSON.parse(h.pendingWrites[0].text).project.tempo, 150);
    const firstOperationId = h.session.snapshot().activeSaveOperationId;
    assert.ok(Number.isInteger(firstOperationId));

    h.bundle.project.setTempo(160, { source: "g2a.overlap.a2" });
    const secondPromise = h.session.dispatch({ type: "project.saveAs", source: "g2a.overlap.saveAs" });
    assert.equal(h.pendingWrites.length, 1, "queued Save As must not start a second writer while Save is active");
    assert.equal(h.session.snapshot().queuedSaveCount, 1);

    resolveSuccess(h.pendingWrites[0], { handle: h.handle });
    const first = await firstPromise;
    assert.equal(first.ok, true);
    assert.equal(first.writtenRevision, 1);
    assert.equal(first.currentChangedSinceWrite, true);
    assert.equal(h.session.snapshot().saveInFlight, true, "queued Save As must own the file session before first Save promise resolves");
    assert.equal(h.pendingWrites.length, 2, "queued Save As must start immediately after first Save completes");
    assert.equal(h.pendingWrites[1].kind, "saveAs");
    assert.equal(JSON.parse(h.pendingWrites[1].text).project.tempo, 160, "queued Save As must capture the current A2 revision when it starts");
    const secondOperationId = h.session.snapshot().activeSaveOperationId;
    assert.ok(secondOperationId > firstOperationId, "serialized Save operations need monotonic operation identity");
    assert.equal(h.session.snapshot().queuedSaveCount, 0);

    const saveAsHandle = { name: "g2a-overlap-save-as.brktrk" };
    resolveSuccess(h.pendingWrites[1], { handle: saveAsHandle, fileName: saveAsHandle.name });
    const second = await secondPromise;
    assert.equal(second.ok, true);
    assert.equal(second.writtenRevision, 2);
    assert.equal(second.currentRevision, 2);
    assert.equal(second.currentChangedSinceWrite, false);
    assert.equal(second.saveOperationId, secondOperationId);
    assert.equal(h.session.snapshot().dirty, false, "second serialized Save As must clean exactly the A2 state it wrote");
    assert.equal(h.session.snapshot().cleanRevision, 2);
    assert.equal(h.session.snapshot().fileName, saveAsHandle.name);
    assert.equal(h.recovery.snapshot().journalPresent, false, "successful final Save As of current state must clear recovery");
    assert.equal(h.session.snapshot().saveInFlight, false, "completed Save As must release file-session ownership before its promise resolves");
  }

  console.log("G2A delayed Save exact-written-revision + overlap acceptance passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
