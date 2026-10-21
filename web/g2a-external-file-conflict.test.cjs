"use strict";

const assert = require("node:assert/strict");
const stores = require("./stores.js");
const storage = require("./project-storage.js");
const files = require("./project-file.js");
const sessionDomain = require("./project-file-session.js");

function makeProject(name = "G2A EXTERNAL FILE", tempo = 120) {
  return {
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
}

function serialize(project) {
  return files.serializeProject(project, { producer: { app: "BRKTRK", version: "g2a-conflict-test" } });
}

function createHarness(options = {}) {
  const model = makeProject(options.name ?? "G2A EXTERNAL FILE", 120);
  storage.installRuntimeProject(model);
  const state = {
    view: "phrase", dock: "mix", songRow: 0, track: 0, chain: 0, chainRow: 0,
    phrase: 0, phraseRow: 0, instrument: 0,
    focus: { pane: "phrase", row: 0, col: 0 }, lastChain: 0, lastPhrase: 0,
    p3: { activeWorkspace: "phrase", soundParam: 0, parents: [], mixReturn: null },
  };
  const bundle = stores.createStores({ model, state, trackCount: 8 });
  const originalHandle = { name: "shared.brktrk" };
  const saveAsHandle = { name: "copy.brktrk" };
  const disks = new Map();
  const writes = [];
  let version = 1;
  disks.set(originalHandle, { text: serialize(makeProject(options.name ?? "G2A EXTERNAL FILE", 120)), lastModified: 1000 });

  const adapter = {
    capabilities: { directOpen: true, directSave: true, uploadFallback: true, downloadFallback: true },
    async openFile() {
      const record = disks.get(originalHandle);
      return { ok: true, text: record.text, fileName: originalHandle.name, handle: originalHandle, mode: "handle" };
    },
    async readHandleVersion(handle) {
      if (options.verificationUnavailable) return { ok: false, reason: "version-unavailable" };
      const record = disks.get(handle);
      if (!record) return { ok: false, reason: "version-unavailable" };
      return {
        ok: true,
        text: record.text,
        fileName: handle.name,
        size: Buffer.byteLength(record.text),
        lastModified: record.lastModified,
      };
    },
    async writeHandle(handle, text) {
      writes.push({ kind: "handle", handle, text });
      disks.set(handle, { text, lastModified: 2000 + (++version) });
      return { ok: true, handle, fileName: handle.name, mode: "handle", durableWriteConfirmed: true };
    },
    async saveAs(text) {
      writes.push({ kind: "saveAs", handle: saveAsHandle, text });
      disks.set(saveAsHandle, { text, lastModified: 3000 + (++version) });
      return { ok: true, handle: saveAsHandle, fileName: saveAsHandle.name, mode: "handle", durableWriteConfirmed: true };
    },
    async confirmDiscard() { return true; },
  };

  const root = {
    BRKTRK_VERSION: "g2a-conflict-test",
    BRKTRKStores: bundle,
    BRKTRKCommands: { installed: true },
    BRKTRKSelectionClipboard: { cancelSelection() {} },
    BRKTRKUndoRedo: { reset() {} },
    stopPlayback() {}, renderAll() {}, focusSelectedCell() {}, setStatus() {},
  };
  const session = sessionDomain.createController(root, {
    projectStore: bundle.project,
    navigationStore: bundle.navigation,
    commands: root.BRKTRKCommands,
    adapter,
    createInitialProject: () => makeProject("NEW", 100),
  });

  function externalReplace(tempo, { preserveMetadata = false } = {}) {
    const before = disks.get(originalHandle);
    const text = serialize(makeProject(options.name ?? "G2A EXTERNAL FILE", tempo));
    disks.set(originalHandle, {
      text,
      lastModified: preserveMetadata ? before.lastModified : 4000 + (++version),
    });
    return text;
  }

  return { model, bundle, originalHandle, saveAsHandle, disks, writes, session, externalReplace };
}

(async () => {
  // Regression: a direct file changed after Open must not be overwritten by a
  // later ordinary Save. Keep metadata stable to prove comparison is not only
  // lastModified/size based.
  {
    const h = createHarness({ name: "G2A CONFLICT BLOCK" });
    assert.equal((await h.session.dispatch({ type: "project.open" })).ok, true);
    h.bundle.project.setTempo(130, { source: "g2a.local-edit" });
    const externalText = h.externalReplace(140, { preserveMetadata: true });
    const beforeWrites = h.writes.length;

    const blocked = await h.session.dispatch({ type: "project.save", source: "g2a.conflict" });
    assert.equal(blocked.ok, false, "external modification must block direct overwrite");
    assert.equal(blocked.conflict, true);
    assert.equal(blocked.reason, "external-file-conflict");
    assert.equal(h.writes.length, beforeWrites, "conflicted Save must not enter the writer");
    assert.equal(h.disks.get(h.originalHandle).text, externalText, "externally changed file must remain untouched");
    assert.equal(h.session.snapshot().dirty, true);
    assert.equal(h.session.snapshot().externalConflict?.kind, "modified");
    assert.ok(Number.isInteger(h.session.snapshot().externalConflict?.id));
    assert.deepEqual(h.session.snapshot().externalConflict?.allowedActions, ["overwrite", "saveAs", "open"]);

    const copied = await h.session.dispatch({ type: "project.saveAs", source: "g2a.conflict-save-as" });
    assert.equal(copied.ok, true, "Save As must remain available from conflict state");
    assert.equal(copied.durableWriteConfirmed, true);
    assert.equal(h.disks.get(h.originalHandle).text, externalText, "Save As must not destroy the externally changed original");
    assert.equal(JSON.parse(h.disks.get(h.saveAsHandle).text).project.tempo, 130);
    assert.equal(h.session.snapshot().externalConflict, null, "successful direct Save As establishes a new conflict-free binding");
  }

  // Explicit overwrite is scoped to the exact conflict observation. If the
  // external file changes again after the warning, the stale decision must not
  // authorize a write.
  {
    const h = createHarness({ name: "G2A CONFLICT DECISION" });
    await h.session.dispatch({ type: "project.open" });
    h.bundle.project.setTempo(131, { source: "g2a.local-a1" });
    const localWrittenRevision = h.session.snapshot().revision;
    h.externalReplace(141);
    const first = await h.session.dispatch({ type: "project.save" });
    const firstConflictId = first.externalConflict.id;
    const newerExternalText = h.externalReplace(151);

    const staleDecision = await h.session.dispatch({
      type: "project.save",
      conflictResolution: "overwrite",
      conflictId: firstConflictId,
      source: "g2a.stale-overwrite-decision",
    });
    assert.equal(staleDecision.ok, false);
    assert.equal(staleDecision.conflict, true);
    assert.equal(h.writes.length, 0, "a changed-again external file requires a fresh explicit decision");
    assert.equal(h.disks.get(h.originalHandle).text, newerExternalText);
    assert.notEqual(staleDecision.externalConflict.id, firstConflictId);

    const accepted = await h.session.dispatch({
      type: "project.save",
      conflictResolution: "overwrite",
      conflictId: staleDecision.externalConflict.id,
      source: "g2a.accept-overwrite",
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.durableWriteConfirmed, true);
    assert.equal(
      accepted.writtenRevision,
      localWrittenRevision,
      "#363 exact-written revision identity must remain the revision actually captured for overwrite",
    );
    assert.equal(JSON.parse(h.disks.get(h.originalHandle).text).project.tempo, 131);
    assert.equal(h.session.snapshot().dirty, false);
    assert.equal(h.session.snapshot().externalConflict, null);
    assert.equal(h.session.snapshot().fileVersionKnown, true, "confirmed overwrite must refresh the bound file version token");

    h.bundle.project.setTempo(132, { source: "g2a.local-a2" });
    h.externalReplace(152, { preserveMetadata: true });
    const refreshedConflict = await h.session.dispatch({ type: "project.save" });
    assert.equal(refreshedConflict.ok, false, "post-save token must detect the next external modification");
    assert.equal(refreshedConflict.conflict, true);
    assert.equal(h.writes.length, 1, "second external conflict must occur before a second overwrite");
  }

  // If the direct target cannot be re-read reliably, ordinary Save and even an
  // overwrite intent fail closed. Save As is still permitted because the user
  // selects a new destination explicitly.
  {
    const h = createHarness({ name: "G2A CONFLICT FAIL CLOSED", verificationUnavailable: true });
    await h.session.dispatch({ type: "project.open" });
    h.bundle.project.setTempo(133, { source: "g2a.unverifiable" });

    const blocked = await h.session.dispatch({ type: "project.save" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.conflict, true);
    assert.equal(blocked.reason, "external-file-verification-unavailable");
    assert.equal(h.writes.length, 0);
    assert.equal(blocked.externalConflict.kind, "unverifiable");
    assert.deepEqual(blocked.externalConflict.allowedActions, ["saveAs", "open"]);

    const stillBlocked = await h.session.dispatch({
      type: "project.save",
      conflictResolution: "overwrite",
      conflictId: blocked.externalConflict.id,
    });
    assert.equal(stillBlocked.ok, false, "unverifiable direct target must remain fail-closed even with overwrite intent");
    assert.equal(h.writes.length, 0);

    const copied = await h.session.dispatch({ type: "project.saveAs" });
    assert.equal(copied.ok, true);
    assert.equal(copied.durableWriteConfirmed, true);
    assert.equal(JSON.parse(h.disks.get(h.saveAsHandle).text).project.tempo, 133);
  }

  console.log("G2A external direct-file conflict acceptance passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
