(() => {
  const DEFAULT_LIMIT = 64;
  const COALESCE_WINDOW_MS = 750;

  function clone(value) {
    if (value == null) return value;
    const cloned = JSON.parse(JSON.stringify(value));
    if (value && typeof value === "object" && Object.hasOwn(value, "instruments") && Array.isArray(value.instruments)) {
      cloned.instruments = JSON.parse(JSON.stringify(value.instruments));
    }
    return cloned;
  }

  function defineOwn(target, key, value, enumerable = true) {
    Object.defineProperty(target, key, {
      value,
      enumerable,
      writable: true,
      configurable: true,
    });
  }

  function valueAtPath(root, path = []) {
    if (!Array.isArray(path) || path.length === 0) return undefined;
    let value = root;
    for (const segment of path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
      value = value[segment];
    }
    return clone(value);
  }

  function hasValueAtPath(root, path = []) {
    if (!Array.isArray(path) || path.length === 0) return false;
    let value = root;
    for (const segment of path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) return false;
      value = value[segment];
    }
    return true;
  }

  function replaceValueAtPath(root, path = [], value, exists = true) {
    if (!root || typeof root !== "object" || !Array.isArray(path) || path.length === 0) {
      throw new TypeError("Targeted history restore requires a non-empty Project path");
    }
    let parent = root;
    for (const segment of path.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, segment)) {
        throw new Error(`Targeted history restore path is unavailable at ${String(segment)}`);
      }
      parent = parent[segment];
    }
    if (!parent || typeof parent !== "object") throw new Error("Targeted history restore parent is unavailable");
    const leaf = path.at(-1);
    if (!exists) {
      if (Object.hasOwn(parent, leaf) && !delete parent[leaf]) throw new Error(`Could not clear Project path ${path.join(".")}`);
      return root;
    }
    const enumerable = Object.hasOwn(parent, leaf)
      ? Object.prototype.propertyIsEnumerable.call(parent, leaf)
      : true;
    defineOwn(parent, leaf, clone(value), enumerable);
    return root;
  }

  const same = (left, right) => JSON.stringify(clone(left)) === JSON.stringify(clone(right));

  function transactionKey(changeSet = {}) {
    const transaction = changeSet.transaction && typeof changeSet.transaction === "object"
      ? { ...changeSet.transaction }
      : null;
    if (transaction) delete transaction.transient;
    return `${changeSet.target ?? changeSet.subtype ?? "project"}|${JSON.stringify(transaction ?? {})}`;
  }

  function isContinuousChange(changeSet = {}) {
    if (changeSet.transaction?.transient === true) return true;
    const source = String(changeSet.source ?? "");
    return Boolean(changeSet.transaction)
      && (source.endsWith("-input") || source.endsWith("-drag") || source.includes("-drag-"));
  }

  function isStableDurableGesture(changeSet = {}) {
    return changeSet?.transaction?.gestureDurable === true
      && changeSet.transaction.gestureStableTarget === true
      && Array.isArray(changeSet.path)
      && changeSet.path.length > 0;
  }

  class ProjectHistoryJournal {
    constructor(options = {}) {
      this.limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);
      this.schemaVersion = Number.isInteger(options.schemaVersion) ? options.schemaVersion : null;
      this.undoStack = [];
      this.redoStack = [];
      this.serial = 0;
      this.lastInvalidation = null;
    }

    invalidate(reason = "manual", schemaVersion = this.schemaVersion) {
      this.undoStack.length = 0;
      this.redoStack.length = 0;
      this.schemaVersion = Number.isInteger(schemaVersion) ? schemaVersion : null;
      this.lastInvalidation = Object.freeze({ reason: String(reason), at: Date.now(), schemaVersion: this.schemaVersion });
    }

    _trim(list) {
      if (list.length > this.limit) list.splice(0, list.length - this.limit);
    }

    record(changeSet, beforeProject, afterProject, now = Date.now()) {
      if (!changeSet || changeSet.persistsProject !== true) return null;
      const targetedGesture = isStableDurableGesture(changeSet);
      if (targetedGesture ? same(changeSet.before, changeSet.after) : same(beforeProject, afterProject)) return null;
      const schemaVersion = Number.isInteger(afterProject?.schemaVersion) ? afterProject.schemaVersion : null;
      if (this.schemaVersion == null) this.schemaVersion = schemaVersion;
      if (schemaVersion !== this.schemaVersion) {
        this.invalidate("schema-changed", schemaVersion);
        return null;
      }

      const transient = isContinuousChange(changeSet);
      const key = transactionKey(changeSet);
      const previous = this.undoStack.at(-1);
      if (!targetedGesture
          && transient
          && previous?.transient === true
          && previous.key === key
          && now - previous.updatedAt <= COALESCE_WINDOW_MS) {
        previous.after = clone(afterProject);
        previous.updatedAt = now;
        previous.changeSet = clone(changeSet);
        this.redoStack.length = 0;
        return previous;
      }

      const entry = {
        id: ++this.serial,
        key,
        transient,
        restoreMode: targetedGesture ? "path" : "project",
        target: changeSet.target ?? null,
        source: changeSet.source ?? null,
        transaction: clone(changeSet.transaction ?? null),
        before: targetedGesture ? null : clone(beforeProject),
        after: targetedGesture ? null : clone(afterProject),
        path: targetedGesture ? clone(changeSet.path) : null,
        beforeValue: targetedGesture ? clone(changeSet.before) : null,
        afterValue: targetedGesture ? clone(changeSet.after) : null,
        beforeExists: targetedGesture ? hasValueAtPath(beforeProject, changeSet.path) : null,
        afterExists: targetedGesture ? hasValueAtPath(afterProject, changeSet.path) : null,
        changeSet: clone(changeSet),
        createdAt: now,
        updatedAt: now,
      };
      this.undoStack.push(entry);
      this._trim(this.undoStack);
      this.redoStack.length = 0;
      return entry;
    }

    _guardSchema(schemaVersion) {
      if (this.schemaVersion == null) this.schemaVersion = schemaVersion;
      if (schemaVersion === this.schemaVersion) return true;
      this.invalidate("schema-changed", schemaVersion);
      return false;
    }

    takeUndo(schemaVersion) {
      if (!this._guardSchema(schemaVersion)) return null;
      const entry = this.undoStack.pop() ?? null;
      if (!entry) return null;
      this.redoStack.push(entry);
      this._trim(this.redoStack);
      return entry;
    }

    takeRedo(schemaVersion) {
      if (!this._guardSchema(schemaVersion)) return null;
      const entry = this.redoStack.pop() ?? null;
      if (!entry) return null;
      this.undoStack.push(entry);
      this._trim(this.undoStack);
      return entry;
    }

    snapshot() {
      return Object.freeze({
        limit: this.limit,
        schemaVersion: this.schemaVersion,
        undoDepth: this.undoStack.length,
        redoDepth: this.redoStack.length,
        lastUndoTarget: this.undoStack.at(-1)?.target ?? null,
        lastRedoTarget: this.redoStack.at(-1)?.target ?? null,
        lastInvalidation: clone(this.lastInvalidation),
      });
    }
  }

  function replaceObjectState(target, snapshot) {
    if (!target || typeof target !== "object" || !snapshot || typeof snapshot !== "object") {
      throw new TypeError("Undo/Redo restore requires object project states");
    }
    const restored = clone(snapshot);
    const runtimeInstruments = Object.hasOwn(restored, "instruments") && Array.isArray(restored.instruments)
      ? clone(restored.instruments)
      : null;
    if (runtimeInstruments) delete restored.instruments;
    for (const key of Object.getOwnPropertyNames(target)) {
      if (!delete target[key]) throw new Error(`Could not clear project field ${key}`);
    }
    for (const [key, value] of Object.entries(restored)) defineOwn(target, key, value, true);
    if (runtimeInstruments) defineOwn(target, "instruments", runtimeInstruments, false);
    return target;
  }

  function createRestoreChangeSet(action, entry, schemaVersion) {
    const original = entry?.changeSet ?? {};
    const originalAffectsPlayback = typeof original.affectsPlayback === "boolean"
      ? original.affectsPlayback
      : true;
    const originalStructuralPlayback = typeof original.structuralPlayback === "boolean"
      ? original.structuralPlayback
      : originalAffectsPlayback;
    const originalPath = Array.isArray(original.path) ? clone(original.path) : [];
    const targetedRestore = entry?.restoreMode === "path" && originalPath.length > 0;
    const restoreSnapshot = action === "undo" ? entry?.before : entry?.after;
    const snapshotValue = targetedRestore ? undefined : valueAtPath(restoreSnapshot, originalPath);
    const restoredValue = targetedRestore
      ? clone(action === "undo" ? entry.beforeValue : entry.afterValue)
      : snapshotValue === undefined
        ? action === "undo" ? clone(original.before) : clone(original.after)
        : snapshotValue;
    return Object.freeze({
      owner: "project",
      kind: "project",
      subtype: `history.${action}`,
      target: `project.history.${action}`,
      path: Object.freeze([]),
      before: null,
      after: null,
      affectsPlayback: originalAffectsPlayback,
      structuralPlayback: originalStructuralPlayback,
      persistsProject: true,
      renderTargets: Object.freeze(["project.all"]),
      source: `m4.2a-${action}`,
      transaction: Object.freeze({
        historyAction: action,
        historyEntryId: entry.id,
        originalTarget: entry.target,
        originalSubtype: original.subtype ?? null,
        originalPath: Object.freeze(originalPath),
        originalAffectsPlayback,
        originalStructuralPlayback,
        restoredValue,
      }),
      schemaVersion,
    });
  }

  function install(root = globalThis, options = {}) {
    if (root.BRKTRKUndoRedo?.installed) return root.BRKTRKUndoRedo;
    const projectStore = options.projectStore ?? root.BRKTRKStores?.project;
    if (!projectStore?.getState || !projectStore?.subscribe || !projectStore?.publish) {
      throw new Error("M4.2A Undo/Redo requires ProjectStore persistence boundaries");
    }

    let baseline = clone(projectStore.getState());
    let replaying = false;
    const journal = new ProjectHistoryJournal({
      limit: options.limit ?? DEFAULT_LIMIT,
      schemaVersion: Number.isInteger(baseline?.schemaVersion) ? baseline.schemaVersion : null,
    });
    const listeners = new Set();

    const currentSchema = () => Number.isInteger(projectStore.getState()?.schemaVersion)
      ? projectStore.getState().schemaVersion
      : null;

    function notify() {
      const value = journal.snapshot();
      listeners.forEach((listener) => {
        try { listener(value); } catch (error) { console.error(error); }
      });
      const undoButton = root.document?.querySelector?.("#undoButton");
      const redoButton = root.document?.querySelector?.("#redoButton");
      if (undoButton) undoButton.disabled = value.undoDepth === 0;
      if (redoButton) redoButton.disabled = value.redoDepth === 0;
    }

    function observePersistence(changeSet, state) {
      const currentState = state ?? projectStore.getState();
      if (replaying) {
        baseline = clone(currentState);
        return;
      }
      if (currentSchema() !== journal.schemaVersion) {
        journal.invalidate("schema-changed", currentSchema());
        baseline = clone(currentState);
        notify();
        return;
      }
      if (isStableDurableGesture(changeSet)) {
        journal.record(changeSet, baseline, currentState);
        replaceValueAtPath(baseline, changeSet.path, changeSet.after, hasValueAtPath(currentState, changeSet.path));
      } else {
        const current = clone(currentState);
        journal.record(changeSet, baseline, current);
        baseline = current;
      }
      notify();
    }

    const unsubscribeStore = projectStore.subscribe("persistence", observePersistence);

    function reset(reason = "project-session-reset") {
      replaying = false;
      journal.invalidate(reason, currentSchema());
      baseline = clone(projectStore.getState());
      notify();
      return journal.snapshot();
    }

    function restore(action, entry, snapshot) {
      if (!entry) {
        root.setStatus?.(action === "undo" ? "NOTHING TO UNDO" : "NOTHING TO REDO", "muted");
        notify();
        return { ok: false, reason: "empty" };
      }
      const schemaVersion = currentSchema();
      if (schemaVersion !== journal.schemaVersion) {
        journal.invalidate("schema-changed", schemaVersion);
        baseline = clone(projectStore.getState());
        root.setStatus?.("EDIT HISTORY CLEARED AFTER PROJECT MIGRATION", "amber");
        notify();
        return { ok: false, reason: "schema-changed" };
      }

      replaying = true;
      try {
        if (entry.restoreMode === "path" && Array.isArray(entry.path) && entry.path.length > 0) {
          const restoredValue = action === "undo" ? entry.beforeValue : entry.afterValue;
          const restoredExists = action === "undo" ? entry.beforeExists : entry.afterExists;
          replaceValueAtPath(projectStore.getState(), entry.path, restoredValue, restoredExists !== false);
        } else {
          replaceObjectState(projectStore.getState(), snapshot);
        }
        const changeSet = createRestoreChangeSet(action, entry, schemaVersion);
        projectStore.publish(changeSet, ["project", "persistence", "audio", "render", "track-mix"]);
        baseline = clone(projectStore.getState());
        root.renderAll?.();
        root.setStatus?.(`${action.toUpperCase()} · ${String(entry.target ?? "PROJECT").toUpperCase()}`);
        return { ok: true, action, entryId: entry.id, target: entry.target, changeSet };
      } finally {
        replaying = false;
        notify();
      }
    }

    function finalizeHistoryBoundary(reason) {
      const boundary = root.BRKTRKInputSafety?.finalizeAllContinuousGestures?.(reason) ?? null;
      if (!boundary) return null;
      if (boundary.ok === false || Number(boundary.notificationErrors?.length ?? 0) > 0) {
        root.setStatus?.("GESTURE DURABILITY FAILED · HISTORY BLOCKED", "danger");
        notify();
        return { ok: false, reason: "gesture-durability-failed", boundary };
      }
      return null;
    }

    function undo() {
      const boundary = finalizeHistoryBoundary("history-undo");
      if (boundary) return boundary;
      const entry = journal.takeUndo(currentSchema());
      return restore("undo", entry, entry?.before);
    }

    function redo() {
      const boundary = finalizeHistoryBoundary("history-redo");
      if (boundary) return boundary;
      const entry = journal.takeRedo(currentSchema());
      return restore("redo", entry, entry?.after);
    }

    function dispatch(command = {}) {
      if (command.type === "history.undo") return undo();
      if (command.type === "history.redo") return redo();
      if (command.type === "history.reset") return { ok: true, snapshot: reset(command.reason ?? command.source ?? "history.reset") };
      return { ok: false, reason: "unknown-command", command: command.type ?? null };
    }

    function keyboardHandler(event) {
      if (event.defaultPrevented || event.altKey) return;
      const target = event.target;
      if (target?.matches?.("input, textarea, select, [contenteditable='true']")) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      const key = String(event.key ?? "").toLowerCase();
      const wantsUndo = key === "z" && !event.shiftKey;
      const wantsRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!wantsUndo && !wantsRedo) return;
      event.preventDefault();
      dispatch({ type: wantsUndo ? "history.undo" : "history.redo", source: "keyboard" });
    }

    function mountControls() {
      if (!root.document || root.document.querySelector("#undoRedoControls")) return;
      const commandBar = root.document.querySelector(".command-bar");
      if (!commandBar) return;
      const controls = root.document.createElement("div");
      controls.id = "undoRedoControls";
      controls.className = "undo-redo-controls";
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", "Edit history");
      controls.innerHTML = `
        <button id="undoButton" class="history-button" type="button" disabled aria-label="Undo last project edit">UNDO</button>
        <button id="redoButton" class="history-button" type="button" disabled aria-label="Redo last undone project edit">REDO</button>
      `;
      commandBar.append(controls);
      controls.querySelector("#undoButton").addEventListener("click", () => dispatch({ type: "history.undo", source: "pointer" }));
      controls.querySelector("#redoButton").addEventListener("click", () => dispatch({ type: "history.redo", source: "pointer" }));
      notify();
    }

    root.document?.addEventListener?.("keydown", keyboardHandler, true);
    mountControls();

    const api = {
      installed: true,
      dispatch,
      undo,
      redo,
      reset,
      snapshot: () => journal.snapshot(),
      subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("Undo/Redo listener must be a function");
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {
        unsubscribeStore?.();
        root.document?.removeEventListener?.("keydown", keyboardHandler, true);
        root.document?.querySelector?.("#undoRedoControls")?.remove?.();
        listeners.clear();
      },
    };
    root.BRKTRKUndoRedo = api;
    root.BRKTRKDiagnostics?.registerSection?.("undoRedo", () => api.snapshot());
    notify();
    return api;
  }

  const api = Object.freeze({
    DEFAULT_LIMIT,
    COALESCE_WINDOW_MS,
    ProjectHistoryJournal,
    replaceObjectState,
    replaceValueAtPath,
    valueAtPath,
    hasValueAtPath,
    isStableDurableGesture,
    createRestoreChangeSet,
    install,
  });

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalThis.document && globalThis.BRKTRKStores?.project) install(globalThis);
})();
