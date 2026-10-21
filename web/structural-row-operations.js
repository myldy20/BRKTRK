(() => {
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function normalizeRange(startRowValue, countValue, totalRows) {
    const last = Math.max(0, Number(totalRows) - 1);
    const startRow = clamp(Math.round(Number(startRowValue) || 0), 0, last);
    const requestedCount = Math.max(1, Math.round(Number(countValue) || 1));
    const count = Math.min(requestedCount, Number(totalRows) - startRow);
    return Object.freeze({ startRow, count, requestedCount, endRow: startRow + count - 1 });
  }

  function duplicateFixedRowsTransform(rowsValue, startRowValue, countValue) {
    const rows = Array.isArray(rowsValue) ? rowsValue.map(clone) : [];
    if (!rows.length) throw new RangeError("Structural row duplicate requires at least one row");
    const range = normalizeRange(startRowValue, countValue, rows.length);
    const insertionRow = range.endRow + 1;
    const available = Math.max(0, rows.length - insertionRow);
    const insertedCount = Math.min(range.count, available);
    if (!insertedCount) {
      return Object.freeze({
        rows,
        sourceStartRow: range.startRow,
        sourceRowCount: range.count,
        insertionRow,
        rowCount: 0,
        truncatedRows: [],
      });
    }
    const sourceRows = rows.slice(range.startRow, range.startRow + insertedCount).map(clone);
    const after = [
      ...rows.slice(0, insertionRow),
      ...sourceRows,
      ...rows.slice(insertionRow, rows.length - insertedCount),
    ].slice(0, rows.length);
    return Object.freeze({
      rows: after,
      sourceStartRow: range.startRow,
      sourceRowCount: range.count,
      insertionRow,
      rowCount: insertedCount,
      truncatedRows: rows.slice(rows.length - insertedCount).map(clone),
    });
  }

  function createController(root = globalThis, options = {}) {
    if (root.BRKTRKStructuralRowOperations?.installed) return root.BRKTRKStructuralRowOperations;
    const projectStore = options.projectStore ?? root.BRKTRKStores?.project;
    const selectionController = options.selectionController ?? root.BRKTRKSelectionClipboard;
    const commands = options.commands ?? root.BRKTRKCommands;
    const runtimeState = options.state ?? root.state ?? (typeof state !== "undefined" ? state : null);

    if (!projectStore?.structure?.readSongCell || !projectStore.structure?.replaceSongRectangle
        || !projectStore.structure?.readChainCell || !projectStore.structure?.replaceChainRectangle) {
      throw new Error("Structural row operations require ProjectStore structural range ownership");
    }
    if (!selectionController?.dispatch || !selectionController?.getSelection || !commands?.dispatch || !runtimeState) {
      throw new Error("Structural row operations require canonical selection/navigation ownership");
    }

    let lastOperation = null;
    const currentChainId = () => Number(runtimeState.chain);
    const currentFocusRow = () => Math.max(0, Number(runtimeState.focus?.row) || 0);

    function matchingSelection(pane) {
      const selection = selectionController.getSelection();
      if (!selection?.active || selection.pane !== pane) return null;
      if (pane === "chain" && Number(selection.contextId) !== currentChainId()) return null;
      return selection;
    }

    function targetRange(pane, totalRows) {
      const selection = matchingSelection(pane);
      if (selection) return normalizeRange(selection.startRow, selection.rowCount, totalRows);
      if (runtimeState.focus?.pane !== pane) return null;
      return normalizeRange(currentFocusRow(), 1, totalRows);
    }

    function readSongRows() {
      const project = projectStore.getState();
      const rowCount = Math.max(1, Number(project?.song?.length) || 1);
      const colCount = Math.max(1, Number(project?.song?.[0]?.length) || 8);
      return Array.from({ length: rowCount }, (_, row) => (
        Array.from({ length: colCount }, (_, col) => projectStore.structure.readSongCell(row, col))
      ));
    }

    function readChainRows(chainId) {
      const rowCount = Number(projectStore.structure.constants?.CHAIN_ROWS) || 16;
      return Array.from({ length: rowCount }, (_, row) => [
        projectStore.structure.readChainCell(chainId, row, 0).value,
        projectStore.structure.readChainCell(chainId, row, 1).value,
      ]);
    }

    async function reconcileCursor(pane, row, source) {
      return commands.dispatch({
        type: "cursor.select",
        pane,
        row: Math.max(0, Number(row) || 0),
        col: 0,
        focus: true,
        source,
      });
    }

    async function selectResultRows(pane, startRow, rowCount, source) {
      if (!rowCount) return;
      await reconcileCursor(pane, startRow, `${source}-selection-cursor`);
      await selectionController.dispatch({
        type: "selection.begin",
        pane,
        row: startRow,
        col: 0,
        rowMode: true,
        source: `${source}-selection`,
      });
      if (rowCount > 1) {
        await selectionController.dispatch({
          type: "selection.extend",
          row: startRow + rowCount - 1,
          rowMode: true,
          source: `${source}-selection`,
        });
      }
      await reconcileCursor(pane, startRow, `${source}-result-cursor`);
    }

    function noRoom(pane, transformed) {
      const label = pane.toUpperCase();
      root.setStatus?.(`DUPLICATE HAS NO ROOM BELOW LAST ${label} ROW`, "amber");
      lastOperation = {
        type: "duplicate",
        pane,
        sourceStartRow: transformed.sourceStartRow,
        sourceRowCount: transformed.sourceRowCount,
        startRow: transformed.insertionRow,
        rowCount: 0,
        mutated: false,
        reason: "no-room",
        referenceSemantics: "shared",
        at: Date.now(),
      };
      return { ok: false, mutated: false, reason: "no-room", operation: clone(lastOperation) };
    }

    async function duplicate(paneValue, source = "structural-row-duplicate") {
      const pane = String(paneValue ?? runtimeState.focus?.pane ?? "");
      if (pane !== "song" && pane !== "chain") return { ok: false, reason: "structural-pane-only" };

      const chainId = pane === "chain" ? currentChainId() : null;
      const beforeRows = pane === "song" ? readSongRows() : readChainRows(chainId);
      const target = targetRange(pane, beforeRows.length);
      if (!target) return { ok: false, reason: "target-unavailable" };
      const transformed = duplicateFixedRowsTransform(beforeRows, target.startRow, target.count);
      if (!transformed.rowCount) return noRoom(pane, transformed);

      const values = transformed.rows.slice(transformed.insertionRow);
      const transaction = {
        kind: `${pane}-row-duplicate`,
        pane,
        chainId,
        sourceStartRow: target.startRow,
        sourceRowCount: target.count,
        insertionRow: transformed.insertionRow,
        rowCount: transformed.rowCount,
        shift: "down",
        boundary: "truncate-last-row",
        referenceSemantics: "shared",
      };
      const result = pane === "song"
        ? projectStore.structure.replaceSongRectangle(
          transformed.insertionRow,
          0,
          values,
          { source, operation: "row-duplicate", transaction },
        )
        : projectStore.structure.replaceChainRectangle(
          chainId,
          transformed.insertionRow,
          0,
          values,
          { source, operation: "row-duplicate", transaction },
        );

      if (!result.mutated) {
        lastOperation = {
          type: "duplicate",
          pane,
          chainId,
          sourceStartRow: target.startRow,
          sourceRowCount: target.count,
          startRow: transformed.insertionRow,
          rowCount: transformed.rowCount,
          mutated: false,
          reason: "no-change",
          referenceSemantics: "shared",
          at: Date.now(),
        };
        root.setStatus?.(`DUPLICATE · NO ${pane.toUpperCase()} ROW CHANGE`, "amber");
        return { ...result, ok: false, reason: "no-change", operation: clone(lastOperation) };
      }

      await selectResultRows(pane, transformed.insertionRow, transformed.rowCount, source);
      lastOperation = {
        type: "duplicate",
        pane,
        chainId,
        sourceStartRow: target.startRow,
        sourceRowCount: target.count,
        startRow: transformed.insertionRow,
        rowCount: transformed.rowCount,
        truncatedRowCount: transformed.truncatedRows.length,
        mutated: true,
        referenceSemantics: "shared",
        at: Date.now(),
      };
      root.renderAll?.();
      root.setStatus?.(`DUPLICATED ${transformed.rowCount} ${pane.toUpperCase()} ROW${transformed.rowCount === 1 ? "" : "S"}`);
      return { ...result, ok: true, operation: clone(lastOperation) };
    }

    async function dispatch(command = {}) {
      if (command.type !== "structure.rows.duplicate") {
        return { ok: false, reason: "unknown-command", command: command.type ?? null };
      }
      return duplicate(command.pane, command.source ?? "structural-row-duplicate");
    }

    function snapshot() {
      return Object.freeze({
        installed: true,
        panes: Object.freeze(["song", "chain"]),
        duplicateSemantics: "copy-shared-reference-row-after-selection-shift-down-truncate",
        lastOperation: clone(lastOperation),
      });
    }

    const api = Object.freeze({ installed: true, dispatch, duplicate, snapshot });
    root.BRKTRKStructuralRowOperations = api;
    root.BRKTRKDiagnostics?.registerSection?.("structuralRowOperations", snapshot);
    return api;
  }

  const exported = Object.freeze({ normalizeRange, duplicateFixedRowsTransform, createController });
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  globalThis.BRKTRKStructuralRowOperationsDomain = exported;
  if (globalThis.document && globalThis.BRKTRKStores?.project && globalThis.BRKTRKSelectionClipboard) createController(globalThis);
})();
