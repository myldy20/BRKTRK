const assert = require("node:assert/strict");
const stores = require("./stores.js");
const storage = require("./project-storage.js");
const files = require("./project-file.js");
const sessionDomain = require("./project-file-session.js");
const recoveryDomain = require("./project-recovery.js");

class MemoryStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
  }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  key(index) { return [...this.map.keys()][index] ?? null; }
  get length() { return this.map.size; }
  keys() { return [...this.map.keys()]; }
}

class RejectingStorage extends MemoryStorage {
  setItem() { throw new Error("fixture storage quota exceeded"); }
}

function runtimeProject(name = "RECOVERY", tempo = 120) {
  const project = {
    schemaVersion: 2,
    projectName: name,
    tempo,
    tracks: [{ mix: { gain: 1, mute: false, pan: 0 } }],
    song: [[0]],
    chains: { 0: [{ phrase: 0, transpose: 0 }] },
    phrases: { 0: [{ note: 60, velocity: 100, instrument: 0, fx: [0, 0, 0] }] },
    instruments: [{ params: [1, 2, 3, 4, 5, 6], unknown: { keep: true } }],
  };
  storage.installRuntimeProject(project);
  return project;
}

function createHarness(options = {}) {
  const model = runtimeProject(options.name ?? "RECOVERY", options.tempo ?? 120);
  const state = {
    view: "phrase",
    dock: "mix",
    songRow: 0,
    track: 0,
    chain: 0,
    chainRow: 0,
    phrase: 0,
    phraseRow: 0,
    instrument: 0,
    focus: { pane: "phrase", row: 0, col: 0 },
    lastChain: 0,
    lastPhrase: 0,
    p3: { activeWorkspace: "phrase", soundParam: 0, parents: [], mixReturn: null },
  };
  const bundle = stores.createStores({ model, state, trackCount: 8 });
  const writes = [];
  const statuses = [];
  const adapter = {
    capabilities: { directOpen: false, directSave: false, uploadFallback: true, downloadFallback: true },
    openFile: async () => ({ ok: false, cancelled: true }),
    writeHandle: async (handle, text) => {
      writes.push({ text, fileName: handle?.name ?? null, kind: "handle" });
      return options.writeResult ?? { ok: true, handle, fileName: handle?.name ?? null, mode: "handle", durableWriteConfirmed: true };
    },
    saveAs: async (text, fileName) => {
      writes.push({ text, fileName, kind: "saveAs" });
      return options.saveAsResult ?? { ok: true, handle: null, fileName, mode: "download", durableWriteConfirmed: false };
    },
    confirmDiscard: async () => true,
  };
  const root = {
    BRKTRK_VERSION: "0.8.48-test",
    BRKTRKStores: bundle,
    BRKTRKCommands: { installed: true },
    BRKTRKUndoRedo: { reset() {} },
    BRKTRKSelectionClipboard: { cancelSelection() {} },
    stopPlayback() {},
    renderAll() {},
    focusSelectedCell() {},
    setStatus(message, tone = null) { statuses.push({ message, tone }); },
  };
  const fileSession = sessionDomain.createController(root, {
    projectStore: bundle.project,
    navigationStore: bundle.navigation,
    commands: root.BRKTRKCommands,
    adapter,
    createInitialProject: () => runtimeProject("NEW PROJECT", 100),
  });
  return { model, state, bundle, writes, statuses, adapter, root, fileSession };
}

(async () => {
  {
    let clock = 1000;
    const local = new MemoryStorage();
    const h = createHarness();
    const recovery = recoveryDomain.createController(h.root, {
      projectStore: h.bundle.project,
      fileSession: h.fileSession,
      localStorage: local,
      now: () => ++clock,
    });
    assert.equal(recovery.snapshot().status, "idle");
    h.bundle.project.setTempo(130, { source: "a3-unit-dirty" });
    const raw = local.getItem(recoveryDomain.JOURNAL_KEY);
    assert.ok(raw, "dirty ProjectStore mutation must synchronously arm recovery journal");
    const journal = recoveryDomain.normalizeJournal(JSON.parse(raw));
    assert.equal(journal.cleanProject.tempo, 120);
    assert.equal(journal.dirtyProject.tempo, 130);
    assert.equal(recovery.snapshot().status, "armed");
    assert.equal(recovery.snapshot().journalPresent, true);
    const before = raw;
    h.bundle.navigation.selectWorkspace("song", { source: "a3-navigation-only" });
    assert.equal(local.getItem(recoveryDomain.JOURNAL_KEY), before, "Navigation-only changes must not rewrite project recovery journal");
  }

  {
    const local = new MemoryStorage();
    const h = createHarness();
    const recovery = recoveryDomain.createController(h.root, {
      projectStore: h.bundle.project,
      fileSession: h.fileSession,
      localStorage: local,
      now: () => 2000,
    });
    h.bundle.project.setTempo(131, { source: "a3-unit-download" });
    const before = local.getItem(recoveryDomain.JOURNAL_KEY);
    assert.ok(before);
    const downloaded = await h.fileSession.dispatch({ type: "project.saveAs", source: "a3-unit" });
    assert.equal(downloaded.ok, true);
    assert.equal(downloaded.durableWriteConfirmed, false);
    assert.equal(downloaded.recoveryRetained, true, "download may claim recovery retention only when the live recovery controller confirms a journal");
    assert.equal(h.fileSession.snapshot().dirty, true, "download dispatch cannot establish a clean checkpoint");
    assert.equal(local.getItem(recoveryDomain.JOURNAL_KEY), before, "unconfirmed download must preserve the exact recovery journal");
    assert.equal(recovery.snapshot().journalPresent, true);
    assert.match(h.statuses.at(-1).message, /RECOVERY RETAINED$/);
    assert.ok(!downloaded.text.includes(recoveryDomain.JOURNAL_FORMAT), "portable .brktrk must never contain recovery journal envelope");
    assert.ok(!downloaded.text.includes("cleanProject"), "portable .brktrk must not smuggle recovery baseline state");
  }

  {
    const local = new RejectingStorage();
    const h = createHarness();
    const recovery = recoveryDomain.createController(h.root, {
      projectStore: h.bundle.project,
      fileSession: h.fileSession,
      localStorage: local,
      now: () => 2050,
    });
    h.bundle.project.setTempo(131, { source: "a3-unit-storage-failure" });
    assert.equal(recovery.snapshot().status, "error");
    assert.equal(recovery.snapshot().journalPresent, false);
    assert.equal(local.getItem(recoveryDomain.JOURNAL_KEY), null);
    const downloaded = await h.fileSession.dispatch({ type: "project.saveAs", source: "a3-unit-storage-failure" });
    assert.equal(downloaded.ok, true);
    assert.equal(downloaded.durableWriteConfirmed, false);
    assert.equal(downloaded.recoveryRetained, false, "failed journaling must never be presented as retained recovery");
    assert.equal(h.fileSession.snapshot().dirty, true);
    assert.match(h.statuses.at(-1).message, /SAVE NOT CONFIRMED$/);
    assert.equal(h.statuses.at(-1).message.includes("RECOVERY RETAINED"), false);
  }

  {
    const local = new MemoryStorage();
    const handle = { name: "durable.brktrk" };
    const h = createHarness({
      saveAsResult: { ok: true, handle, fileName: handle.name, mode: "handle", durableWriteConfirmed: true },
    });
    const recovery = recoveryDomain.createController(h.root, {
      projectStore: h.bundle.project,
      fileSession: h.fileSession,
      localStorage: local,
      now: () => 2100,
    });
    h.bundle.project.setTempo(132, { source: "a3-unit-durable-save" });
    assert.ok(local.getItem(recoveryDomain.JOURNAL_KEY));
    const saved = await h.fileSession.dispatch({ type: "project.saveAs", source: "a3-unit" });
    assert.equal(saved.ok, true);
    assert.equal(saved.durableWriteConfirmed, true);
    assert.equal(h.fileSession.snapshot().dirty, false);
    assert.equal(local.getItem(recoveryDomain.JOURNAL_KEY), null, "confirmed durable Save may clear recovery journal after clean checkpoint");
    assert.equal(recovery.snapshot().journalPresent, false);
  }

  {
    const local = new MemoryStorage();
    const h1 = createHarness({ name: "BOOT", tempo: 120 });
    const incoming = runtimeProject("BOUND", 150);
    const incomingText = files.serializeProject(incoming, {
      unknownEnvelope: { futureOuter: { keep: true } },
      producer: { app: "OTHER", version: "1", futureProducer: { keep: true } },
    });
    const opened = await h1.fileSession.dispatch({
      type: "project.open",
      force: true,
      file: { text: incomingText, fileName: "bound.brktrk", handle: null, mode: "upload" },
    });
    assert.equal(opened.ok, true);
    recoveryDomain.createController(h1.root, {
      projectStore: h1.bundle.project,
      fileSession: h1.fileSession,
      localStorage: local,
      now: () => 3000,
    });
    h1.bundle.project.setTempo(151, { source: "a3-before-crash" });
    const crashRaw = local.getItem(recoveryDomain.JOURNAL_KEY);
    assert.ok(crashRaw);

    const recoveredHandle = { name: "bound-recovered.brktrk" };
    const h2 = createHarness({
      name: "BOUND",
      tempo: 151,
      saveAsResult: { ok: true, handle: recoveredHandle, fileName: recoveredHandle.name, mode: "handle", durableWriteConfirmed: true },
    });
    const recovery2 = recoveryDomain.createController(h2.root, {
      projectStore: h2.bundle.project,
      fileSession: h2.fileSession,
      localStorage: local,
      now: () => 3001,
    });
    assert.equal(recovery2.boot.recovered, true, "next launch must detect and adopt a valid dirty recovery journal");
    assert.equal(h2.model.projectName, "BOUND");
    assert.equal(h2.model.tempo, 151, "dirty working copy must be restored");
    assert.equal(h2.fileSession.snapshot().dirty, true, "recovered working copy must remain dirty relative to clean baseline");
    assert.equal(h2.fileSession.snapshot().fileName, "bound.brktrk", "recovery must preserve serializable file identity metadata");
    assert.equal(h2.fileSession.snapshot().bindingMode, "recovery", "opaque direct file handle must not be fabricated after restart");
    assert.equal(recovery2.snapshot().status, "recovered");
    assert.equal(recovery2.snapshot().pending, true);

    const saved = await h2.fileSession.dispatch({ type: "project.save", source: "a3-recovered-save" });
    assert.equal(saved.ok, true);
    assert.equal(saved.durableWriteConfirmed, true);
    const rewritten = JSON.parse(saved.text);
    assert.equal(rewritten.futureOuter.keep, true, "recovery must preserve unknown outer envelope fields across next Save");
    assert.equal(rewritten.producer.futureProducer.keep, true, "recovery must preserve unknown producer fields");
    assert.equal(rewritten.producer.app, "BRKTRK");
    assert.equal(rewritten.project.tempo, 151);
    assert.equal(local.getItem(recoveryDomain.JOURNAL_KEY), null, "confirmed durable Save of recovered work must clear journal");
  }

  {
    const clean = runtimeProject("DISCARD", 120);
    const dirty = runtimeProject("DISCARD", 140);
    const record = recoveryDomain.createJournal({
      cleanProject: clean,
      fileName: "discard.brktrk",
      bindingMode: "handle",
      unknownEnvelope: { futureOuter: { keep: true } },
      producer: { app: "BRKTRK", version: "0.8.47" },
    }, dirty, 4000);
    const local = new MemoryStorage({ [recoveryDomain.JOURNAL_KEY]: JSON.stringify(record) });
    const h = createHarness({ name: "DISCARD", tempo: 140 });
    const recovery = recoveryDomain.createController(h.root, {
      projectStore: h.bundle.project,
      fileSession: h.fileSession,
      localStorage: local,
      now: () => 4001,
    });
    assert.equal(h.model.tempo, 140);
    assert.equal(h.fileSession.snapshot().dirty, true);
    const discarded = recovery.discardRecovery();
    assert.equal(discarded.ok, true);
    assert.equal(h.model.tempo, 120, "Discard Recovery must restore the last clean checkpoint");
    assert.equal(h.fileSession.snapshot().dirty, false);
    assert.equal(local.getItem(recoveryDomain.JOURNAL_KEY), null);
    assert.equal(recovery.snapshot().pending, false);
  }

  {
    const raw = "{broken";
    const local = new MemoryStorage({ [recoveryDomain.JOURNAL_KEY]: raw });
    const h = createHarness({ tempo: 125 });
    const recovery = recoveryDomain.createController(h.root, {
      projectStore: h.bundle.project,
      fileSession: h.fileSession,
      localStorage: local,
      now: () => 5000,
    });
    assert.equal(h.model.tempo, 125, "invalid recovery journal must never replace active Project");
    assert.equal(recovery.snapshot().status, "invalid");
    assert.equal(local.getItem(recoveryDomain.JOURNAL_KEY), null, "invalid active journal must be removed only after quarantine copy succeeds");
    const quarantineKey = local.keys().find((key) => key.startsWith(recoveryDomain.INVALID_JOURNAL_PREFIX));
    assert.ok(quarantineKey, "invalid journal must be preserved under quarantine key");
    assert.equal(local.getItem(quarantineKey), raw);
  }

  console.log("A3 project recovery journal tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});