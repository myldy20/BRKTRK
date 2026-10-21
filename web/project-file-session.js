(() => {
  const storage = globalThis.BRKTRKProjectStorage
    ?? (typeof require === "function" ? require("./project-storage.js") : null);
  const files = globalThis.BRKTRKProjectFile
    ?? (typeof require === "function" ? require("./project-file.js") : null);
  const sessionStore = globalThis.BRKTRKProjectFileSessionStore
    ?? (typeof require === "function" ? require("./project-file-session-store.js") : null);
  if (!storage || !files || !sessionStore) throw new Error("A2 file session requires project storage, file codec and store boundary");

  const FILE_EXTENSION = ".brktrk";
  const RESOURCE_OPEN_FAILURE = "PROJECT TOO LARGE/INVALID · CURRENT PROJECT UNCHANGED";
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

  function safeBaseName(value) {
    return String(value ?? "brktrk-project")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "brktrk-project";
  }

  function suggestedFileName(project, currentName = null) {
    const current = String(currentName ?? "").trim();
    if (current) return current.toLowerCase().endsWith(FILE_EXTENSION) ? current : `${current}${FILE_EXTENSION}`;
    return `${safeBaseName(project?.projectName)}${FILE_EXTENSION}`;
  }

  function canonicalProject(project) {
    return clone(storage.migrateProject(project, { preferCompatibilityExtension: true }).project);
  }

  function canonicalFingerprint(project) {
    return JSON.stringify(canonicalProject(project));
  }

  function appVersion(root) {
    return root.document?.querySelector?.('meta[name="brktrk-version"]')?.content
      ?? root.BRKTRK_VERSION
      ?? "0.x";
  }

  function recoveryRetentionConfirmed(snapshot) {
    return Boolean(
      snapshot?.journalPresent === true
      && snapshot.lastError == null
      && (snapshot.status === "armed" || snapshot.status === "recovered"),
    );
  }

  function utf8ByteSize(text) {
    const value = String(text ?? "");
    if (typeof TextEncoder === "function") return new TextEncoder().encode(value).byteLength;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
    return value.length;
  }

  function diagnosticTextFingerprint(text) {
    const value = String(text ?? "");
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return `${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function createFileVersion(text, metadata = {}) {
    const value = String(text ?? "");
    return Object.freeze({
      text: value,
      size: Number.isFinite(metadata?.size) ? Number(metadata.size) : utf8ByteSize(value),
      lastModified: Number.isFinite(metadata?.lastModified) ? Number(metadata.lastModified) : null,
      fingerprint: diagnosticTextFingerprint(value),
    });
  }

  function summarizeFileVersion(version) {
    if (!version) return null;
    return Object.freeze({
      size: version.size,
      lastModified: version.lastModified,
      fingerprint: version.fingerprint,
    });
  }

  function sameFileVersion(left, right) {
    return Boolean(left && right && left.text === right.text);
  }

  async function readHandleVersionDirect(handle) {
    if (!handle || typeof handle.getFile !== "function") return { ok: false, reason: "version-unavailable" };
    try {
      const file = await handle.getFile();
      if (!file || typeof file.text !== "function") return { ok: false, reason: "version-unavailable" };
      files.assertSupportedFileSize?.(file.size);
      const text = await file.text();
      return {
        ok: true,
        text,
        fileName: file.name ?? handle.name ?? null,
        size: Number.isFinite(file.size) ? Number(file.size) : utf8ByteSize(text),
        lastModified: Number.isFinite(file.lastModified) ? Number(file.lastModified) : null,
      };
    } catch (error) {
      return {
        ok: false,
        reason: files.isResourceLimitError?.(error) ? "project-too-large-invalid" : "version-read-failed",
        error,
      };
    }
  }

  function createBrowserFileAdapter(root = globalThis) {
    const directOpen = typeof root.showOpenFilePicker === "function";
    const directSave = typeof root.showSaveFilePicker === "function";
    const capabilities = Object.freeze({ directOpen, directSave, downloadFallback: true, uploadFallback: true });

    async function readFallbackInput() {
      const input = root.document?.querySelector?.("#projectFileInput");
      if (!input) throw new Error("Project file input is unavailable");
      input.value = "";
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          root.removeEventListener?.("focus", onFocus, true);
          input.removeEventListener("change", onChange);
          resolve(value);
        };
        const onChange = async () => {
          const file = input.files?.[0] ?? null;
          if (!file) return finish({ ok: false, cancelled: true });
          try {
            files.assertSupportedFileSize?.(file.size);
            finish({ ok: true, text: await file.text(), fileName: file.name, handle: null, mode: "upload" });
          } catch (error) {
            finish({
              ok: false,
              ...(files.isResourceLimitError?.(error) ? { reason: "project-too-large-invalid" } : {}),
              error,
            });
          }
        };
        const onFocus = () => {
          root.setTimeout?.(() => {
            if (!settled && !input.files?.length) finish({ ok: false, cancelled: true });
          }, 120);
        };
        input.addEventListener("change", onChange);
        root.addEventListener?.("focus", onFocus, true);
        input.click();
      });
    }

    async function openFile() {
      if (!directOpen) return readFallbackInput();
      try {
        const [handle] = await root.showOpenFilePicker({
          multiple: false,
          types: [{
            description: "BRKTRK project",
            accept: { "application/json": [FILE_EXTENSION] },
          }],
        });
        if (!handle) return { ok: false, cancelled: true };
        const version = await readHandleVersionDirect(handle);
        if (!version.ok) {
          return {
            ok: false,
            ...(files.isResourceLimitError?.(version.error) ? { reason: "project-too-large-invalid" } : {}),
            error: version.error ?? new Error(version.reason ?? "Could not read project file"),
          };
        }
        return {
          ok: true,
          text: version.text,
          fileName: version.fileName ?? handle.name ?? null,
          handle,
          mode: "handle",
          fileVersion: version,
        };
      } catch (error) {
        if (error?.name === "AbortError") return { ok: false, cancelled: true };
        return {
          ok: false,
          ...(files.isResourceLimitError?.(error) ? { reason: "project-too-large-invalid" } : {}),
          error,
        };
      }
    }

    async function writeHandle(handle, text) {
      if (!handle?.createWritable) return { ok: false, reason: "handle-unavailable" };
      try {
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return { ok: true, handle, fileName: handle.name ?? null, mode: "handle", durableWriteConfirmed: true };
      } catch (error) {
        return { ok: false, error };
      }
    }

    async function download(text, fileName) {
      try {
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = root.document?.createElement?.("a");
        if (!link) throw new Error("Download link is unavailable");
        link.href = url;
        link.download = fileName;
        link.hidden = true;
        root.document.body?.append?.(link);
        link.click();
        link.remove?.();
        root.setTimeout?.(() => URL.revokeObjectURL(url), 1000);
        return { ok: true, handle: null, fileName, mode: "download", durableWriteConfirmed: false };
      } catch (error) {
        return { ok: false, error };
      }
    }

    async function saveAs(text, fileName) {
      if (!directSave) return download(text, fileName);
      try {
        const handle = await root.showSaveFilePicker({
          suggestedName: fileName,
          types: [{
            description: "BRKTRK project",
            accept: { "application/json": [FILE_EXTENSION] },
          }],
        });
        if (!handle) return { ok: false, cancelled: true };
        return writeHandle(handle, text);
      } catch (error) {
        if (error?.name === "AbortError") return { ok: false, cancelled: true };
        return { ok: false, error };
      }
    }

    return Object.freeze({
      capabilities,
      openFile,
      readHandleVersion: readHandleVersionDirect,
      writeHandle,
      saveAs,
      confirmDiscard: (message) => root.confirm ? root.confirm(message) : true,
    });
  }

  function createController(root = globalThis, options = {}) {
    const projectStore = options.projectStore ?? root.BRKTRKStores?.project;
    const navigationStore = options.navigationStore ?? root.BRKTRKStores?.navigation;
    const commands = options.commands ?? root.BRKTRKCommands;
    const adapter = options.adapter ?? createBrowserFileAdapter(root);
    const createInitialProject = options.createInitialProject ?? (() => {
      if (typeof makeInitialModel === "function") return makeInitialModel();
      throw new Error("Initial BRKTRK project factory is unavailable");
    });
    if (!projectStore || !navigationStore || !commands?.installed) {
      throw new Error("A2 file session requires ProjectStore, NavigationStore and semantic commands");
    }
    sessionStore.install(projectStore, navigationStore);

    const initialProject = canonicalProject(projectStore.getState());
    const state = {
      fileName: null,
      handle: null,
      bindingMode: "none",
      boundFileVersion: null,
      externalConflict: null,
      unknownEnvelope: {},
      producer: null,
      revision: 0,
      cleanRevision: 0,
      cleanProject: initialProject,
      cleanFingerprint: JSON.stringify(initialProject),
      dirty: false,
      lastOperation: Object.freeze({ type: "bootstrap", status: "ready", message: "LOCAL SESSION" }),
    };
    const listeners = new Set();
    let saveSerial = 0;
    let conflictSerial = 0;
    let activeSaveOperationId = null;
    const queuedSaves = [];
    let fileOperationSerial = 0;
    const activeFileOperations = new Map();

    function externalConflictSnapshot(conflict = state.externalConflict) {
      if (!conflict) return null;
      return Object.freeze({
        id: conflict.id,
        kind: conflict.kind,
        fileName: conflict.fileName,
        detectedAtRevision: conflict.detectedAtRevision,
        reason: conflict.reason,
        allowedActions: [...conflict.allowedActions],
        expectedVersion: summarizeFileVersion(conflict.expectedVersion),
        observedVersion: summarizeFileVersion(conflict.observedVersion),
      });
    }

    function publicSnapshot() {
      return Object.freeze({
        fileName: state.fileName,
        hasHandle: Boolean(state.handle),
        bindingMode: state.bindingMode,
        fileVersionKnown: Boolean(state.handle && state.bindingMode === "handle" && state.boundFileVersion),
        fileVersion: summarizeFileVersion(state.boundFileVersion),
        externalConflict: externalConflictSnapshot(),
        dirty: state.dirty,
        revision: state.revision,
        cleanRevision: state.cleanRevision,
        operationInFlight: activeFileOperations.size > 0,
        activeOperationCount: activeFileOperations.size,
        activeOperationTypes: Object.freeze([...new Set(activeFileOperations.values())]),
        saveInFlight: activeSaveOperationId != null,
        activeSaveOperationId,
        queuedSaveCount: queuedSaves.length,
        capabilities: clone(adapter.capabilities ?? {}),
        lastOperation: clone(state.lastOperation),
      });
    }

    function recoveryContext() {
      return Object.freeze({
        fileName: state.fileName,
        bindingMode: state.bindingMode,
        unknownEnvelope: clone(state.unknownEnvelope),
        producer: clone(state.producer),
        cleanProject: clone(state.cleanProject),
      });
    }

    function notify() {
      const value = publicSnapshot();
      renderUi(value);
      for (const listener of listeners) {
        try { listener(value); } catch (error) { console.error(error); }
      }
    }

    function setOperation(type, status, message, detail = null) {
      state.lastOperation = Object.freeze({ type, status, message, detail: detail == null ? null : String(detail) });
      notify();
    }

    function finalizeProjectBoundary(reason, operation = reason) {
      const result = root.BRKTRKInputSafety?.finalizeAllContinuousGestures?.(reason) ?? null;
      if (!result || (result.ok !== false && Number(result.notificationErrors?.length ?? 0) === 0)) return { ok: true, result };
      setOperation(operation, "error", "DURABILITY FAILED · OPERATION BLOCKED", `${result.notificationErrors?.length ?? 0} notification failures`);
      root.setStatus?.("DURABILITY FAILED · OPERATION BLOCKED", "danger");
      return { ok: false, reason: "gesture-durability-failed", boundary: result };
    }

    function refreshDirty() {
      state.dirty = canonicalFingerprint(projectStore.getState()) !== state.cleanFingerprint;
      notify();
      return state.dirty;
    }

    function markClean(project = projectStore.getState(), revision = state.revision, fingerprint = null) {
      const cleanProject = canonicalProject(project);
      state.cleanProject = cleanProject;
      state.cleanFingerprint = fingerprint ?? JSON.stringify(cleanProject);
      state.cleanRevision = revision;
      state.dirty = canonicalFingerprint(projectStore.getState()) !== state.cleanFingerprint;
      notify();
      return state.dirty;
    }

    const unsubscribeProject = projectStore.subscribe("persistence", () => {
      state.revision += 1;
      refreshDirty();
    });

    function producerEnvelope() {
      return {
        ...(state.producer && typeof state.producer === "object" ? clone(state.producer) : {}),
        app: "BRKTRK",
        version: appVersion(root),
      };
    }

    function closeTransientProjectUi(operation) {
      root.BRKTRKSelectionClipboard?.cancelSelection?.(`project-${operation}`);
      root.BRKTRKUndoRedo?.reset?.(`project-${operation}`);
    }

    function applyPreparedProject(runtimeProject, metadata = {}) {
      root.stopPlayback?.();
      const projectMutation = projectStore.fileSession.replaceProject(runtimeProject, {
        source: `project.${metadata.operation ?? "replace"}`,
        operation: metadata.operation,
        fileName: metadata.fileName,
      });
      const navigationMutation = navigationStore.fileSession.resetForProject(projectStore.getState(), {
        source: `project.${metadata.operation ?? "replace"}`,
        operation: metadata.operation,
      });
      closeTransientProjectUi(metadata.operation ?? "replace");
      root.renderAll?.();
      root.focusSelectedCell?.();
      return { projectMutation, navigationMutation };
    }

    async function confirmDiscard(operation) {
      if (!state.dirty) return true;
      const message = operation === "open"
        ? "Discard unsaved BRKTRK changes and open another project?"
        : "Discard unsaved BRKTRK changes and create a new project?";
      return Boolean(await adapter.confirmDiscard?.(message));
    }

    function clearDirectFileBindingVersion() {
      state.boundFileVersion = null;
      state.externalConflict = null;
    }

    function refreshBoundFileVersion(text, metadata = {}) {
      state.boundFileVersion = state.handle && state.bindingMode === "handle"
        ? createFileVersion(text, metadata)
        : null;
      state.externalConflict = null;
    }

    function setExternalConflict(kind, observedVersion, capturedRevision, detail = null) {
      const reason = kind === "modified"
        ? "external-file-conflict"
        : "external-file-verification-unavailable";
      const allowedActions = kind === "modified"
        ? ["overwrite", "saveAs", "open"]
        : ["saveAs", "open"];
      state.externalConflict = {
        id: ++conflictSerial,
        kind,
        fileName: state.fileName,
        detectedAtRevision: capturedRevision,
        reason,
        allowedActions,
        expectedVersion: state.boundFileVersion,
        observedVersion,
      };
      const message = kind === "modified"
        ? "FILE CHANGED OUTSIDE BRKTRK · NOT OVERWRITTEN"
        : "FILE VERSION UNKNOWN · DIRECT SAVE BLOCKED";
      setOperation("save", "conflict", message, detail ?? reason);
      root.setStatus?.(message, kind === "modified" ? "amber" : "danger");
      return externalConflictSnapshot();
    }

    function evaluateDirectFileVersion(result, command, capturedRevision) {
      if (!result?.ok || typeof result.text !== "string") {
        const detail = result?.error?.message ?? result?.reason ?? "version-unavailable";
        const externalConflict = setExternalConflict("unverifiable", null, capturedRevision, detail);
        return { ok: false, conflict: true, reason: "external-file-verification-unavailable", externalConflict };
      }
      const observedVersion = createFileVersion(result.text, result);
      if (sameFileVersion(state.boundFileVersion, observedVersion)) {
        state.externalConflict = null;
        return { ok: true, observedVersion };
      }

      const prior = state.externalConflict;
      const explicitOverwrite = command.conflictResolution === "overwrite"
        && Number.isInteger(command.conflictId)
        && prior?.kind === "modified"
        && prior.id === command.conflictId
        && sameFileVersion(prior.observedVersion, observedVersion);
      if (explicitOverwrite) {
        return { ok: true, observedVersion, conflictResolution: "overwrite", conflictId: prior.id };
      }

      const externalConflict = setExternalConflict("modified", observedVersion, capturedRevision);
      return { ok: false, conflict: true, reason: "external-file-conflict", externalConflict };
    }

    function verifyDirectOverwrite(command, capturedRevision) {
      if (!state.handle || state.bindingMode !== "handle") return { ok: true };
      if (!state.boundFileVersion) {
        const externalConflict = setExternalConflict("unverifiable", null, capturedRevision, "missing-bound-file-version");
        return { ok: false, conflict: true, reason: "external-file-verification-unavailable", externalConflict };
      }
      const reader = typeof adapter.readHandleVersion === "function"
        ? adapter.readHandleVersion.bind(adapter)
        : readHandleVersionDirect;
      let result;
      try {
        result = reader(state.handle);
      } catch (error) {
        return evaluateDirectFileVersion({ ok: false, reason: "version-read-failed", error }, command, capturedRevision);
      }
      if (result && typeof result.then === "function") {
        return Promise.resolve(result)
          .then((resolved) => evaluateDirectFileVersion(resolved, command, capturedRevision))
          .catch((error) => evaluateDirectFileVersion({ ok: false, reason: "version-read-failed", error }, command, capturedRevision));
      }
      return evaluateDirectFileVersion(result, command, capturedRevision);
    }

    async function newProject(command = {}) {
      const boundary = finalizeProjectBoundary("project-new", "new");
      if (!boundary.ok) return boundary;
      if (!command.force && !(await confirmDiscard("new"))) {
        setOperation("new", "cancelled", "NEW CANCELLED");
        return { ok: false, cancelled: true, reason: "dirty-cancelled" };
      }
      try {
        const candidate = createInitialProject();
        storage.installRuntimeProject(candidate);
        const mutations = applyPreparedProject(candidate, { operation: "new", fileName: null });
        state.fileName = null;
        state.handle = null;
        state.bindingMode = "none";
        clearDirectFileBindingVersion();
        state.unknownEnvelope = {};
        state.producer = null;
        markClean();
        setOperation("new", "success", "NEW PROJECT · NOT SAVED");
        root.setStatus?.("NEW PROJECT · NOT SAVED");
        return { ok: true, ...mutations, snapshot: publicSnapshot() };
      } catch (error) {
        console.error(error);
        setOperation("new", "error", "NEW PROJECT FAILED", error?.message ?? error);
        root.setStatus?.("NEW PROJECT FAILED", "danger");
        return { ok: false, error };
      }
    }

    function failOpen(error, operationMessage = "OPEN FAILED · CURRENT PROJECT UNCHANGED") {
      const resourceFailure = files.isResourceLimitError?.(error) === true;
      const reservedFailure = files.isReservedKeyError?.(error) === true;
      const message = resourceFailure ? RESOURCE_OPEN_FAILURE : reservedFailure
        ? `OPEN FAILED · RESERVED KEY ${error.key} AT ${error.boundary.toUpperCase()} · CURRENT PROJECT UNCHANGED`
        : operationMessage;
      setOperation("open", "error", message, error?.message ?? error);
      root.setStatus?.(message, "danger");
      return {
        ok: false,
        ...(resourceFailure ? { reason: "project-too-large-invalid" } : {}),
        error,
      };
    }

    async function openProject(command = {}) {
      const boundary = finalizeProjectBoundary("project-open", "open");
      if (!boundary.ok) return boundary;
      if (!command.force && !(await confirmDiscard("open"))) {
        setOperation("open", "cancelled", "OPEN CANCELLED");
        return { ok: false, cancelled: true, reason: "dirty-cancelled" };
      }
      const picked = command.file
        ? { ok: true, ...command.file }
        : await adapter.openFile();
      if (!picked?.ok) {
        if (picked?.cancelled) {
          setOperation("open", "cancelled", "OPEN CANCELLED");
          return { ok: false, cancelled: true };
        }
        const error = picked?.error ?? new Error("Could not read project file");
        return failOpen(error, picked?.reason === "project-too-large-invalid" ? RESOURCE_OPEN_FAILURE : "OPEN FAILED");
      }
      try {
        const prepared = files.prepareOpen(picked.text);
        const candidate = clone(prepared.project);
        storage.installRuntimeProject(candidate);
        const mutations = applyPreparedProject(candidate, { operation: "open", fileName: picked.fileName ?? null });
        state.fileName = picked.fileName ?? suggestedFileName(candidate);
        state.handle = picked.handle ?? null;
        state.bindingMode = picked.mode ?? (picked.handle ? "handle" : "upload");
        if (state.handle && state.bindingMode === "handle") refreshBoundFileVersion(picked.text, picked.fileVersion ?? {});
        else clearDirectFileBindingVersion();
        state.unknownEnvelope = clone(prepared.unknownEnvelope ?? {});
        state.producer = clone(prepared.producer ?? null);
        markClean();
        setOperation("open", "success", `OPENED · ${state.fileName}`);
        root.setStatus?.(`OPENED · ${state.fileName}`);
        return { ok: true, prepared, ...mutations, snapshot: publicSnapshot() };
      } catch (error) {
        console.error(error);
        return failOpen(error);
      }
    }

    async function performSaveProject(command = {}, saveOperationId = null) {
      const forceSaveAs = command.type === "project.saveAs" || command.saveAs === true;
      const operation = forceSaveAs ? "saveAs" : "save";
      const boundary = finalizeProjectBoundary(forceSaveAs ? "project-save-as" : "project-save", operation);
      if (!boundary.ok) return { ...boundary, saveOperationId };

      const capturedProject = canonicalProject(projectStore.getState());
      const capturedRevision = state.revision;
      const capturedFingerprint = JSON.stringify(capturedProject);
      const capturedUnknownEnvelope = clone(state.unknownEnvelope);
      const capturedProducer = producerEnvelope();
      const name = suggestedFileName(capturedProject, forceSaveAs ? null : state.fileName);
      let text;
      try {
        text = files.serializeProject(capturedProject, {
          unknownEnvelope: capturedUnknownEnvelope,
          producer: capturedProducer,
        });
      } catch (error) {
        const message = files.isReservedKeyError?.(error) === true
          ? `SAVE FAILED · RESERVED KEY ${error.key} AT ${error.boundary.toUpperCase()}` : "SAVE FAILED";
        setOperation(operation, "error", message, error?.message ?? error);
        root.setStatus?.(message, "danger");
        return { ok: false, error, saveOperationId, capturedRevision };
      }

      let directAuthorization = null;
      if (!forceSaveAs && state.handle) {
        directAuthorization = verifyDirectOverwrite(command, capturedRevision);
        if (directAuthorization && typeof directAuthorization.then === "function") {
          directAuthorization = await directAuthorization;
        }
        if (!directAuthorization?.ok) {
          return {
            ...directAuthorization,
            saveOperationId,
            capturedRevision,
            currentRevision: state.revision,
            snapshot: publicSnapshot(),
          };
        }
      }

      let result;
      if (!forceSaveAs && state.handle) result = await adapter.writeHandle(state.handle, text);
      else result = await adapter.saveAs(text, name);
      if (!result?.ok) {
        if (result?.cancelled) {
          setOperation(operation, "cancelled", "SAVE CANCELLED");
          return { ok: false, cancelled: true, saveOperationId, capturedRevision };
        }
        const error = result?.error ?? new Error(result?.reason ?? "Project write failed");
        setOperation(operation, "error", "SAVE FAILED", error?.message ?? error);
        root.setStatus?.("SAVE FAILED · PROJECT REMAINS DIRTY", "danger");
        return { ok: false, error, saveOperationId, capturedRevision };
      }

      const outputFileName = result.fileName || name;
      if (result.durableWriteConfirmed !== true) {
        const recoveryRetained = recoveryRetentionConfirmed(root.BRKTRKProjectRecovery?.snapshot?.());
        setOperation(operation, "success", `DOWNLOAD STARTED · ${outputFileName} · SAVE NOT CONFIRMED`);
        root.setStatus?.(
          `DOWNLOAD STARTED · ${outputFileName} · ${recoveryRetained ? "RECOVERY RETAINED" : "SAVE NOT CONFIRMED"}`,
          "amber",
        );
        return {
          ok: true,
          durableWriteConfirmed: false,
          recoveryRetained,
          fileName: outputFileName,
          mode: result.mode ?? "download",
          text,
          saveOperationId,
          capturedRevision,
          currentRevision: state.revision,
          snapshot: publicSnapshot(),
        };
      }

      state.fileName = outputFileName;
      state.handle = result.handle ?? null;
      state.bindingMode = result.mode ?? "handle";
      state.producer = clone(capturedProducer);
      refreshBoundFileVersion(text, result.fileVersion ?? {});
      const currentChangedSinceWrite = markClean(capturedProject, capturedRevision, capturedFingerprint);
      const recoveryRetained = currentChangedSinceWrite
        ? recoveryRetentionConfirmed(root.BRKTRKProjectRecovery?.snapshot?.())
        : false;
      if (currentChangedSinceWrite) {
        setOperation(operation, "success", `SAVED · ${state.fileName} · NEWER CHANGES UNSAVED`);
        root.setStatus?.(
          `SAVED · ${state.fileName} · NEWER CHANGES UNSAVED${recoveryRetained ? " · RECOVERY RETAINED" : ""}`,
          "amber",
        );
      } else {
        setOperation(operation, "success", `SAVED · ${state.fileName}`);
        root.setStatus?.(`SAVED · ${state.fileName}`);
      }
      return {
        ok: true,
        durableWriteConfirmed: true,
        fileName: state.fileName,
        mode: state.bindingMode,
        text,
        saveOperationId,
        writtenRevision: capturedRevision,
        currentRevision: state.revision,
        currentChangedSinceWrite,
        recoveryRetained,
        conflictResolved: directAuthorization?.conflictResolution === "overwrite",
        fileVersion: summarizeFileVersion(state.boundFileVersion),
        snapshot: publicSnapshot(),
      };
    }

    function startSaveEntry(entry) {
      activeSaveOperationId = entry.id;
      notify();
      let result;
      try {
        result = performSaveProject(entry.command, entry.id);
      } catch (error) {
        result = Promise.reject(error);
      }
      Promise.resolve(result).then(entry.resolve, entry.reject).finally(() => {
        activeSaveOperationId = null;
        const next = queuedSaves.shift();
        if (next) startSaveEntry(next);
        else notify();
      });
    }

    function saveProject(command = {}) {
      const entry = {
        id: ++saveSerial,
        command: { ...command },
        resolve: null,
        reject: null,
      };
      return new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
        if (activeSaveOperationId != null) {
          queuedSaves.push(entry);
          notify();
          return;
        }
        startSaveEntry(entry);
      });
    }

    function normalizeRecoveryRecord(record) {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("Recovery record must be an object");
      const cleanProject = canonicalProject(record.cleanProject);
      const dirtyProject = canonicalProject(record.dirtyProject);
      if (JSON.stringify(cleanProject) === JSON.stringify(dirtyProject)) throw new RangeError("Recovery record contains no dirty delta");
      const session = record.session && typeof record.session === "object" && !Array.isArray(record.session) ? record.session : {};
      return { cleanProject, dirtyProject, session };
    }

    function restoreRecoveryMetadata(session) {
      state.fileName = typeof session.fileName === "string" && session.fileName.trim() ? session.fileName : null;
      state.handle = null;
      state.bindingMode = "recovery";
      clearDirectFileBindingVersion();
      state.unknownEnvelope = session.unknownEnvelope && typeof session.unknownEnvelope === "object" && !Array.isArray(session.unknownEnvelope)
        ? clone(session.unknownEnvelope)
        : {};
      state.producer = session.producer && typeof session.producer === "object" && !Array.isArray(session.producer)
        ? clone(session.producer)
        : null;
    }

    function adoptRecovery(record) {
      const boundary = finalizeProjectBoundary("project-recover", "recover");
      if (!boundary.ok) return boundary;
      try {
        const prepared = normalizeRecoveryRecord(record);
        state.cleanProject = clone(prepared.cleanProject);
        state.cleanFingerprint = JSON.stringify(state.cleanProject);
        state.cleanRevision = state.revision;
        restoreRecoveryMetadata(prepared.session);
        const candidate = clone(prepared.dirtyProject);
        storage.installRuntimeProject(candidate);
        const mutations = applyPreparedProject(candidate, { operation: "recover", fileName: state.fileName });
        state.dirty = canonicalFingerprint(projectStore.getState()) !== state.cleanFingerprint;
        if (!state.dirty) throw new Error("Recovery adoption did not produce a dirty project");
        setOperation("recover", "success", `RECOVERED · ${state.fileName ?? "UNSAVED PROJECT"} · SAVE TO KEEP`);
        return { ok: true, ...mutations, snapshot: publicSnapshot() };
      } catch (error) {
        console.error(error);
        setOperation("recover", "error", "RECOVERY FAILED · CURRENT PROJECT PRESERVED", error?.message ?? error);
        return { ok: false, error };
      }
    }

    function discardRecovery(record) {
      const boundary = finalizeProjectBoundary("project-recovery-discard", "recoveryDiscard");
      if (!boundary.ok) return boundary;
      try {
        const prepared = normalizeRecoveryRecord(record);
        restoreRecoveryMetadata(prepared.session);
        const candidate = clone(prepared.cleanProject);
        storage.installRuntimeProject(candidate);
        const mutations = applyPreparedProject(candidate, { operation: "recovery-discard", fileName: state.fileName });
        markClean();
        setOperation("recoveryDiscard", "success", `RECOVERY DISCARDED · ${state.fileName ?? "CLEAN LOCAL PROJECT"}`);
        return { ok: true, ...mutations, snapshot: publicSnapshot() };
      } catch (error) {
        console.error(error);
        setOperation("recoveryDiscard", "error", "RECOVERY DISCARD FAILED", error?.message ?? error);
        return { ok: false, error };
      }
    }

    function operationType(commandType) {
      switch (commandType) {
        case "project.new": return "new";
        case "project.open": return "open";
        case "project.save": return "save";
        case "project.saveAs": return "saveAs";
        default: return null;
      }
    }

    async function dispatch(command = {}) {
      const type = operationType(command.type);
      if (!type) return { ok: false, reason: "unknown-command", command: command.type ?? null };
      const operationId = ++fileOperationSerial;
      activeFileOperations.set(operationId, type);
      notify();
      try {
        switch (command.type) {
          case "project.new": return await newProject(command);
          case "project.open": return await openProject(command);
          case "project.save": return await saveProject(command);
          case "project.saveAs": return await saveProject({ ...command, saveAs: true });
          default: return { ok: false, reason: "unknown-command", command: command.type ?? null };
        }
      } finally {
        activeFileOperations.delete(operationId);
        notify();
      }
    }

    function renderUi(view = publicSnapshot()) {
      if (!root.document) return;
      const actions = root.document.querySelector("#settingsDialog .settings-actions");
      if (actions && !root.document.querySelector("#newProjectButton")) {
        for (const id of ["saveNowButton", "exportButton", "importButton", "importInput", "resetButton"]) {
          root.document.getElementById(id)?.remove?.();
        }
        const input = root.document.createElement("input");
        input.id = "projectFileInput";
        input.type = "file";
        input.accept = `${FILE_EXTENSION},application/json`;
        input.hidden = true;
        const buttons = [
          ["newProjectButton", "NEW", "project.new"],
          ["openProjectButton", "OPEN", "project.open"],
          ["saveProjectButton", "SAVE", "project.save"],
          ["saveAsProjectButton", "SAVE AS", "project.saveAs"],
        ].map(([id, label, type]) => {
          const button = root.document.createElement("button");
          button.id = id;
          button.type = "button";
          button.textContent = label;
          button.addEventListener("click", () => { void dispatch({ type, source: "settings-project-files" }); });
          return button;
        });
        const overwrite = root.document.createElement("button");
        overwrite.id = "overwriteProjectButton";
        overwrite.type = "button";
        overwrite.textContent = "OVERWRITE";
        overwrite.hidden = true;
        overwrite.addEventListener("click", () => {
          const conflict = publicSnapshot().externalConflict;
          if (!conflict?.allowedActions?.includes("overwrite")) return;
          void dispatch({
            type: "project.save",
            source: "settings-external-file-conflict",
            conflictResolution: "overwrite",
            conflictId: conflict.id,
          });
        });
        actions.prepend(...buttons, overwrite, input);
      }
      const overwrite = root.document.querySelector("#overwriteProjectButton");
      if (overwrite) overwrite.hidden = !view.externalConflict?.allowedActions?.includes("overwrite");
      let status = root.document.querySelector("#fileSessionStatus");
      const storageStatus = root.document.querySelector("#storageStatus");
      if (!status && storageStatus) {
        status = root.document.createElement("div");
        status.id = "fileSessionStatus";
        status.className = "storage-status file-session-status";
        storageStatus.insertAdjacentElement("beforebegin", status);
      }
      if (status) {
        const identity = view.fileName ?? "NOT BOUND TO FILE";
        const dirty = view.dirty ? " · UNSAVED" : " · CLEAN";
        const mode = view.bindingMode === "handle" ? " · DIRECT FILE"
          : view.bindingMode === "download" ? " · DOWNLOAD"
            : view.bindingMode === "recovery" ? " · RECOVERED SESSION"
              : "";
        const conflict = view.externalConflict?.kind === "modified" ? " · EXTERNAL CHANGE"
          : view.externalConflict?.kind === "unverifiable" ? " · DIRECT SAVE BLOCKED"
            : "";
        const resourceFailure = view.lastOperation?.message === RESOURCE_OPEN_FAILURE;
        const reservedFailure = view.lastOperation?.status === "error" && view.lastOperation.message.includes("RESERVED KEY");
        status.textContent = resourceFailure || reservedFailure
          ? `${view.lastOperation.message} · ${identity}${dirty}${mode}${conflict}`
          : `${identity}${dirty}${mode}${conflict}`;
        status.dataset.dirty = String(view.dirty);
        status.dataset.conflict = view.externalConflict?.kind ?? "";
        status.dataset.fileError = resourceFailure ? "resource-limit" : reservedFailure ? "reserved-key" : "";
      }
    }

    function installUi() {
      renderUi();
      const autosave = root.document?.querySelector?.("#autosaveSetting");
      autosave?.addEventListener?.("change", () => {
        if (autosave.checked && root.localStorage) {
          try { storage.writeCanonical(root.localStorage, projectStore.getState()); }
          catch (error) { console.error("Canonical local autosave sync failed", error); }
        }
      });
    }

    const api = {
      installed: true,
      dispatch,
      snapshot: publicSnapshot,
      refreshDirty,
      render: renderUi,
      recoveryContext,
      adoptRecovery,
      discardRecovery,
      subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("File-session listener must be a function");
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {
        unsubscribeProject?.();
        listeners.clear();
      },
    };
    root.BRKTRKProjectFileSession = api;
    if (!Object.hasOwn(commands, "projectFiles")) {
      Object.defineProperty(commands, "projectFiles", {
        value: api,
        configurable: false,
        enumerable: true,
        writable: false,
      });
    }
    installUi();
    root.BRKTRKDiagnostics?.registerSection?.("projectFileSession", publicSnapshot);
    notify();
    return api;
  }

  const exported = Object.freeze({
    FILE_EXTENSION,
    RESOURCE_OPEN_FAILURE,
    safeBaseName,
    suggestedFileName,
    canonicalProject,
    canonicalFingerprint,
    recoveryRetentionConfirmed,
    createFileVersion,
    summarizeFileVersion,
    sameFileVersion,
    readHandleVersionDirect,
    createBrowserFileAdapter,
    createController,
  });
  globalThis.BRKTRKProjectFileSessionDomain = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (globalThis.document && globalThis.BRKTRKStores?.project && globalThis.BRKTRKCommands?.installed) {
    createController(globalThis);
  }
})();
