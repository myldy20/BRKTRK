const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function createHarness(options = {}) {
  const windowEvents = eventTarget();
  const documentEvents = eventTarget();
  const timers = new Map();
  let timerSerial = 0;
  let writeError = options.writeError ?? null;
  let saveUiSyncCount = 0;
  const statuses = [];
  const writes = [];
  let installRuntimeCount = 0;
  const localMap = new Map();
  const body = { dataset: {} };
  const document = {
    ...documentEvents,
    body,
    visibilityState: "visible",
  };
  const localStorage = {
    getItem(key) { return localMap.has(key) ? localMap.get(key) : null; },
    setItem(key, value) { localMap.set(String(key), String(value)); },
    removeItem(key) { localMap.delete(String(key)); },
  };
  const model = options.model ?? { schemaVersion: 5, projectName: "TEST", tempo: 120, song: [], chains: {}, phrases: {}, tracks: [], instrumentPool: {} };
  const storage = {
    STORAGE_KEY: "project",
    STAGING_KEY: "project:staging",
    installRuntimeProject() { installRuntimeCount += 1; },
    applyBootNotice() {},
    writeCanonical(target, project) {
      if (writeError) throw writeError;
      const serialized = JSON.stringify(project);
      target.setItem("project", serialized);
      writes.push(JSON.parse(serialized));
      return serialized;
    },
  };
  const durabilityCalls = [];
  const root = {
    ...windowEvents,
    document,
    localStorage,
    model,
    makeInitialModel() {
      return {
        schemaVersion: 5,
        sourceFormat: "brktrk",
        projectName: "UNTITLED 01",
        tempo: 120,
        song: [],
        chains: {},
        phrases: {},
        tracks: [],
        instrumentPool: {},
      };
    },
    BRKTRKProjectStorage: storage,
    BRKTRKBrowserWriterAuthority: {
      canWrite: () => options.canWrite !== false,
      snapshot: () => ({ role: options.canWrite === false ? "secondary" : "writer" }),
    },
    BRKTRKProjectStorageBoot: options.boot ?? { kind: "ready" },
    BRKTRKProjectFileSessionUi: {
      sync() { saveUiSyncCount += 1; },
    },
    BRKTRKInputSafety: {
      finalizeAllContinuousGestures(reason) {
        durabilityCalls.push(reason);
        if (typeof options.onFinalize === "function") options.onFinalize(model, reason);
        return options.durabilityResult ?? { ok: true, attemptedCount: 1, committedCount: 1, notificationErrors: [] };
      },
    },
    BRKTRKDiagnostics: {
      registerSection(name, provider) {
        root.registeredDiagnostic = { name, provider };
      },
    },
    setStatus(message, tone) { statuses.push({ message, tone }); },
    setTimeout(callback) {
      const id = ++timerSerial;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console,
    Date,
    JSON,
    Object,
  };
  root.globalThis = root;
  root.window = root;
  const context = vm.createContext(root);
  vm.runInContext(fs.readFileSync("web/project-storage-runtime.js", "utf8"), context, { filename: "project-storage-runtime.js" });

  // Drain only the runtime's zero-delay boot-notice callback so later timer
  // assertions observe the safety-copy debounce rather than fixture startup.
  for (const [id, callback] of [...timers.entries()]) {
    timers.delete(id);
    callback();
  }

  return {
    root,
    model,
    writes,
    statuses,
    durabilityCalls,
    get installRuntimeCount() { return installRuntimeCount; },
    timers,
    get saveUiSyncCount() { return saveUiSyncCount; },
    setWriteError(error) { writeError = error; },
    fireTimer() {
      const [id, callback] = [...timers.entries()][0] ?? [];
      if (!callback) return false;
      timers.delete(id);
      callback();
      return true;
    },
  };
}

{
  const conflictingModel = {
    schemaVersion: 5,
    projectName: "CONFLICT",
    tempo: 177,
    song: [],
    chains: {},
    phrases: {},
    tracks: [],
    instrumentPool: {},
    constructor: { unsafe: true },
  };
  const harness = createHarness({
    model: conflictingModel,
    boot: { kind: "blocked", canonicalInstallable: false },
  });

  assert.equal(harness.installRuntimeCount, 0, "blocked conflicting canonical data must not reach runtime migration");
  assert.equal(harness.model.projectName, "UNTITLED 01", "runtime must atomically install the safe initial Project");
  assert.equal(Object.hasOwn(harness.model, "constructor"), false);
  assert.equal(harness.root.BRKTRKProjectPersistence.snapshot().enabled, false);
  assert.equal(harness.root.BRKTRKProjectPersistence.snapshot().state, "blocked");
  assert.equal(harness.root.BRKTRKProjectPersistence.setLocalAutosaveEnabled(true), false, "blocked boot must not overwrite preserved canonical evidence");
  const flush = harness.root.BRKTRKProjectPersistence.flush("blocked-conflict");
  assert.equal(flush.ok, false);
  assert.equal(flush.reason, "disabled");
  assert.equal(harness.writes.length, 0);
}

{
  const error = Object.assign(new Error("quota exploded"), { code: "BRKTRK_CANONICAL_WRITE_FAILED" });
  const harness = createHarness({ writeError: error });
  const syncBeforeFailure = harness.saveUiSyncCount;
  assert.equal(harness.root.BRKTRKProjectPersistence.save("fixture"), true);
  assert.doesNotThrow(() => harness.fireTimer(), "delayed storage exceptions must be caught inside the timer callback");
  const health = harness.root.BRKTRKProjectPersistence.snapshot();
  assert.equal(health.state, "failed");
  assert.equal(health.pending, false);
  assert.equal(health.failureCount, 1);
  assert.equal(health.lastFailure.code, "BRKTRK_CANONICAL_WRITE_FAILED");
  assert.equal(harness.root.document.body.dataset.projectSafetyCopy, "failed");
  assert.match(harness.statuses.at(-1).message, /SAFETY COPY FAILED/);
  assert.ok(harness.saveUiSyncCount > syncBeforeFailure, "storage failure must refresh the authoritative persistent save/status surface");

  harness.root.setStatus("ORDINARY COMMAND STATUS", "amber");
  assert.equal(harness.root.BRKTRKProjectPersistence.snapshot().lastFailure.code, "BRKTRK_CANONICAL_WRITE_FAILED", "ordinary status must not erase storage failure authority");

  assert.equal(harness.root.BRKTRKProjectPersistence.save("retry"), true);
  const retryScheduled = harness.root.BRKTRKProjectPersistence.snapshot();
  assert.equal(retryScheduled.state, "scheduled");
  assert.equal(retryScheduled.lastFailure.code, "BRKTRK_CANONICAL_WRITE_FAILED", "scheduling a retry must not clear failure before durable write succeeds");

  harness.setWriteError(null);
  assert.doesNotThrow(() => harness.fireTimer());
  const recovered = harness.root.BRKTRKProjectPersistence.snapshot();
  assert.equal(recovered.state, "healthy");
  assert.equal(recovered.lastFailure, null, "only a successful canonical safety-copy write clears persistent failure truth");
  assert.equal(recovered.writeCount, 1);
}

{
  const harness = createHarness({
    onFinalize(model) { model.tempo = 177; },
  });
  harness.root.dispatch("brktrk-runtime-ready");
  assert.equal(harness.root.registeredDiagnostic.name, "browserSafetyCopy");
  harness.root.BRKTRKProjectPersistence.save("pending-before-pagehide");
  assert.equal(harness.root.BRKTRKProjectPersistence.snapshot().pending, true);
  harness.root.dispatch("pagehide");
  assert.deepEqual(harness.durabilityCalls, ["pagehide"]);
  assert.equal(harness.writes.at(-1).tempo, 177, "pagehide flush must observe the value installed by gesture finalization");
  assert.equal(harness.root.BRKTRKProjectPersistence.snapshot().pending, false);
  assert.equal(harness.timers.size, 0, "pagehide flush must cancel the delayed write");
}

{
  const harness = createHarness({ canWrite: false });
  harness.root.dispatch("brktrk-runtime-ready");
  const result = harness.root.BRKTRKProjectPersistence.flush("secondary-window");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "writer-blocked");
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.root.BRKTRKProjectPersistence.snapshot().state, "writer-blocked");
  assert.equal(harness.root.BRKTRKProjectPersistence.snapshot().lastFailure, null, "a fresh blocked secondary must not invent a storage failure");
}

{
  const harness = createHarness({ onFinalize(model) { model.tempo = 188; } });
  harness.root.dispatch("brktrk-runtime-ready");
  harness.root.document.visibilityState = "hidden";
  harness.root.document.dispatch("visibilitychange");
  assert.deepEqual(harness.durabilityCalls, ["visibility-hidden"]);
  assert.equal(harness.writes.at(-1).tempo, 188);
  assert.equal(harness.root.BRKTRKProjectPersistence.snapshot().lastLifecycle.reason, "visibility-hidden");
}

console.log("Project safety-copy runtime delayed-failure + lifecycle finalization tests passed");
