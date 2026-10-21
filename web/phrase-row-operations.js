(() => {
  const PHRASE_ROWS = 16;
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function normalizeRange(startRowValue, countValue) {
    const startRow = clamp(Math.round(Number(startRowValue) || 0), 0, PHRASE_ROWS - 1);
    const requestedCount = Math.max(1, Math.round(Number(countValue) || 1));
    const count = Math.min(requestedCount, PHRASE_ROWS - startRow);
    return Object.freeze({ startRow, count, requestedCount, endRow: startRow + count - 1 });
  }

  function insertRowsTransform(rowsValue, startRowValue, countValue, emptyRowFactory) {
    const rows = Array.isArray(rowsValue) ? rowsValue.map(clone) : [];
    if (rows.length !== PHRASE_ROWS) throw new RangeError(`Phrase row transform requires exactly ${PHRASE_ROWS} rows`);
    const range = normalizeRange(startRowValue, countValue);
    const inserted = Array.from({ length: range.count }, () => clone(emptyRowFactory()));
    const after = [...rows.slice(0, range.startRow), ...inserted, ...rows.slice(range.startRow, PHRASE_ROWS - range.count)].slice(0, PHRASE_ROWS);
    return Object.freeze({ rows: after, startRow: range.startRow, rowCount: range.count, truncatedRows: rows.slice(PHRASE_ROWS - range.count).map(clone) });
  }

  function deleteRowsTransform(rowsValue, startRowValue, countValue, emptyRowFactory) {
    const rows = Array.isArray(rowsValue) ? rowsValue.map(clone) : [];
    if (rows.length !== PHRASE_ROWS) throw new RangeError(`Phrase row transform requires exactly ${PHRASE_ROWS} rows`);
    const range = normalizeRange(startRowValue, countValue);
    const removedRows = rows.slice(range.startRow, range.startRow + range.count).map(clone);
    const fill = Array.from({ length: range.count }, () => clone(emptyRowFactory()));
    const after = [...rows.slice(0, range.startRow), ...rows.slice(range.startRow + range.count), ...fill].slice(0, PHRASE_ROWS);
    return Object.freeze({ rows: after, startRow: range.startRow, rowCount: range.count, removedRows });
  }

  function duplicateRowsTransform(rowsValue, startRowValue, countValue) {
    const rows = Array.isArray(rowsValue) ? rowsValue.map(clone) : [];
    if (rows.length !== PHRASE_ROWS) throw new RangeError(`Phrase row transform requires exactly ${PHRASE_ROWS} rows`);
    const range = normalizeRange(startRowValue, countValue);
    const insertionRow = range.endRow + 1;
    const available = Math.max(0, PHRASE_ROWS - insertionRow);
    const insertedCount = Math.min(range.count, available);
    if (!insertedCount) return Object.freeze({ rows, sourceStartRow: range.startRow, sourceRowCount: range.count, insertionRow, rowCount: 0, truncatedRows: [] });
    const sourceRows = rows.slice(range.startRow, range.startRow + insertedCount).map(clone);
    const after = [...rows.slice(0, insertionRow), ...sourceRows, ...rows.slice(insertionRow, PHRASE_ROWS - insertedCount)].slice(0, PHRASE_ROWS);
    return Object.freeze({ rows: after, sourceStartRow: range.startRow, sourceRowCount: range.count, insertionRow, rowCount: insertedCount, truncatedRows: rows.slice(PHRASE_ROWS - insertedCount).map(clone) });
  }

  function createController(root = globalThis, options = {}) {
    if (root.BRKTRKPhraseRowOperations?.installed) return root.BRKTRKPhraseRowOperations;
    const projectStore = options.projectStore ?? root.BRKTRKStores?.project;
    const navigationStore = options.navigationStore ?? root.BRKTRKStores?.navigation;
    const selectionController = options.selectionController ?? root.BRKTRKSelectionClipboard;
    const commands = options.commands ?? root.BRKTRKCommands;
    const runtimeState = options.state ?? root.state ?? (typeof state !== "undefined" ? state : null);
    const diagnostics = options.diagnostics ?? root.BRKTRKDiagnostics;
    if (!projectStore?.phraseSteps?.read || !projectStore.phraseSteps?.replaceRows || !projectStore.phraseSteps?.emptyStep) throw new Error("M4.2B2 Phrase row operations require ProjectStore Phrase row ownership");
    if (!selectionController?.dispatch || !selectionController?.getSelection || !commands?.dispatch || !runtimeState) throw new Error("M4.2B2 Phrase row operations require canonical selection/navigation ownership");

    let lastOperation = null;
    const currentPhraseId = () => Number(runtimeState.phrase);
    const currentPhraseRow = () => clamp(Number(runtimeState.focus?.row ?? runtimeState.phraseRow) || 0, 0, PHRASE_ROWS - 1);
    const readPhraseRows = (phraseId) => Array.from({ length: PHRASE_ROWS }, (_, row) => projectStore.phraseSteps.read(phraseId, row));
    const emptyRow = () => projectStore.phraseSteps.emptyStep();
    const phraseWorkspaceActive = () => runtimeState.p3?.activeWorkspace === "phrase";

    function matchingPhraseSelection() {
      const selection = selectionController.getSelection();
      return selection?.active
        && selection.pane === "phrase"
        && Number(selection.contextId) === currentPhraseId()
        ? selection
        : null;
    }

    function targetRange() {
      if (!phraseWorkspaceActive()) return null;
      const selection = matchingPhraseSelection();
      if (selection) return normalizeRange(selection.startRow, selection.rowCount);
      if (runtimeState.focus?.pane !== "phrase") return null;
      return normalizeRange(currentPhraseRow(), 1);
    }

    function keyboardTargetAvailable() {
      return phraseWorkspaceActive()
        && (runtimeState.focus?.pane === "phrase" || Boolean(matchingPhraseSelection()));
    }

    function activeSheet() {
      return navigationStore?.entryState?.getActiveSheet?.()
        ?? runtimeState.p3?.activeSheet
        ?? null;
    }

    async function reconcilePhraseCursor(row, col, source) {
      return commands.dispatch({
        type: "cursor.select",
        pane: "phrase",
        row: clamp(Number(row) || 0, 0, PHRASE_ROWS - 1),
        col: Math.max(0, Number(col) || 0),
        focus: true,
        source,
      });
    }

    async function selectRows(startRow, rowCount, source) {
      if (!rowCount) return;
      // A matching Phrase selection may intentionally outrank temporarily stale
      // Song/Chain focus. Re-enter Phrase before asking the selection owner to
      // construct the result rectangle, because that owner requires currentPane.
      await reconcilePhraseCursor(startRow, 0, `${source}-selection-cursor`);
      await selectionController.dispatch({ type: "selection.begin", pane: "phrase", row: startRow, col: 0, rowMode: true, source: `${source}-selection` });
      if (rowCount > 1) await selectionController.dispatch({ type: "selection.extend", row: startRow + rowCount - 1, rowMode: true, source: `${source}-selection` });
      // selection.extend owns the rectangle focus edge and moves the canonical
      // cursor there. Reconcile once more after the rectangle is complete so the
      // current Phrase row / Instrument context is bound to the first result row.
      // focus:true avoids the legacy no-op NOTE gesture that opens Note editing.
      await reconcilePhraseCursor(startRow, 0, `${source}-result-cursor`);
    }

    function noChange(type, phraseId, metadata = {}) {
      lastOperation = { type, phraseId, ...metadata, mutated: false, at: Date.now() };
      root.setStatus?.(`${type.toUpperCase()} · NO ROW CHANGE`, "amber");
      return { ok: false, mutated: false, reason: "no-change", operation: clone(lastOperation) };
    }

    async function insert(source = "phrase-row-insert") {
      const target = targetRange();
      if (!target) return { ok: false, reason: "phrase-workspace-only" };
      const phraseId = currentPhraseId();
      const transformed = insertRowsTransform(readPhraseRows(phraseId), target.startRow, target.count, emptyRow);
      const result = projectStore.phraseSteps.replaceRows(phraseId, target.startRow, transformed.rows.slice(target.startRow), { source, transaction: { kind: "phrase-row-insert", phraseId, startRow: target.startRow, rowCount: target.count, shift: "down", boundary: "truncate-0F" } });
      if (!result.mutated) return { ...result, ...noChange("insert", phraseId, { startRow: target.startRow, rowCount: target.count, shift: "down", truncatedRowCount: transformed.truncatedRows.length }) };
      await selectRows(target.startRow, target.count, source);
      lastOperation = { type: "insert", phraseId, startRow: target.startRow, rowCount: target.count, shift: "down", truncatedRowCount: transformed.truncatedRows.length, mutated: true, at: Date.now() };
      root.renderAll?.();
      root.setStatus?.(`INSERTED ${target.count} PHRASE ROW${target.count === 1 ? "" : "S"} · SHIFT DOWN`);
      return { ...result, ok: true, operation: clone(lastOperation) };
    }

    async function remove(source = "phrase-row-delete") {
      const target = targetRange();
      if (!target) return { ok: false, reason: "phrase-workspace-only" };
      const phraseId = currentPhraseId();
      const transformed = deleteRowsTransform(readPhraseRows(phraseId), target.startRow, target.count, emptyRow);
      const result = projectStore.phraseSteps.replaceRows(phraseId, target.startRow, transformed.rows.slice(target.startRow), { source, transaction: { kind: "phrase-row-delete", phraseId, startRow: target.startRow, rowCount: target.count, shift: "up", boundary: "empty-fill-0F" } });
      if (!result.mutated) return { ...result, ...noChange("delete", phraseId, { startRow: target.startRow, rowCount: target.count, shift: "up", emptyFillRowCount: target.count }) };
      await selectRows(target.startRow, target.count, source);
      lastOperation = { type: "delete", phraseId, startRow: target.startRow, rowCount: target.count, shift: "up", emptyFillRowCount: target.count, mutated: true, at: Date.now() };
      root.renderAll?.();
      root.setStatus?.(`DELETED ${target.count} PHRASE ROW${target.count === 1 ? "" : "S"} · SHIFT UP`);
      return { ...result, ok: true, operation: clone(lastOperation) };
    }

    async function duplicate(source = "phrase-row-duplicate") {
      const target = targetRange();
      if (!target) return { ok: false, reason: "phrase-workspace-only" };
      const phraseId = currentPhraseId();
      const transformed = duplicateRowsTransform(readPhraseRows(phraseId), target.startRow, target.count);
      if (!transformed.rowCount) {
        root.setStatus?.("DUPLICATE HAS NO ROOM BELOW ROW 0F", "amber");
        lastOperation = { type: "duplicate", phraseId, sourceStartRow: target.startRow, sourceRowCount: target.count, startRow: transformed.insertionRow, rowCount: 0, mutated: false, reason: "no-room", at: Date.now() };
        return { ok: false, mutated: false, reason: "no-room", insertionRow: transformed.insertionRow, operation: clone(lastOperation) };
      }
      const result = projectStore.phraseSteps.replaceRows(phraseId, transformed.insertionRow, transformed.rows.slice(transformed.insertionRow), { source, transaction: { kind: "phrase-row-duplicate", phraseId, sourceStartRow: target.startRow, sourceRowCount: target.count, insertionRow: transformed.insertionRow, rowCount: transformed.rowCount, shift: "down", boundary: "truncate-0F" } });
      if (!result.mutated) return { ...result, ...noChange("duplicate", phraseId, { sourceStartRow: target.startRow, sourceRowCount: target.count, startRow: transformed.insertionRow, rowCount: transformed.rowCount, shift: "down", truncatedRowCount: transformed.truncatedRows.length }) };
      await selectRows(transformed.insertionRow, transformed.rowCount, source);
      lastOperation = { type: "duplicate", phraseId, sourceStartRow: target.startRow, sourceRowCount: target.count, startRow: transformed.insertionRow, rowCount: transformed.rowCount, shift: "down", truncatedRowCount: transformed.truncatedRows.length, mutated: true, at: Date.now() };
      root.renderAll?.();
      root.setStatus?.(`DUPLICATED ${transformed.rowCount} PHRASE ROW${transformed.rowCount === 1 ? "" : "S"}`);
      return { ...result, ok: true, operation: clone(lastOperation) };
    }

    async function dispatch(command = {}) {
      switch (command.type) {
        case "phrase.rows.insert": return insert(command.source ?? "phrase-row-insert");
        case "phrase.rows.delete": return remove(command.source ?? "phrase-row-delete");
        case "phrase.rows.duplicate": return duplicate(command.source ?? "phrase-row-duplicate");
        default: return { ok: false, reason: "unknown-command", command: command.type ?? null };
      }
    }

    function snapshot() {
      return Object.freeze({
        installed: true,
        phraseOnly: true,
        rowCount: PHRASE_ROWS,
        workspaceRequired: "phrase",
        semantics: Object.freeze({
          insert: "blank-at-start-shift-down-truncate-0F",
          delete: "remove-shift-up-empty-fill-0F",
          duplicate: "copy-after-selection-shift-down-truncate-0F",
        }),
        lastOperation: clone(lastOperation),
      });
    }

    function refreshActions() {
      const bar = root.document?.querySelector?.("#m42bSelectionActions");
      if (!bar) return;
      const available = phraseWorkspaceActive()
        && activeSheet() == null
        && bar.dataset.pane === "phrase"
        && !bar.hidden;
      for (const id of ["m42bInsertRows", "m42bDeleteRows", "m42bDuplicateRows"]) {
        const button = bar.querySelector(`#${id}`);
        if (button) {
          button.hidden = !available;
          button.disabled = !available;
        }
      }
      bar.dataset.phraseRowActions = available ? "true" : "false";
    }

    function injectActions() {
      const bar = root.document?.querySelector?.("#m42bSelectionActions");
      if (!bar || bar.querySelector("#m42bInsertRows")) return;
      const done = bar.querySelector("#m42bDone");
      const definitions = [
        ["m42bInsertRows", "INS", "phrase.rows.insert", "Insert Phrase row or selected rows"],
        ["m42bDeleteRows", "DEL", "phrase.rows.delete", "Delete Phrase row or selected rows"],
        ["m42bDuplicateRows", "DUP", "phrase.rows.duplicate", "Duplicate Phrase row or selected rows"],
      ];
      for (const [id, label, type, accessibleName] of definitions) {
        const button = root.document.createElement("button");
        button.id = id;
        button.type = "button";
        button.textContent = label;
        button.title = accessibleName;
        button.setAttribute("aria-label", accessibleName);
        button.hidden = true;
        button.disabled = true;
        button.addEventListener("click", () => {
          if (!phraseWorkspaceActive() || activeSheet() != null) {
            refreshActions();
            return;
          }
          void dispatch({ type, source: "touch-selection-row-op" });
        });
        bar.insertBefore(button, done);
      }
      refreshActions();
    }

    function keydown(event) {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      if (!keyboardTargetAvailable()) return;
      if (activeSheet() != null) return;
      if (event.target?.matches?.("input, textarea, select, [contenteditable='true']")) return;
      if (root.document?.querySelector?.("#helpDialog")?.open || root.document?.querySelector?.("#settingsDialog")?.open) return;
      const modifier = event.metaKey || event.ctrlKey;
      let type = null;
      if (!modifier && event.code === "Insert") type = "phrase.rows.insert";
      else if (modifier && event.code === "Enter") type = "phrase.rows.insert";
      else if (modifier && (event.code === "Backspace" || event.code === "Delete")) type = "phrase.rows.delete";
      else if (modifier && String(event.key ?? "").toLowerCase() === "d") type = "phrase.rows.duplicate";
      if (!type) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void dispatch({ type, source: "keyboard-row-op" });
    }

    function historyContextChanged(changeSet) {
      if (!phraseWorkspaceActive() || runtimeState.focus?.pane !== "phrase") return;
      if (!changeSet || !["history.undo", "history.redo"].includes(changeSet.subtype)) return;
      if (changeSet.transaction?.originalTarget !== "phrase.rows") return;
      const row = currentPhraseRow();
      const col = Math.max(0, Number(runtimeState.focus?.col) || 0);
      Promise.resolve(reconcilePhraseCursor(row, col, `phrase-row-${changeSet.subtype}-context`)).catch((error) => {
        console.error(error);
        root.setStatus?.("PHRASE HISTORY CONTEXT RECONCILE FAILED", "danger");
      });
    }

    injectActions();
    root.document?.addEventListener?.("keydown", keydown, true);
    const scheduleRefresh = () => root.setTimeout?.(refreshActions, 0);
    const unsubscribeSelection = navigationStore?.subscribe?.("selection", scheduleRefresh) ?? (() => {});
    const unsubscribeNavigation = navigationStore?.subscribe?.("navigation", scheduleRefresh) ?? (() => {});
    const unsubscribeHistoryContext = projectStore?.subscribe?.("project", historyContextChanged) ?? (() => {});
    root.addEventListener?.("resize", refreshActions);
    root.setTimeout?.(refreshActions, 0);
    const api = Object.freeze({
      installed: true,
      dispatch,
      snapshot,
      refreshActions,
      dispose() {
        unsubscribeSelection?.();
        unsubscribeNavigation?.();
        unsubscribeHistoryContext?.();
        root.document?.removeEventListener?.("keydown", keydown, true);
        root.removeEventListener?.("resize", refreshActions);
        for (const id of ["m42bInsertRows", "m42bDeleteRows", "m42bDuplicateRows"]) root.document?.querySelector?.(`#${id}`)?.remove?.();
      },
    });
    root.BRKTRKPhraseRowOperations = api;
    diagnostics?.registerSection?.("phraseRowOperations", snapshot);
    return api;
  }

  const exported = Object.freeze({ PHRASE_ROWS, normalizeRange, insertRowsTransform, deleteRowsTransform, duplicateRowsTransform, createController });
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  globalThis.BRKTRKPhraseRowOperationsDomain = exported;
  if (globalThis.document && globalThis.BRKTRKSelectionClipboard && globalThis.BRKTRKStores?.project) createController(globalThis);
})();