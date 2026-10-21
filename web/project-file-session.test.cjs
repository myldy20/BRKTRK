const assert = require("node:assert/strict");
const stores = require("./stores.js");
const storage = require("./project-storage.js");
const files = require("./project-file.js");
const sessionDomain = require("./project-file-session.js");

function runtimeProject(name = "SESSION", tempo = 120) {
  const project = {
    schemaVersion: 2,
    projectName: name,
    tempo,
    tracks: [{ mix: { gain: 1, mute: false, pan: 0 } }],
    song: [[0]],
    chains: { 0: [{ phrase: 0, transpose: 0 }] },
    phrases: { 0: [{ note: 60, velocity: 100, instrument: 0, fx: [0, 0, 0] }] },
    instruments: [{ params: [1, 2, 3, 4, 5, 6], unknown: { keep: true } }],
    compatibilityExtensions: { "org.example.project": { keep: true } },
  };
  storage.installRuntimeProject(project);
  return project;
}

function createHarness(options = {}) {
  const model = runtimeProject(options.name ?? "SESSION", options.tempo ?? 120);
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
  const handleTexts = new Map();
  const adapter = {
    capabilities: { directOpen: true, directSave: true, uploadFallback: true, downloadFallback: true },
    async openFile() {
      const result = options.openResult ?? { ok: false, cancelled: true };
      if (result?.ok && result.handle && typeof result.text === "string") handleTexts.set(result.handle, result.text);
      return result;
    },
    readHandleVersion(handle) {
      const text = handleTexts.get(handle);
      if (typeof text !== "string") return { ok: false, reason: "version-unavailable" };
      return {
        ok: true,
        text,
        fileName: handle.name ?? null,
        size: Buffer.byteLength(text),
        lastModified: 1000,
      };
    },
    async writeHandle(handle, text) {
      writes.push({ kind: "handle", handle, text });
      const result = options.writeResult ?? { ok: true, handle, fileName: handle.name, mode: "handle", durableWriteConfirmed: true };
      if (result?.ok && result.durableWriteConfirmed === true) {
        const outputHandle = result.handle ?? handle;
        if (outputHandle) handleTexts.set(outputHandle, text);
      }
      return result;
    },
    async saveAs(text, fileName) {
      writes.push({ kind: "saveAs", fileName, text });
      const result = options.saveAsResult ?? { ok: true, handle: null, fileName, mode: "download", durableWriteConfirmed: false };
      if (result?.ok && result.durableWriteConfirmed === true && result.handle) handleTexts.set(result.handle, text);
      return result;
    },
    confirmDiscard: async () => options.confirmDiscard ?? true,
  };
  const resets = [];
  const selections = [];
  const root = {
    BRKTRK_VERSION: options.version ?? "test-release",
    BRKTRKStores: bundle,
    BRKTRKCommands: { installed: true },
    BRKTRKUndoRedo: { reset: (reason) => resets.push(reason) },
    BRKTRKSelectionClipboard: { cancelSelection: (reason) => selections.push(reason) },
    stopPlayback() {},
    renderAll() {},
    focusSelectedCell() {},
    setStatus() {},
  };
  const controller = sessionDomain.createController(root, {
    projectStore: bundle.project,
    navigationStore: bundle.navigation,
    commands: root.BRKTRKCommands,
    adapter,
    createInitialProject: () => runtimeProject("NEW PROJECT", 100),
  });
  return { model, state, bundle, adapter, writes, handleTexts, resets, selections, root, controller };
}

(async () => {
  {
    const project = runtimeProject("CONDITION FILE", 123);
    delete project.phrases[0][0].condition;
    const envelope = JSON.parse(files.serializeProject(project));
    assert.deepEqual(
      envelope.project.phrases[0][0].condition,
      { probability: 100, every: 1, offset: 0 },
      "portable serialization must canonicalize an absent Phrase condition",
    );
    project.phrases[0][0].condition = { probability: 41, every: 4, offset: 3 };
    const conditioned = JSON.parse(files.serializeProject(project));
    assert.deepEqual(
      conditioned.project.phrases[0][0].condition,
      { probability: 41, every: 4, offset: 3 },
      "portable serialization must preserve the normalized Phrase condition independently from FX",
    );
  }

  // Real Open controller and Settings rendering expose the boundary/key while
  // preserving the active project and file identity. Typed errors avoid showing
  // arbitrary file-controlled strings as instructions.
  for (const boundary of ["project", "envelope"]) {
    const payload = files.createEnvelope(runtimeProject("REJECTED", 155));
    Object.defineProperty(boundary === "project" ? payload.project : payload, "constructor", { value: { keep: true }, enumerable: true });
    const h = createHarness({ openResult: { ok: true, text: JSON.stringify(payload), fileName: "reserved.brktrk", mode: "upload" } });
    const status = { textContent: "", dataset: {} };
    h.root.document = { querySelector: selector => selector === "#fileSessionStatus" ? status : null };
    const notices = [];
    h.root.setStatus = message => notices.push(message);
    const before = JSON.stringify(h.model);
    const result = await h.controller.dispatch({ type: "project.open" });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(h.model), before);
    assert.equal(h.controller.snapshot().fileName, null);
    assert.match(status.textContent, new RegExp(`RESERVED KEY constructor AT ${boundary.toUpperCase()}`));
    assert.equal(status.dataset.fileError, "reserved-key");
    assert.match(notices.at(-1), /CURRENT PROJECT UNCHANGED/);
  }

  // Exercise the built-in browser adapter itself, not only controller mocks.
  // Dispatching an <a download> request is successful export initiation but
  // cannot affirm that durable bytes exist outside the page.
  {
    let clicks = 0;
    let appended = 0;
    let removed = 0;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:brktrk-test";
    URL.revokeObjectURL = () => {};
    try {
      const root = {
        document: {
          createElement(tag) {
            assert.equal(tag, "a");
            return {
              hidden: false,
              href: "",
              download: "",
              click() { clicks += 1; },
              remove() { removed += 1; },
            };
          },
          body: { append() { appended += 1; } },
        },
        setTimeout() {},
      };
      const adapter = sessionDomain.createBrowserFileAdapter(root);
      assert.equal(adapter.capabilities.directSave, false);
      const result = await adapter.saveAs("{}", "fallback.brktrk");
      assert.equal(result.ok, true);
      assert.equal(result.mode, "download");
      assert.equal(result.durableWriteConfirmed, false);
      assert.equal(clicks, 1);
      assert.equal(appended, 1);
      assert.equal(removed, 1);
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  }

  // The direct File System Access path may affirm durability only after both
  // write() and close() complete successfully.
  {
    const calls = [];
    let currentText = "";
    const handle = {
      name: "direct.brktrk",
      async getFile() {
        return {
          name: this.name,
          size: Buffer.byteLength(currentText),
          lastModified: 1000,
          async text() { return currentText; },
        };
      },
      async createWritable() {
        calls.push("createWritable");
        return {
          async write(text) { calls.push(`write:${text}`); currentText = text; },
          async close() { calls.push("close"); },
        };
      },
    };
    const adapter = sessionDomain.createBrowserFileAdapter({ showSaveFilePicker: async () => handle });
    assert.equal(adapter.capabilities.directSave, true);
    const result = await adapter.saveAs("{\"ok\":true}", handle.name);
    assert.equal(result.ok, true);
    assert.equal(result.handle, handle);
    assert.equal(result.mode, "handle");
    assert.equal(result.durableWriteConfirmed, true);
    assert.deepEqual(calls, ["createWritable", "write:{\"ok\":true}", "close"]);
    const version = await adapter.readHandleVersion(handle);
    assert.equal(version.ok, true);
    assert.equal(version.text, "{\"ok\":true}");
  }

  {
    const h = createHarness();
    assert.equal(h.controller.snapshot().dirty, false);
    assert.equal(h.controller.snapshot().fileName, null);
    h.bundle.project.setTempo(130, { source: "unit" });
    assert.equal(h.controller.snapshot().dirty, true, "ProjectStore persistence mutation must dirty file session");
    h.bundle.project.setTempo(120, { source: "unit" });
    assert.equal(h.controller.snapshot().dirty, false, "returning exactly to clean canonical state must clear dirty");
    h.bundle.navigation.selectWorkspace("song", { source: "unit-navigation" });
    assert.equal(h.controller.snapshot().dirty, false, "Navigation-only mutation must not dirty project file session");
  }

  {
    const h = createHarness({ version: "0.8.47-test" });
    h.bundle.project.setTempo(131, { source: "unit" });
    const saved = await h.controller.dispatch({ type: "project.saveAs", source: "unit" });
    assert.equal(saved.ok, true);
    assert.equal(saved.durableWriteConfirmed, false, "download dispatch must not pretend that bytes are durably written");
    assert.equal(h.controller.snapshot().dirty, true, "unconfirmed download must retain the dirty safety checkpoint");
    assert.equal(h.controller.snapshot().bindingMode, "none", "download fallback must not bind the session to a file it cannot reopen");
    assert.equal(h.controller.snapshot().fileName, null);
    assert.match(h.controller.snapshot().lastOperation.message, /^DOWNLOAD STARTED · /);
    assert.equal(h.controller.snapshot().lastOperation.message.includes("SAVED ·"), false);
    assert.equal(h.writes.length, 1);
    const parsed = JSON.parse(h.writes[0].text);
    assert.equal(parsed.format, "BRKTRK_PROJECT");
    assert.equal(parsed.formatVersion, 1);
    assert.equal(parsed.producer.app, "BRKTRK");
    assert.equal(parsed.producer.version, "0.8.47-test", "portable producer metadata must use the current runtime release identity");
    assert.equal(parsed.project.schemaVersion, storage.CURRENT_SCHEMA_VERSION);
    assert.deepEqual(parsed.project.instrumentPool, {});
    assert.equal(Object.hasOwn(parsed.project, "instruments"), false);
    assert.deepEqual(
      parsed.project.compatibilityExtensions,
      { "org.example.project": { keep: true } },
      "portable save must preserve unrelated compatibility extensions after retired preview cleanup",
    );
  }

  {
    const handle = { name: "bound.brktrk" };
    const h = createHarness({ saveAsResult: { ok: true, handle, fileName: handle.name, mode: "handle", durableWriteConfirmed: true } });
    const first = await h.controller.dispatch({ type: "project.saveAs" });
    assert.equal(first.ok, true);
    assert.equal(first.durableWriteConfirmed, true);
    assert.equal(h.controller.snapshot().fileVersionKnown, true);
    h.bundle.project.setTempo(132, { source: "unit" });
    assert.equal(h.controller.snapshot().dirty, true);
    assert.equal((await h.controller.dispatch({ type: "project.save" })).ok, true);
    assert.equal(h.writes.at(-1).kind, "handle", "bound Save must write through existing direct handle");
    assert.equal(h.controller.snapshot().dirty, false);
  }

  {
    const handle = { name: "bound.brktrk" };
    const h = createHarness({
      saveAsResult: { ok: true, handle, fileName: handle.name, mode: "handle", durableWriteConfirmed: true },
      writeResult: { ok: false, error: new Error("disk full") },
    });
    await h.controller.dispatch({ type: "project.saveAs" });
    h.bundle.project.setTempo(133, { source: "unit" });
    const before = h.controller.snapshot();
    const failed = await h.controller.dispatch({ type: "project.save" });
    assert.equal(failed.ok, false);
    assert.equal(h.controller.snapshot().dirty, true, "failed write must never establish a clean checkpoint");
    assert.equal(h.controller.snapshot().fileName, before.fileName, "failed write must preserve previous file identity");
  }

  {
    const h = createHarness({ openResult: { ok: true, text: "{broken", fileName: "bad.brktrk", handle: null, mode: "upload" } });
    const before = JSON.stringify(storage.migrateProject(h.model).project);
    const opened = await h.controller.dispatch({ type: "project.open" });
    assert.equal(opened.ok, false);
    assert.equal(JSON.stringify(storage.migrateProject(h.model).project), before, "invalid Open must leave active project unchanged");
    assert.equal(h.controller.snapshot().fileName, null);
  }

  {
    const incoming = runtimeProject("INCOMING", 155);
    const text = files.serializeProject(incoming, {
      unknownEnvelope: { futureOuter: { keep: true } },
      producer: { app: "OTHER", version: "1", futureProducer: { keep: true } },
    });
    const handle = { name: "incoming.brktrk" };
    const h = createHarness({ openResult: { ok: true, text, fileName: handle.name, handle, mode: "handle" } });
    h.bundle.project.setTempo(129, { source: "pre-open" });
    assert.equal(h.controller.snapshot().dirty, true);
    const opened = await h.controller.dispatch({ type: "project.open" });
    assert.equal(opened.ok, true);
    assert.equal(h.model.projectName, "INCOMING");
    assert.equal(h.model.tempo, 155);
    assert.equal(h.model.schemaVersion, storage.CURRENT_SCHEMA_VERSION);
    assert.deepEqual(h.model.instrumentPool, {});
    assert.equal(h.controller.snapshot().dirty, false);
    assert.equal(h.controller.snapshot().fileName, "incoming.brktrk");
    assert.equal(h.controller.snapshot().hasHandle, true);
    assert.equal(h.controller.snapshot().fileVersionKnown, true);
    assert.ok(h.resets.includes("project-open"), "Open must clear old Undo history boundary");
    assert.ok(h.selections.includes("project-open"), "Open must cancel active selection references");
    assert.deepEqual(h.state.focus, { pane: "phrase", row: 0, col: 0 });
    h.bundle.project.setTempo(156, { source: "post-open" });
    const saved = await h.controller.dispatch({ type: "project.save" });
    assert.equal(saved.ok, true);
    assert.equal(saved.durableWriteConfirmed, true);
    const rewritten = JSON.parse(saved.text);
    assert.equal(rewritten.futureOuter.keep, true, "unknown outer envelope data must survive Open→Save");
    assert.equal(rewritten.producer.futureProducer.keep, true, "unknown producer fields must survive while BRKTRK refreshes producer identity");
    assert.equal(rewritten.producer.app, "BRKTRK");
    assert.equal(rewritten.project.schemaVersion, storage.CURRENT_SCHEMA_VERSION);
  }

  {
    const h = createHarness({ confirmDiscard: false });
    h.bundle.project.setTempo(140, { source: "dirty" });
    const before = h.model.projectName;
    const result = await h.controller.dispatch({ type: "project.new" });
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(h.model.projectName, before, "cancelled New must leave project unchanged");
  }

  {
    const h = createHarness({ confirmDiscard: true });
    h.bundle.project.setTempo(140, { source: "dirty" });
    const result = await h.controller.dispatch({ type: "project.new" });
    assert.equal(result.ok, true);
    assert.equal(h.model.projectName, "NEW PROJECT");
    assert.equal(h.model.tempo, 100);
    assert.equal(h.model.schemaVersion, storage.CURRENT_SCHEMA_VERSION);
    assert.deepEqual(h.model.instrumentPool, {});
    assert.equal(h.controller.snapshot().dirty, false);
    assert.equal(h.controller.snapshot().fileName, null);
    assert.equal(h.controller.snapshot().fileVersionKnown, false);
    assert.ok(h.resets.includes("project-new"));
  }

  console.log("A2 project file session tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

