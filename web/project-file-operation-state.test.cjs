const assert = require("node:assert/strict");
const stores = require("./stores.js");
const storage = require("./project-storage.js");
const sessionDomain = require("./project-file-session.js");

function project(name = "OPS") {
  const value = {
    schemaVersion: storage.CURRENT_SCHEMA_VERSION,
    projectName: name,
    tempo: 120,
    tracks: Array.from({ length: 8 }, (_, id) => ({ id })),
    song: [],
    chains: {},
    phrases: {},
    instrumentPool: {},
    tables: {}, grooves: {}, scales: {}, modulation: {}, mixer: {}, master: {}, effects: {}, assets: {}, presets: {}, mappings: {},
  };
  storage.installRuntimeProject(value);
  return value;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(adapterOverrides = {}) {
  const model = project();
  const navigation = { view: "phrase", focus: { pane: "phrase", row: 0, col: 0 }, p3: { activeWorkspace: "phrase" } };
  const bundle = stores.createStores({ model, state: navigation, trackCount: 8 });
  const adapter = {
    capabilities: { directOpen: true, directSave: true },
    openFile: async () => ({ ok: false, cancelled: true }),
    readHandleVersion: async () => ({ ok: false, reason: "version-unavailable" }),
    writeHandle: async () => ({ ok: false, cancelled: true }),
    saveAs: async () => ({ ok: false, cancelled: true }),
    confirmDiscard: async () => true,
    ...adapterOverrides,
  };
  const root = {
    BRKTRK_VERSION: "test",
    BRKTRKStores: bundle,
    BRKTRKCommands: { installed: true },
    BRKTRKInputSafety: {
      finalizeAllContinuousGestures: () => ({ ok: true, notificationErrors: [] }),
    },
    stopPlayback() {}, renderAll() {}, focusSelectedCell() {}, setStatus() {},
  };
  const controller = sessionDomain.createController(root, {
    projectStore: bundle.project,
    navigationStore: bundle.navigation,
    commands: root.BRKTRKCommands,
    adapter,
    createInitialProject: () => project("NEW"),
  });
  return { bundle, controller };
}

(async () => {
  {
    const open = deferred();
    const h = harness({ openFile: () => open.promise });
    const pending = h.controller.dispatch({ type: "project.open" });
    assert.equal(h.controller.snapshot().operationInFlight, true);
    assert.equal(h.controller.snapshot().activeOperationCount, 1);
    assert.deepEqual(h.controller.snapshot().activeOperationTypes, ["open"]);
    open.resolve({ ok: false, cancelled: true });
    await pending;
    assert.equal(h.controller.snapshot().operationInFlight, false);
    assert.equal(h.controller.snapshot().activeOperationCount, 0);
  }

  {
    const confirm = deferred();
    const h = harness({ confirmDiscard: () => confirm.promise });
    h.bundle.project.setTempo(121, { source: "dirty-before-new" });
    const pending = h.controller.dispatch({ type: "project.new" });
    assert.equal(h.controller.snapshot().operationInFlight, true);
    assert.deepEqual(h.controller.snapshot().activeOperationTypes, ["new"]);
    confirm.resolve(false);
    await pending;
    assert.equal(h.controller.snapshot().operationInFlight, false);
  }

  {
    const writes = [];
    const h = harness({
      saveAs() {
        const wait = deferred();
        writes.push(wait);
        return wait.promise;
      },
    });
    const first = h.controller.dispatch({ type: "project.saveAs" });
    const second = h.controller.dispatch({ type: "project.saveAs" });
    await Promise.resolve();
    let view = h.controller.snapshot();
    assert.equal(view.operationInFlight, true);
    assert.equal(view.activeOperationCount, 2, "queued Save As dispatches must both remain in-flight");
    assert.deepEqual(view.activeOperationTypes, ["saveAs"]);
    assert.equal(view.saveInFlight, true);
    assert.equal(view.queuedSaveCount, 1);

    writes[0].resolve({ ok: false, cancelled: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 2, "second queued Save As must start after first settles");
    view = h.controller.snapshot();
    assert.equal(view.operationInFlight, true);
    assert.equal(view.activeOperationCount, 1);
    assert.equal(view.saveInFlight, true);

    writes[1].resolve({ ok: false, cancelled: true });
    await Promise.all([first, second]);
    await new Promise((resolve) => setImmediate(resolve));
    view = h.controller.snapshot();
    assert.equal(view.operationInFlight, false);
    assert.equal(view.activeOperationCount, 0);
    assert.equal(view.saveInFlight, false);
    assert.equal(view.queuedSaveCount, 0);
  }

  console.log("Project file operation lifecycle tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
