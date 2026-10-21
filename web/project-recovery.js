(() => {
  const storage = globalThis.BRKTRKProjectStorage
    ?? (typeof require === "function" ? require("./project-storage.js") : null);
  if (!storage) throw new Error("A3 recovery requires project storage");

  const JOURNAL_FORMAT = "BRKTRK_RECOVERY_JOURNAL";
  const JOURNAL_VERSION = 1;
  const JOURNAL_KEY = `${storage.STORAGE_KEY}:journal:v1`;
  const INVALID_JOURNAL_PREFIX = `${JOURNAL_KEY}:invalid:`;
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

  function canonicalProject(project) {
    return clone(storage.migrateProject(project, { preferCompatibilityExtension: true }).project);
  }

  function fingerprint(project) {
    return JSON.stringify(canonicalProject(project));
  }

  function normalizeSession(value = {}) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      fileName: typeof source.fileName === "string" && source.fileName.trim() ? source.fileName : null,
      bindingMode: typeof source.bindingMode === "string" ? source.bindingMode : "none",
      unknownEnvelope: source.unknownEnvelope && typeof source.unknownEnvelope === "object" && !Array.isArray(source.unknownEnvelope)
        ? clone(source.unknownEnvelope)
        : {},
      producer: source.producer && typeof source.producer === "object" && !Array.isArray(source.producer)
        ? clone(source.producer)
        : null,
    };
  }

  function createJournal(context, dirtyProject, now = Date.now()) {
    if (!context?.cleanProject) throw new TypeError("Recovery context requires cleanProject");
    const cleanProject = canonicalProject(context.cleanProject);
    const currentProject = canonicalProject(dirtyProject);
    if (JSON.stringify(cleanProject) === JSON.stringify(currentProject)) return null;
    return {
      format: JOURNAL_FORMAT,
      formatVersion: JOURNAL_VERSION,
      updatedAt: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
      cleanProject,
      dirtyProject: currentProject,
      session: normalizeSession(context),
    };
  }

  function normalizeJournal(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Recovery journal must be an object");
    if (input.format !== JOURNAL_FORMAT) throw new TypeError(`Unsupported recovery journal format ${String(input.format)}`);
    if (input.formatVersion !== JOURNAL_VERSION) throw new RangeError(`Unsupported recovery journal version ${String(input.formatVersion)}`);
    const cleanProject = canonicalProject(input.cleanProject);
    const dirtyProject = canonicalProject(input.dirtyProject);
    if (JSON.stringify(cleanProject) === JSON.stringify(dirtyProject)) throw new RangeError("Recovery journal contains no dirty delta");
    const updatedAt = Number(input.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new TypeError("Recovery journal updatedAt must be a positive timestamp");
    return {
      format: JOURNAL_FORMAT,
      formatVersion: JOURNAL_VERSION,
      updatedAt,
      cleanProject,
      dirtyProject,
      session: normalizeSession(input.session),
    };
  }

  function createController(root = globalThis, options = {}) {
    const projectStore = options.projectStore ?? root.BRKTRKStores?.project;
    const fileSession = options.fileSession ?? root.BRKTRKProjectFileSession;
    const local = options.localStorage ?? root.localStorage;
    const now = options.now ?? (() => Date.now());
    if (!projectStore || !fileSession?.installed || !fileSession?.recoveryContext || !fileSession?.adoptRecovery || !fileSession?.discardRecovery) {
      throw new Error("A3 recovery requires ProjectStore and A2 recovery-aware file session");
    }
    if (!local?.getItem || !local?.setItem || !local?.removeItem) throw new Error("A3 recovery requires local storage");

    let activeRecord = null;
    let suppress = false;
    const listeners = new Set();
    const state = {
      status: "idle",
      pending: false,
      journalPresent: false,
      updatedAt: null,
      fileName: null,
      quarantinedKey: null,
      lastError: null,
    };

    function publicSnapshot() {
      return Object.freeze({
        status: state.status,
        pending: state.pending,
        journalPresent: state.journalPresent,
        updatedAt: state.updatedAt,
        fileName: state.fileName,
        quarantinedKey: state.quarantinedKey,
        lastError: state.lastError,
      });
    }

    function renderUi(snapshot = publicSnapshot()) {
      if (!root.document) return;
      const fileStatus = root.document.querySelector("#fileSessionStatus");
      const storageStatus = root.document.querySelector("#storageStatus");
      let status = root.document.querySelector("#recoveryStatus");
      const anchor = fileStatus ?? storageStatus;
      if (!status && anchor) {
        status = root.document.createElement("div");
        status.id = "recoveryStatus";
        status.className = "storage-status recovery-status";
        anchor.insertAdjacentElement("beforebegin", status);
      }
      if (status) {
        if (snapshot.status === "recovered") {
          status.textContent = `RECOVERY · UNSAVED WORK RESTORED${snapshot.fileName ? ` · ${snapshot.fileName}` : ""}`;
        } else if (snapshot.status === "armed") {
          status.textContent = "RECOVERY JOURNAL · ARMED";
        } else if (snapshot.status === "invalid") {
          status.textContent = "RECOVERY JOURNAL INVALID · COPY PRESERVED";
        } else if (snapshot.status === "blocked" || snapshot.status === "error") {
          status.textContent = "RECOVERY JOURNAL ERROR · CHECK DEBUG JSON";
        } else {
          status.textContent = "RECOVERY JOURNAL · CLEAR";
        }
        status.dataset.recoveryStatus = snapshot.status;
      }

      const actions = root.document.querySelector("#settingsDialog .settings-actions");
      let discard = root.document.querySelector("#discardRecoveryButton");
      if (snapshot.pending && actions && !discard) {
        discard = root.document.createElement("button");
        discard.id = "discardRecoveryButton";
        discard.type = "button";
        discard.textContent = "DISCARD RECOVERY";
        discard.addEventListener("click", () => { discardRecovery(); });
        actions.append(discard);
      } else if (!snapshot.pending && discard) {
        discard.remove();
      }
    }

    function notify() {
      const snapshot = publicSnapshot();
      renderUi(snapshot);
      for (const listener of listeners) {
        try { listener(snapshot); } catch (error) { console.error(error); }
      }
    }

    function setError(status, error) {
      state.status = status;
      state.lastError = String(error?.message ?? error);
      notify();
    }

    function removeJournal(status = "idle") {
      try {
        root.BRKTRKBrowserWriterAuthority?.withAuthorizedWrite(() => {});
        local.removeItem(JOURNAL_KEY);
        activeRecord = null;
        state.status = status;
        state.pending = false;
        state.journalPresent = false;
        state.updatedAt = null;
        state.fileName = null;
        state.lastError = null;
        notify();
        return true;
      } catch (error) {
        setError("error", error);
        return false;
      }
    }

    function writeJournal() {
      if (suppress) return null;
      if (root.BRKTRKBrowserWriterAuthority && !root.BRKTRKBrowserWriterAuthority.canWrite()) return null;
      const view = fileSession.snapshot();
      if (!view.dirty) {
        removeJournal("idle");
        return null;
      }
      try {
        const record = createJournal(fileSession.recoveryContext(), projectStore.getState(), now());
        if (!record) {
          removeJournal("idle");
          return null;
        }
        const serialized = JSON.stringify(record);
        local.setItem(JOURNAL_KEY, serialized);
        if (local.getItem(JOURNAL_KEY) !== serialized) throw new Error("Recovery journal verification failed");
        activeRecord = record;
        if (state.status !== "recovered") state.status = "armed";
        state.journalPresent = true;
        state.updatedAt = record.updatedAt;
        state.fileName = record.session.fileName;
        state.lastError = null;
        notify();
        return record;
      } catch (error) {
        setError("error", error);
        return null;
      }
    }

    function quarantineInvalid(raw, error) {
      const key = `${INVALID_JOURNAL_PREFIX}${Number(now())}`;
      try {
        root.BRKTRKBrowserWriterAuthority?.withAuthorizedWrite(() => {});
        local.setItem(key, raw);
        if (local.getItem(key) !== raw) throw new Error("Invalid recovery quarantine verification failed");
        local.removeItem(JOURNAL_KEY);
        activeRecord = null;
        state.status = "invalid";
        state.pending = false;
        state.journalPresent = false;
        state.updatedAt = null;
        state.fileName = null;
        state.quarantinedKey = key;
        state.lastError = String(error?.message ?? error);
        notify();
      } catch (quarantineError) {
        state.status = "blocked";
        state.pending = false;
        state.journalPresent = true;
        state.lastError = `${String(error?.message ?? error)}; quarantine failed: ${String(quarantineError?.message ?? quarantineError)}`;
        notify();
      }
    }

    function bootstrap() {
      if (root.BRKTRKBrowserWriterAuthority && !root.BRKTRKBrowserWriterAuthority.canWrite()) {
        state.status = 'blocked';
        return { ok: false, reason: 'browser-writer-blocked' };
      }
      const raw = local.getItem(JOURNAL_KEY);
      if (raw == null) {
        notify();
        return { ok: true, recovered: false };
      }
      try {
        const record = normalizeJournal(JSON.parse(raw));
        activeRecord = record;
        suppress = true;
        const adopted = fileSession.adoptRecovery(record);
        suppress = false;
        if (!adopted?.ok) throw adopted?.error ?? new Error(adopted?.reason ?? "Recovery adoption failed");
        state.status = "recovered";
        state.pending = true;
        state.journalPresent = true;
        state.updatedAt = record.updatedAt;
        state.fileName = record.session.fileName;
        state.lastError = null;
        root.setStatus?.("RECOVERED UNSAVED PROJECT · SAVE TO KEEP", "amber");
        notify();
        return { ok: true, recovered: true, record };
      } catch (error) {
        suppress = false;
        quarantineInvalid(raw, error);
        return { ok: false, error };
      }
    }

    function discardRecovery() {
      if (!state.pending || !activeRecord) return { ok: false, reason: "no-recovery-pending" };
      try {
        root.BRKTRKBrowserWriterAuthority?.withAuthorizedWrite(() => {});
        suppress = true;
        const result = fileSession.discardRecovery(activeRecord);
        if (!result?.ok) throw result?.error ?? new Error(result?.reason ?? "Recovery discard failed");
        local.removeItem(JOURNAL_KEY);
        suppress = false;
        activeRecord = null;
        state.status = "discarded";
        state.pending = false;
        state.journalPresent = false;
        state.updatedAt = null;
        state.fileName = null;
        state.lastError = null;
        root.setStatus?.("RECOVERY DISCARDED · CLEAN CHECKPOINT RESTORED");
        notify();
        return { ok: true };
      } catch (error) {
        suppress = false;
        setError("error", error);
        return { ok: false, error };
      }
    }

    const boot = bootstrap();
    const unsubscribeProject = projectStore.subscribe("persistence", () => {
      if (!suppress) writeJournal();
    });
    const unsubscribeSession = fileSession.subscribe((view) => {
      if (suppress) return;
      if (!view.dirty && state.journalPresent) removeJournal("idle");
    });

    const api = Object.freeze({
      installed: true,
      snapshot: publicSnapshot,
      writeNow: writeJournal,
      discardRecovery,
      boot: clone(boot),
      subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("Recovery listener must be a function");
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {
        unsubscribeProject?.();
        unsubscribeSession?.();
        listeners.clear();
      },
    });
    root.BRKTRKProjectRecovery = api;
    root.BRKTRKDiagnostics?.registerSection?.("projectRecovery", publicSnapshot);
    notify();
    return api;
  }

  const api = Object.freeze({
    JOURNAL_FORMAT,
    JOURNAL_VERSION,
    JOURNAL_KEY,
    INVALID_JOURNAL_PREFIX,
    canonicalProject,
    fingerprint,
    normalizeSession,
    createJournal,
    normalizeJournal,
    createController,
  });
  globalThis.BRKTRKProjectRecoveryDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalThis.document && globalThis.BRKTRKStores?.project && globalThis.BRKTRKProjectFileSession?.installed) {
    createController(globalThis);
  }
})();
