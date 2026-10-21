(() => {
  const root = globalThis;
  const storage = root.BRKTRKProjectStorage;
  if (!storage) throw new Error("Project storage must load before the runtime model");
  const boot = root.BRKTRKProjectStorageBoot;
  const canonicalInstallBlocked = boot?.canonicalInstallable === false;
  if (typeof model !== "undefined") {
    if (canonicalInstallBlocked) {
      if (typeof makeInitialModel !== "function") throw new Error("Safe initial Project factory is unavailable");
      const safeInitial = makeInitialModel();
      for (const key of Object.keys(model)) delete model[key];
      Object.assign(model, safeInitial);
    } else {
      storage.installRuntimeProject(model);
    }
  }

  const health = {
    state: canonicalInstallBlocked ? "blocked" : "idle",
    pending: false,
    enabled: !canonicalInstallBlocked,
    scheduledCount: 0,
    writeCount: 0,
    failureCount: 0,
    lastReason: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailure: null,
    lastLifecycle: null,
  };
  let saveTimer = 0;
  let lifecycleInstalled = false;
  let diagnosticsRegistered = false;

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const timestamp = () => new Date().toISOString();

  function snapshot() {
    return Object.freeze({
      ...clone(health),
      writer: root.BRKTRKBrowserWriterAuthority?.snapshot?.() ?? null,
      boot: clone(root.BRKTRKProjectStorageBoot ?? null),
      stagingPresent: (() => {
        try { return root.localStorage?.getItem?.(storage.STAGING_KEY) != null; }
        catch { return null; }
      })(),
    });
  }

  function publishHealth() {
    if (root.document?.body) {
      root.document.body.dataset.projectSafetyCopy = health.state;
      root.document.body.dataset.projectSafetyCopyPending = String(health.pending);
      if (health.lastFailure?.code) root.document.body.dataset.projectSafetyCopyError = health.lastFailure.code;
      else delete root.document.body.dataset.projectSafetyCopyError;
    }
    // #372/#369 own the one persistent desktop/phone save-status surface. Feed
    // safety-copy authority into that surface instead of creating another DOM
    // status owner. Ordinary setStatus() messages may change independently.
    root.BRKTRKProjectFileSessionUi?.sync?.();
  }

  function surfaceFailure(reason, error, details = {}) {
    health.state = "failed";
    health.pending = false;
    health.failureCount += 1;
    health.lastReason = reason;
    health.lastAttemptAt = timestamp();
    health.lastFailure = {
      at: health.lastAttemptAt,
      reason,
      code: String(error?.code ?? "BRKTRK_SAFETY_COPY_WRITE_FAILED"),
      message: String(error?.message ?? error),
      ...details,
    };
    publishHealth();
    console.error("BRKTRK browser safety-copy write failed", error);
    root.setStatus?.("SAFETY COPY FAILED · USE SAVE / SAVE AS", "danger");
    return Object.freeze({ ok: false, reason, error: clone(health.lastFailure) });
  }

  function clearTimer() {
    if (saveTimer) root.clearTimeout(saveTimer);
    saveTimer = 0;
    health.pending = false;
  }

  function writeNow(reason = "flush") {
    clearTimer();
    health.lastReason = String(reason);
    health.lastAttemptAt = timestamp();

    if (!health.enabled) {
      health.state = "disabled";
      publishHealth();
      return Object.freeze({ ok: false, skipped: true, reason: "disabled" });
    }

    const authority = root.BRKTRKBrowserWriterAuthority;
    if (authority && !authority.canWrite()) {
      health.state = "writer-blocked";
      // A blocked secondary window is not itself a failure, but it must not
      // erase a failure already observed while this runtime owned writes.
      publishHealth();
      return Object.freeze({ ok: false, skipped: true, reason: "writer-blocked" });
    }

    try {
      const serialized = storage.writeCanonical(root.localStorage, model);
      health.state = "healthy";
      health.writeCount += 1;
      health.lastSuccessAt = timestamp();
      // Only a verified successful canonical write clears persistent failure
      // truth. Scheduling, disabling autosave or becoming writer-blocked does not.
      health.lastFailure = null;
      publishHealth();
      return Object.freeze({ ok: true, reason: String(reason), bytes: String(serialized ?? "").length });
    } catch (error) {
      let stagingPresent = null;
      let canonicalReadable = null;
      try { stagingPresent = root.localStorage?.getItem?.(storage.STAGING_KEY) != null; } catch {}
      try { canonicalReadable = root.localStorage?.getItem?.(storage.STORAGE_KEY) != null; } catch {}
      return surfaceFailure(String(reason), error, { stagingPresent, canonicalReadable });
    }
  }

  function save(reason = "debounced") {
    if (!health.enabled) return false;
    clearTimer();
    health.state = "scheduled";
    health.pending = true;
    health.scheduledCount += 1;
    health.lastReason = String(reason);
    publishHealth();
    saveTimer = root.setTimeout(() => {
      saveTimer = 0;
      health.pending = false;
      writeNow(String(reason));
    }, 180);
    return true;
  }

  function setLocalAutosaveEnabled(value) {
    health.enabled = Boolean(value) && !canonicalInstallBlocked;
    if (!health.enabled) clearTimer();
    health.state = health.enabled ? "idle" : canonicalInstallBlocked ? "blocked" : "disabled";
    publishHealth();
    return health.enabled;
  }

  function finalizeAndFlush(reason) {
    const durability = root.BRKTRKInputSafety?.finalizeAllContinuousGestures?.(reason) ?? null;
    health.lastLifecycle = {
      at: timestamp(),
      reason: String(reason),
      durability: clone(durability),
    };
    const flushed = writeNow(reason);
    if (durability?.ok === false) {
      root.setStatus?.("GESTURE DURABILITY FAILED · SAFETY COPY FINALIZED", "danger");
    }
    return Object.freeze({ durability, flushed });
  }

  function registerDiagnostics() {
    if (diagnosticsRegistered || !root.BRKTRKDiagnostics?.registerSection) return false;
    root.BRKTRKDiagnostics.registerSection("browserSafetyCopy", snapshot);
    diagnosticsRegistered = true;
    return true;
  }

  function installLifecycle() {
    if (lifecycleInstalled) return false;
    lifecycleInstalled = true;
    root.addEventListener?.("pagehide", () => finalizeAndFlush("pagehide"));
    root.document?.addEventListener?.("visibilitychange", () => {
      if (root.document.visibilityState === "hidden") finalizeAndFlush("visibility-hidden");
    });
    registerDiagnostics();
    return true;
  }

  // Replace the bootstrap model's fire-and-forget timer before app-bind captures
  // `persist`. Runtime persistence now catches delayed failures and owns flush.
  root.persist = save;
  root.BRKTRKProjectPersistence = Object.freeze({
    save,
    flush: writeNow,
    finalizeAndFlush,
    setLocalAutosaveEnabled,
    isLocalAutosaveEnabled: () => health.enabled,
    snapshot,
  });
  publishHealth();

  root.addEventListener?.("brktrk-runtime-ready", installLifecycle, { once: true });
  root.setTimeout(() => {
    storage.applyBootNotice(root);
    registerDiagnostics();
    // Boot-time storage failures are also projected by #372/#369. Sync after
    // applyBootNotice so the persistent save-status owner cannot be superseded
    // by later transient status messages.
    root.BRKTRKProjectFileSessionUi?.sync?.();
  }, 0);
})();
