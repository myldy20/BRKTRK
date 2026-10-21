(() => {
  const LONG_PRESS_MS = 480;
  const LONG_PRESS_CLICK_SUPPRESS_MS = 900;
  const DEFAULT_SHAPES = Object.freeze({
    song: Object.freeze({ rows: 64, cols: 8 }),
    chain: Object.freeze({ rows: 16, cols: 2 }),
    phrase: Object.freeze({ rows: 16, cols: 9 }),
  });
  const FIELD_IDS = Object.freeze({
    song: Object.freeze(Array(8).fill("chainRef")),
    chain: Object.freeze(["phraseRef", "transpose"]),
    phrase: Object.freeze([
      "note", "velocity", "instrument",
      "fx1.command", "fx1.value",
      "fx2.command", "fx2.value",
      "fx3.command", "fx3.value",
    ]),
  });
  const FIELD_TYPES = Object.freeze({
    song: Object.freeze(Array(8).fill("chain-ref")),
    chain: Object.freeze(["phrase-ref", "transpose"]),
    phrase: Object.freeze([
      "note", "velocity", "instrument",
      "fx-command", "fx-value",
      "fx-command", "fx-value",
      "fx-command", "fx-value",
    ]),
  });
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function normalizeRange(anchorRow, focusRow, maxRows = 16) {
    const last = Math.max(0, Number(maxRows) - 1);
    const anchor = clamp(Math.round(Number(anchorRow) || 0), 0, last);
    const focus = clamp(Math.round(Number(focusRow) || 0), 0, last);
    return Object.freeze({
      anchorRow: anchor,
      focusRow: focus,
      startRow: Math.min(anchor, focus),
      endRow: Math.max(anchor, focus),
      rowCount: Math.abs(focus - anchor) + 1,
    });
  }

  function normalizeRectangle(anchorRow, anchorCol, focusRow, focusCol, maxRows = 16, maxCols = 1) {
    const rows = normalizeRange(anchorRow, focusRow, maxRows);
    const lastCol = Math.max(0, Number(maxCols) - 1);
    const aCol = clamp(Math.round(Number(anchorCol) || 0), 0, lastCol);
    const fCol = clamp(Math.round(Number(focusCol) || 0), 0, lastCol);
    return Object.freeze({
      ...rows,
      anchorCol: aCol,
      focusCol: fCol,
      startCol: Math.min(aCol, fCol),
      endCol: Math.max(aCol, fCol),
      colCount: Math.abs(fCol - aCol) + 1,
    });
  }

  function clipRows(rows, startRow, maxRows = 16) {
    const source = Array.isArray(rows) ? rows : [];
    const start = clamp(Math.round(Number(startRow) || 0), 0, Math.max(0, Number(maxRows) - 1));
    const rowCount = Math.max(0, Math.min(source.length, Number(maxRows) - start));
    return Object.freeze({
      startRow: start,
      rowCount,
      clipped: rowCount !== source.length,
      rows: source.slice(0, rowCount).map(clone),
    });
  }

  function clipRectangle(cells, startRow, startCol, maxRows, maxCols) {
    const source = Array.isArray(cells) ? cells : [];
    const sourceCols = Array.isArray(source[0]) ? source[0].length : 0;
    const row = clamp(Math.round(Number(startRow) || 0), 0, Math.max(0, Number(maxRows) - 1));
    const col = clamp(Math.round(Number(startCol) || 0), 0, Math.max(0, Number(maxCols) - 1));
    const rowCount = Math.max(0, Math.min(source.length, Number(maxRows) - row));
    const colCount = Math.max(0, Math.min(sourceCols, Number(maxCols) - col));
    return Object.freeze({
      startRow: row,
      startCol: col,
      rowCount,
      colCount,
      clipped: rowCount !== source.length || colCount !== sourceCols,
      cells: Array.from({ length: rowCount }, (_, r) => (
        Array.from({ length: colCount }, (_, c) => clone(source[r][c]))
      )),
    });
  }

  function createController(root = globalThis, options = {}) {
    const projectStore = options.projectStore ?? root.BRKTRKStores?.project;
    const navigationStore = options.navigationStore ?? root.BRKTRKStores?.navigation;
    const storeTypes = options.storeTypes ?? root.BRKTRKStoreTypes;
    const commands = options.commands ?? root.BRKTRKCommands;
    const diagnostics = options.diagnostics ?? root.BRKTRKDiagnostics;
    const runtimeState = options.state ?? root.state ?? (typeof state !== "undefined" ? state : null);

    if (!projectStore?.phraseSteps?.read || !projectStore.phraseSteps?.replaceRows) {
      throw new Error("M4.2B selection/clipboard requires ProjectStore atomic Phrase row ownership");
    }
    if (!projectStore?.structure?.readSongCell || !projectStore.structure?.replaceSongRectangle
        || !projectStore.structure?.readChainCell || !projectStore.structure?.replaceChainRectangle) {
      throw new Error("M4.2B structural selection requires ProjectStore atomic structural range ownership");
    }
    if (!navigationStore?.emit || !storeTypes?.createNavigationChangeSet || !commands?.dispatch || !runtimeState) {
      throw new Error("M4.2B selection/clipboard requires NavigationStore and semantic command layer");
    }

    runtimeState.p3 ??= {};
    let selection = null;
    let clipboardPayload = null;
    let pasteTargetArmed = false;
    let pasteTargetMovePending = false;
    let lastOperation = null;
    let longPressTimer = 0;
    let longPressPointerId = null;
    let suppressClickKey = null;
    let suppressClickUntil = 0;
    let renderTimer = 0;

    const supportedPane = (pane) => Object.hasOwn(DEFAULT_SHAPES, String(pane ?? ""));
    const isPhone = () => Boolean(root.matchMedia?.("(max-width: 760px)")?.matches);
    const currentPane = () => supportedPane(runtimeState.focus?.pane) ? runtimeState.focus.pane : null;
    const contextIdFor = (pane) => pane === "phrase"
      ? Number(runtimeState.phrase)
      : pane === "chain" ? Number(runtimeState.chain) : null;
    const paneShape = (pane) => {
      if (pane === "song") {
        const song = projectStore.getState()?.song;
        return {
          rows: Math.max(1, Number(song?.length) || DEFAULT_SHAPES.song.rows),
          cols: Math.max(1, Number(song?.[0]?.length) || DEFAULT_SHAPES.song.cols),
        };
      }
      return DEFAULT_SHAPES[pane] ?? null;
    };
    const currentCell = () => {
      const pane = currentPane();
      if (!pane) return null;
      const shape = paneShape(pane);
      return {
        pane,
        contextId: contextIdFor(pane),
        row: clamp(Number(runtimeState.focus?.row) || 0, 0, shape.rows - 1),
        col: clamp(Number(runtimeState.focus?.col) || 0, 0, shape.cols - 1),
      };
    };
    const fieldSpan = (pane, col) => {
      const shape = paneShape(pane);
      const normalized = clamp(Number(col) || 0, 0, shape.cols - 1);
      if (pane === "phrase" && isPhone() && normalized >= 3) {
        const commandCol = normalized % 2 === 0 ? normalized - 1 : normalized;
        return Object.freeze({ startCol: commandCol, endCol: Math.min(shape.cols - 1, commandCol + 1) });
      }
      return Object.freeze({ startCol: normalized, endCol: normalized });
    };
    const selectionMatchesCurrent = (value = selection) => {
      const cell = currentCell();
      return Boolean(value && cell && value.pane === cell.pane && value.contextId === cell.contextId);
    };

    function publicSelection() {
      if (!selection) {
        return Object.freeze({
          active: false,
          pane: null,
          contextId: null,
          phraseId: null,
          chainId: null,
          startRow: null,
          endRow: null,
          rowCount: 0,
          startCol: null,
          endCol: null,
          colCount: 0,
          rowMode: false,
        });
      }
      const shape = paneShape(selection.pane);
      const rows = normalizeRange(selection.anchorRow, selection.focusRow, shape.rows);
      const startCol = Math.min(
        selection.anchorStartCol,
        selection.anchorEndCol,
        selection.focusStartCol,
        selection.focusEndCol,
      );
      const endCol = Math.max(
        selection.anchorStartCol,
        selection.anchorEndCol,
        selection.focusStartCol,
        selection.focusEndCol,
      );
      return Object.freeze({
        active: true,
        pane: selection.pane,
        contextId: selection.contextId,
        phraseId: selection.pane === "phrase" ? selection.contextId : null,
        chainId: selection.pane === "chain" ? selection.contextId : null,
        anchorRow: rows.anchorRow,
        focusRow: rows.focusRow,
        startRow: rows.startRow,
        endRow: rows.endRow,
        rowCount: rows.rowCount,
        anchorCol: selection.anchorStartCol,
        anchorEndCol: selection.anchorEndCol,
        focusCol: selection.focusStartCol,
        focusEndCol: selection.focusEndCol,
        startCol,
        endCol,
        colCount: endCol - startCol + 1,
        rowMode: Boolean(selection.rowMode),
      });
    }

    function publicClipboard() {
      const metadata = runtimeState.p3.internalClipboard;
      return Object.freeze({
        available: Boolean(clipboardPayload?.cells?.length),
        kind: metadata?.kind ?? null,
        pane: metadata?.pane ?? null,
        rowCount: clipboardPayload?.cells?.length ?? 0,
        colCount: clipboardPayload?.cells?.[0]?.length ?? 0,
        fields: clone(metadata?.fields ?? []),
        sourceContextId: metadata?.sourceContextId ?? null,
        sourcePhrase: metadata?.sourcePhrase ?? null,
        sourceChain: metadata?.sourceChain ?? null,
        sourceStartRow: metadata?.sourceStartRow ?? null,
        sourceStartCol: metadata?.sourceStartCol ?? null,
        referenceSemantics: metadata?.referenceSemantics ?? null,
        copiedAt: metadata?.copiedAt ?? null,
      });
    }

    function snapshot() {
      return Object.freeze({
        selection: publicSelection(),
        clipboard: publicClipboard(),
        pasteTarget: Object.freeze({
          armed: Boolean(pasteTargetArmed && clipboardPayload?.cells?.length),
          movePending: Boolean(pasteTargetMovePending),
        }),
        lastOperation: clone(lastOperation),
      });
    }

    function scheduleRender() {
      if (!root.setTimeout || renderTimer) return;
      renderTimer = root.setTimeout(() => {
        renderTimer = 0;
        render();
      }, 0);
    }

    function publishSelection(before, source) {
      const after = publicSelection();
      runtimeState.p3.selection = clone(after);
      const changeSet = storeTypes.createNavigationChangeSet({
        subtype: "selection.trackerRectangle",
        target: "navigation.selection",
        path: ["selection"],
        before,
        after,
        renderTargets: ["navigation.selection", `${after.pane ?? before.pane ?? "tracker"}.selection`, "phone.commandBar"],
        source,
      });
      navigationStore.emit("navigation", changeSet);
      navigationStore.emit("selection", changeSet);
      render();
      scheduleRender();
      return { ok: true, before, after, navigationChangeSet: changeSet };
    }

    function setSelection(pane, anchorRow, anchorSpan, focusRow, focusSpan, source = "selection", options = {}) {
      if (!supportedPane(pane) || currentPane() !== pane) return { ok: false, reason: "unsupported-pane" };
      const before = publicSelection();
      const shape = paneShape(pane);
      const rows = normalizeRange(anchorRow, focusRow, shape.rows);
      const rowMode = Boolean(options.rowMode);
      const anchor = rowMode ? { startCol: 0, endCol: shape.cols - 1 } : anchorSpan;
      const focus = rowMode ? { startCol: 0, endCol: shape.cols - 1 } : focusSpan;
      selection = {
        pane,
        contextId: contextIdFor(pane),
        anchorRow: rows.anchorRow,
        focusRow: rows.focusRow,
        anchorStartCol: clamp(Number(anchor.startCol) || 0, 0, shape.cols - 1),
        anchorEndCol: clamp(Number(anchor.endCol) || 0, 0, shape.cols - 1),
        focusStartCol: clamp(Number(focus.startCol) || 0, 0, shape.cols - 1),
        focusEndCol: clamp(Number(focus.endCol) || 0, 0, shape.cols - 1),
        rowMode,
      };
      return publishSelection(before, source);
    }

    function cancelSelection(source = "selection-cancel") {
      const before = publicSelection();
      if (!selection) return { ok: true, before, after: before, mutated: false };
      selection = null;
      return { ...publishSelection(before, source), mutated: true };
    }

    function activeRectangleOrCurrent() {
      if (selectionMatchesCurrent()) return publicSelection();
      const cell = currentCell();
      if (!cell) return null;
      const span = fieldSpan(cell.pane, cell.col);
      return {
        active: false,
        pane: cell.pane,
        contextId: cell.contextId,
        phraseId: cell.pane === "phrase" ? cell.contextId : null,
        chainId: cell.pane === "chain" ? cell.contextId : null,
        startRow: cell.row,
        endRow: cell.row,
        rowCount: 1,
        startCol: span.startCol,
        endCol: span.endCol,
        colCount: span.endCol - span.startCol + 1,
        rowMode: false,
      };
    }

    function phraseAddress(col) {
      if (col < 3) return { kind: ["note", "velocity", "instrument"][col] };
      const relative = col - 3;
      return {
        kind: "fx",
        slot: Math.floor(relative / 2),
        component: relative % 2 === 0 ? "command" : "value",
      };
    }

    function phraseCell(step, col) {
      const address = phraseAddress(col);
      if (address.kind !== "fx") return step[address.kind];
      return Number(step.fx?.[address.slot]?.[address.component] ?? 0);
    }

    function setPhraseCell(step, col, value) {
      const address = phraseAddress(col);
      if (address.kind !== "fx") {
        step[address.kind] = value;
        return step;
      }
      step.fx = Array.from({ length: 3 }, (_, slot) => clone(step.fx?.[slot] ?? { command: 0, value: 0 }));
      step.fx[address.slot][address.component] = value;
      return step;
    }

    function blankCell(pane, col) {
      if (pane === "song") return -1;
      if (pane === "chain") return col === 0 ? -1 : 0;
      if (pane === "phrase") {
        if (col === 0) return -1;
        if (col === 1) return 100;
        if (col === 2) return -1;
        return 0;
      }
      return null;
    }

    function readCell(pane, contextId, row, col) {
      if (pane === "song") return projectStore.structure.readSongCell(row, col);
      if (pane === "chain") return projectStore.structure.readChainCell(contextId, row, col).value;
      if (pane === "phrase") return phraseCell(projectStore.phraseSteps.read(contextId, row), col);
      throw new Error(`Unsupported selection pane: ${pane}`);
    }

    const fieldIds = (pane, startCol, colCount) => (FIELD_IDS[pane] ?? []).slice(startCol, startCol + colCount);
    const fieldTypes = (pane, startCol, colCount) => (FIELD_TYPES[pane] ?? []).slice(startCol, startCol + colCount);

    function copy(source = "clipboard-copy") {
      const target = activeRectangleOrCurrent();
      if (!target) return { ok: false, reason: "unsupported-pane" };
      const cells = Array.from({ length: target.rowCount }, (_, rowOffset) => (
        Array.from({ length: target.colCount }, (_, colOffset) => clone(readCell(
          target.pane,
          target.contextId,
          target.startRow + rowOffset,
          target.startCol + colOffset,
        )))
      ));
      const copiedAt = Date.now();
      clipboardPayload = {
        pane: target.pane,
        sourceContextId: target.contextId,
        sourceStartRow: target.startRow,
        sourceStartCol: target.startCol,
        sourceFieldTypes: fieldTypes(target.pane, target.startCol, target.colCount),
        cells,
        phraseRows: target.pane === "phrase" && target.rowMode
          ? Array.from({ length: target.rowCount }, (_, rowOffset) => (
            clone(projectStore.phraseSteps.read(target.contextId, target.startRow + rowOffset))
          ))
          : null,
      };
      pasteTargetArmed = true;
      runtimeState.p3.internalClipboard = {
        available: true,
        kind: "tracker-rectangle",
        pane: target.pane,
        rowCount: target.rowCount,
        colCount: target.colCount,
        fields: fieldIds(target.pane, target.startCol, target.colCount),
        sourceContextId: target.contextId,
        sourcePhrase: target.pane === "phrase" ? target.contextId : null,
        sourceChain: target.pane === "chain" ? target.contextId : null,
        sourceStartRow: target.startRow,
        sourceStartCol: target.startCol,
        referenceSemantics: target.pane === "phrase" ? "value" : "shared-reference",
        copiedAt,
      };
      lastOperation = {
        type: "copy",
        pane: target.pane,
        rowCount: target.rowCount,
        colCount: target.colCount,
        startRow: target.startRow,
        startCol: target.startCol,
        at: copiedAt,
      };
      root.setStatus?.(`COPIED ${target.rowCount}×${target.colCount} ${target.pane.toUpperCase()} · BRKTRK`);
      render();
      return { ok: true, rowCount: target.rowCount, colCount: target.colCount, clipboard: publicClipboard() };
    }

    function compatibleDestination(pane, startCol) {
      if (!clipboardPayload || clipboardPayload.pane !== pane) return false;
      const shape = paneShape(pane);
      const count = Math.min(clipboardPayload.sourceFieldTypes.length, shape.cols - startCol);
      const targetTypes = fieldTypes(pane, startCol, count);
      return targetTypes.every((type, index) => type === clipboardPayload.sourceFieldTypes[index]);
    }

    function mutateRectangle(pane, contextId, startRow, startCol, cells, source, operation) {
      if (pane === "song") {
        return projectStore.structure.replaceSongRectangle(startRow, startCol, cells, {
          source,
          operation,
          transaction: {
            kind: `song-rectangle-${operation}`,
            referenceSemantics: "shared",
            rowCount: cells.length,
            colCount: cells[0]?.length ?? 0,
          },
        });
      }
      if (pane === "chain") {
        return projectStore.structure.replaceChainRectangle(contextId, startRow, startCol, cells, {
          source,
          operation,
          transaction: {
            kind: `chain-rectangle-${operation}`,
            referenceSemantics: "shared",
            chainId: contextId,
            rowCount: cells.length,
            colCount: cells[0]?.length ?? 0,
          },
        });
      }
      if (pane === "phrase") {
        const fullWidth = startCol === 0 && (cells[0]?.length ?? 0) === paneShape("phrase").cols;
        let rows;
        if (operation === "paste" && fullWidth && Array.isArray(clipboardPayload?.phraseRows)) {
          rows = clipboardPayload.phraseRows.slice(0, cells.length).map(clone);
        } else if (operation === "clear" && fullWidth) {
          rows = Array.from({ length: cells.length }, () => projectStore.phraseSteps.emptyStep());
        } else {
          rows = Array.from({ length: cells.length }, (_, rowOffset) => (
            clone(projectStore.phraseSteps.read(contextId, startRow + rowOffset))
          ));
          for (let r = 0; r < cells.length; r += 1) {
            for (let c = 0; c < cells[r].length; c += 1) {
              setPhraseCell(rows[r], startCol + c, cells[r][c]);
            }
          }
        }
        return projectStore.phraseSteps.replaceRows(contextId, startRow, rows, {
          source,
          transaction: {
            kind: `phrase-rectangle-${operation}`,
            startCol,
            rowCount: cells.length,
            colCount: cells[0]?.length ?? 0,
            semanticFullRow: fullWidth,
          },
        });
      }
      return { ok: false, reason: "unsupported-pane" };
    }

    function setSelectionToMutation(pane, contextId, startRow, startCol, rowCount, colCount, source) {
      const before = publicSelection();
      const endCol = startCol + Math.max(0, colCount - 1);
      selection = {
        pane,
        contextId,
        anchorRow: startRow,
        focusRow: startRow + Math.max(0, rowCount - 1),
        anchorStartCol: startCol,
        anchorEndCol: startCol,
        focusStartCol: endCol,
        focusEndCol: endCol,
        rowMode: colCount === paneShape(pane).cols,
      };
      return publishSelection(before, source);
    }

    function paste(source = "clipboard-paste") {
      const destination = activeRectangleOrCurrent();
      if (!destination) return { ok: false, reason: "unsupported-pane" };
      if (!clipboardPayload?.cells?.length) {
        root.setStatus?.("BRKTRK CLIPBOARD EMPTY", "muted");
        return { ok: false, reason: "empty-clipboard" };
      }
      if (clipboardPayload.pane !== destination.pane) {
        root.setStatus?.(`CLIPBOARD IS ${clipboardPayload.pane.toUpperCase()} · SWITCH PANE`, "amber");
        return { ok: false, reason: "pane-mismatch" };
      }
      if (!compatibleDestination(destination.pane, destination.startCol)) {
        root.setStatus?.("INCOMPATIBLE DESTINATION FIELD", "amber");
        return { ok: false, reason: "field-mismatch" };
      }
      const shape = paneShape(destination.pane);
      const clipped = clipRectangle(
        clipboardPayload.cells,
        destination.startRow,
        destination.startCol,
        shape.rows,
        shape.cols,
      );
      if (!clipped.rowCount || !clipped.colCount) return { ok: false, reason: "no-room" };
      const fullPhraseRows = destination.pane === "phrase"
        && destination.startCol === 0
        && clipped.colCount === paneShape("phrase").cols
        && Array.isArray(clipboardPayload.phraseRows);
      const result = fullPhraseRows
        ? projectStore.phraseSteps.replaceRows(
          destination.contextId,
          clipped.startRow,
          clipboardPayload.phraseRows.slice(0, clipped.rowCount),
          {
            source,
            transaction: {
              kind: "phrase-row-paste",
              rowMode: true,
              startCol: 0,
              rowCount: clipped.rowCount,
              colCount: paneShape("phrase").cols,
            },
          },
        )
        : mutateRectangle(
          destination.pane,
          destination.contextId,
          clipped.startRow,
          clipped.startCol,
          clipped.cells,
          source,
          "paste",
        );
      const rowCount = result.rowCount ?? clipped.rowCount;
      const colCount = result.colCount ?? clipped.colCount;
      const selectionMutation = setSelectionToMutation(
        destination.pane,
        destination.contextId,
        clipped.startRow,
        clipped.startCol,
        rowCount,
        colCount,
        `${source}-selection`,
      );
      pasteTargetArmed = true;
      const wasClipped = Boolean(clipped.clipped || result.clipped);
      lastOperation = {
        type: "paste",
        pane: destination.pane,
        rowCount,
        colCount,
        requestedRowCount: clipboardPayload.cells.length,
        requestedColCount: clipboardPayload.cells[0]?.length ?? 0,
        clipped: wasClipped,
        contextId: destination.contextId,
        startRow: clipped.startRow,
        startCol: clipped.startCol,
        at: Date.now(),
      };
      root.renderAll?.();
      root.setStatus?.(`PASTED ${rowCount}×${colCount}${wasClipped ? " · CLIPPED" : ""}`);
      render();
      scheduleRender();
      return {
        ...result,
        ok: true,
        requestedRowCount: lastOperation.requestedRowCount,
        requestedColCount: lastOperation.requestedColCount,
        clipped: wasClipped,
        projectChangeSet: result.changeSet ?? result.projectChangeSet ?? null,
        selectionChangeSet: selectionMutation?.navigationChangeSet ?? null,
      };
    }

    function clear(source = "selection-clear") {
      const target = activeRectangleOrCurrent();
      if (!target) return { ok: false, reason: "unsupported-pane" };
      const cells = Array.from({ length: target.rowCount }, () => (
        Array.from({ length: target.colCount }, (_, offset) => blankCell(target.pane, target.startCol + offset))
      ));
      const result = target.pane === "phrase" && target.rowMode
        ? projectStore.phraseSteps.clearRows(target.contextId, target.startRow, target.rowCount, {
          source,
          transaction: {
            kind: "phrase-row-clear",
            rowMode: true,
            startCol: 0,
            rowCount: target.rowCount,
            colCount: paneShape("phrase").cols,
          },
        })
        : mutateRectangle(
          target.pane,
          target.contextId,
          target.startRow,
          target.startCol,
          cells,
          source,
          "clear",
        );
      lastOperation = {
        type: "clear",
        pane: target.pane,
        rowCount: result.rowCount ?? target.rowCount,
        colCount: result.colCount ?? target.colCount,
        contextId: target.contextId,
        startRow: target.startRow,
        startCol: target.startCol,
        at: Date.now(),
      };
      root.renderAll?.();
      root.setStatus?.(`CLEARED ${lastOperation.rowCount}×${lastOperation.colCount}`);
      render();
      scheduleRender();
      return { ...result, ok: true, projectChangeSet: result.changeSet ?? result.projectChangeSet ?? null };
    }

    async function moveCursor(pane, row, col, source) {
      const cell = currentCell();
      if (!cell || (cell.pane === pane && cell.row === row && cell.col === col)) return;
      await commands.dispatch({ type: "cursor.select", pane, row, col, focus: false, source });
    }

    async function begin(command = {}) {
      pasteTargetArmed = false;
      const cell = currentCell();
      const pane = supportedPane(command.pane) ? command.pane : cell?.pane;
      if (!pane || currentPane() !== pane) return { ok: false, reason: "unsupported-pane" };
      const shape = paneShape(pane);
      const row = clamp(Number.isFinite(command.row) ? Number(command.row) : cell.row, 0, shape.rows - 1);
      const col = clamp(Number.isFinite(command.col) ? Number(command.col) : cell.col, 0, shape.cols - 1);
      const rowMode = Boolean(command.rowMode);
      const span = rowMode ? { startCol: 0, endCol: shape.cols - 1 } : fieldSpan(pane, col);
      await moveCursor(pane, row, col, command.source ?? "selection-begin-cursor");
      const result = setSelection(pane, row, span, row, span, command.source ?? "selection-begin", { rowMode });
      root.setStatus?.(`${pane.toUpperCase()} ${rowMode ? "ROW" : "CELL"} ${row.toString(16).toUpperCase().padStart(2, "0")} SELECTED`);
      return result;
    }

    async function extend(command = {}) {
      pasteTargetArmed = false;
      const cell = currentCell();
      if (!cell) return { ok: false, reason: "unsupported-pane" };
      const pane = cell.pane;
      const shape = paneShape(pane);
      const existing = selectionMatchesCurrent() ? selection : null;
      const rowMode = Boolean(existing?.rowMode || command.rowMode);
      const anchorRow = existing?.anchorRow ?? cell.row;
      const anchorSpan = existing
        ? { startCol: existing.anchorStartCol, endCol: existing.anchorEndCol }
        : fieldSpan(pane, cell.col);
      const baseRow = existing?.focusRow ?? cell.row;
      const baseCol = existing?.focusStartCol ?? cell.col;
      const requestedRow = Number.isFinite(command.row)
        ? Number(command.row)
        : baseRow + (Number(command.deltaRow ?? command.delta) || 0);
      const requestedCol = Number.isFinite(command.col)
        ? Number(command.col)
        : baseCol + (Number(command.deltaCol) || 0);
      const row = clamp(requestedRow, 0, shape.rows - 1);
      const col = clamp(requestedCol, 0, shape.cols - 1);
      const focusSpan = rowMode ? { startCol: 0, endCol: shape.cols - 1 } : fieldSpan(pane, col);
      await moveCursor(pane, row, rowMode ? cell.col : col, command.source ?? "selection-extend-cursor");
      const result = setSelection(pane, anchorRow, anchorSpan, row, focusSpan, command.source ?? "selection-extend", { rowMode });
      const rect = publicSelection();
      root.setStatus?.(`SELECTED ${rect.rowCount}×${rect.colCount} · ${pane.toUpperCase()}`);
      return result;
    }

    async function dispatch(command = {}) {
      switch (command.type) {
        case "selection.begin": return begin(command);
        case "selection.extend": return extend(command);
        case "selection.cancel": return cancelSelection(command.source ?? "selection-cancel");
        case "clipboard.copy": return copy(command.source ?? "clipboard-copy");
        case "clipboard.paste": return paste(command.source ?? "clipboard-paste");
        case "selection.clear": return clear(command.source ?? "selection-clear");
        default: return { ok: false, reason: "unknown-command", command: command.type ?? null };
      }
    }

    function render() {
      const view = publicSelection();
      const active = view.active && selectionMatchesCurrent();
      root.document?.querySelectorAll?.('[data-pane][data-row][data-col]')?.forEach?.((cell) => {
        if (!supportedPane(cell.dataset.pane)) return;
        const row = Number(cell.dataset.row);
        const col = Number(cell.dataset.col);
        const selected = Boolean(active
          && cell.dataset.pane === view.pane
          && row >= view.startRow && row <= view.endRow
          && col >= view.startCol && col <= view.endCol);
        cell.classList.toggle("m42b-cell-selected", selected);
        cell.dataset.rangeSelected = String(selected);
        const focused = runtimeState.focus?.pane === cell.dataset.pane
          && Number(runtimeState.focus?.row) === row
          && Number(runtimeState.focus?.col) === col;
        cell.setAttribute("aria-selected", String(selected || (!view.active && focused)));
      });
      root.document?.querySelectorAll?.('[data-row-pane][data-row]')?.forEach?.((rowElement) => {
        const pane = rowElement.dataset.rowPane;
        const shape = supportedPane(pane) ? paneShape(pane) : null;
        const row = Number(rowElement.dataset.row);
        const fullRow = Boolean(active && shape && pane === view.pane
          && row >= view.startRow && row <= view.endRow
          && view.startCol === 0 && view.endCol === shape.cols - 1);
        rowElement.classList.toggle("m42b-row-selected", fullRow);
      });
      const bar = root.document?.querySelector?.("#m42bSelectionActions");
      const showBar = Boolean(isPhone() && active);
      if (bar) {
        bar.hidden = !showBar;
        bar.dataset.rows = String(view.rowCount);
        bar.dataset.cols = String(view.colCount);
        bar.dataset.pane = view.pane ?? "";
        const pasteButton = bar.querySelector("#m42bPaste");
        if (pasteButton) pasteButton.disabled = !clipboardPayload?.cells?.length || clipboardPayload.pane !== view.pane;
      }
      const ordinary = root.document?.querySelector?.("#p34TouchActions");
      if (ordinary && showBar) ordinary.hidden = true;
      if (ordinary && !showBar) root.BRKTRKTouchActions?.refresh?.();
      root.document?.body?.classList?.toggle("m42b-selection-active", Boolean(active));
      root.document?.body?.setAttribute?.("data-m42b-selection-pane", active ? view.pane : "");
    }

    function injectPhoneActions() {
      if (!root.document || root.document.querySelector("#m42bSelectionActions")) return;
      const bar = root.document.createElement("nav");
      bar.id = "m42bSelectionActions";
      bar.className = "m42b-selection-actions";
      bar.hidden = true;
      bar.setAttribute("aria-label", "Tracker selection actions");
      bar.innerHTML = `
        <button id="m42bCopy" type="button">COPY</button>
        <button id="m42bPaste" type="button">PASTE</button>
        <button id="m42bClear" type="button">CLEAR</button>
        <button id="m42bDone" type="button">DONE</button>`;
      root.document.querySelector(".command-bar")?.append(bar);
      bar.querySelector("#m42bCopy")?.addEventListener("click", () => dispatch({ type: "clipboard.copy", source: "touch-selection" }));
      bar.querySelector("#m42bPaste")?.addEventListener("click", () => dispatch({ type: "clipboard.paste", source: "touch-selection" }));
      bar.querySelector("#m42bClear")?.addEventListener("click", () => dispatch({ type: "selection.clear", source: "touch-selection" }));
      bar.querySelector("#m42bDone")?.addEventListener("click", () => dispatch({ type: "selection.cancel", source: "touch-selection" }));
    }

    function selectionTarget(event) {
      const cell = event.target?.closest?.('[data-pane][data-row][data-col]');
      if (!cell || !supportedPane(cell.dataset.pane)) return null;
      return {
        pane: cell.dataset.pane,
        row: Number(cell.dataset.row),
        col: Number(cell.dataset.col),
        key: `${cell.dataset.pane}:${cell.dataset.row}:${cell.dataset.col}`,
      };
    }

    async function retargetPasteTarget(target, source = "paste-target-pointer") {
      if (!pasteTargetArmed || !clipboardPayload?.cells?.length || !target) {
        return { ok: false, handled: false, reason: "paste-target-not-armed" };
      }
      if (clipboardPayload.pane !== target.pane) {
        return { ok: false, handled: false, reason: "pane-mismatch" };
      }
      const targetSpan = fieldSpan(target.pane, target.col);
      if (!compatibleDestination(target.pane, targetSpan.startCol)) {
        root.setStatus?.("INCOMPATIBLE DESTINATION FIELD", "amber");
        return { ok: false, handled: true, reason: "field-mismatch" };
      }
      const before = publicSelection();
      if (selection) {
        selection = null;
        publishSelection(before, `${source}-pre-navigation`);
      }
      const cursorResult = await commands.dispatch({
        type: "cursor.select",
        pane: target.pane,
        row: target.row,
        col: target.col,
        focus: false,
        source,
      });
      if (!cursorResult || cursorResult.ok === false) {
        return { ok: false, handled: true, reason: "cursor-select-failed", cursorResult };
      }
      const appliedSpan = fieldSpan(target.pane, target.col);
      const selectionResult = setSelection(
        target.pane,
        target.row,
        appliedSpan,
        target.row,
        appliedSpan,
        "selection-paste-target",
        { rowMode: false },
      );
      pasteTargetArmed = true;
      root.setStatus?.(`PASTE TARGET · ${target.pane.toUpperCase()} ${target.row.toString(16).toUpperCase().padStart(2, "0")}`);
      return { ok: true, handled: true, cursorResult, selectionResult };
    }

    function pasteTargetClick(event) {
      if (!pasteTargetArmed || !clipboardPayload?.cells?.length) return;
      if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = selectionTarget(event);
      if (!target || clipboardPayload.pane !== target.pane) return;
      const targetSpan = fieldSpan(target.pane, target.col);
      if (!compatibleDestination(target.pane, targetSpan.startCol)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        root.setStatus?.("INCOMPATIBLE DESTINATION FIELD", "amber");
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pasteTargetMovePending) return;
      pasteTargetMovePending = true;
      void retargetPasteTarget(target, "paste-target-pointer")
        .catch((error) => {
          console.error(error);
          root.setStatus?.("PASTE TARGET FAILED", "danger");
        })
        .finally(() => {
          pasteTargetMovePending = false;
          render();
        });
    }

    function clearLongPress() {
      root.clearTimeout?.(longPressTimer);
      longPressTimer = 0;
      longPressPointerId = null;
    }

    function pointerDown(event) {
      if (!isPhone()) return;
      const target = selectionTarget(event);
      if (!target || event.button > 0) return;
      clearLongPress();
      longPressPointerId = event.pointerId;
      longPressTimer = root.setTimeout?.(() => {
        longPressTimer = 0;
        if (longPressPointerId !== event.pointerId) return;
        suppressClickKey = target.key;
        suppressClickUntil = Date.now() + LONG_PRESS_CLICK_SUPPRESS_MS;
        root.navigator?.vibrate?.(15);
        void dispatch({
          type: "selection.begin",
          pane: target.pane,
          row: target.row,
          col: target.col,
          source: "touch-long-press",
        });
      }, LONG_PRESS_MS);
    }

    function pointerEnd(event) {
      if (longPressPointerId == null || event.pointerId !== longPressPointerId) return;
      clearLongPress();
    }

    function suppressLongPressClick(event) {
      if (!suppressClickKey || Date.now() > suppressClickUntil) {
        suppressClickKey = null;
        return;
      }
      const target = selectionTarget(event);
      if (!target || target.key !== suppressClickKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClickKey = null;
    }

    function contextMenuHandler(event) {
      if (!selection && !longPressTimer) return;
      if (!selectionTarget(event)) return;
      event.preventDefault();
    }

    function keyboardHandler(event) {
      if (event.defaultPrevented || event.altKey) return;
      if (event.target?.matches?.("input, textarea, select, [contenteditable='true']")) return;
      if (root.document?.querySelector?.("#helpDialog")?.open || root.document?.querySelector?.("#settingsDialog")?.open) return;
      const pane = currentPane();
      if (!pane) return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = String(event.key ?? "").toLowerCase();

      if (modifier && key === "c" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void dispatch({ type: "clipboard.copy", source: "keyboard" });
        return;
      }
      if (modifier && key === "v" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void dispatch({ type: "clipboard.paste", source: "keyboard" });
        return;
      }
      if (!modifier && event.shiftKey && event.code === "Space") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (selectionMatchesCurrent() && selection?.rowMode) {
          void dispatch({ type: "selection.cancel", source: "keyboard" });
        } else {
          void dispatch({ type: "selection.begin", pane, row: runtimeState.focus.row, rowMode: true, source: "keyboard" });
        }
        return;
      }
      if (!modifier && event.shiftKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const deltaRow = event.code === "ArrowDown" ? 1 : event.code === "ArrowUp" ? -1 : 0;
        const deltaCol = event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0;
        if (selection?.rowMode && deltaCol !== 0) return;
        void dispatch({ type: "selection.extend", deltaRow, deltaCol, source: "keyboard" });
        return;
      }
      if (!modifier && selectionMatchesCurrent() && (event.code === "Delete" || event.code === "Backspace")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void dispatch({ type: "selection.clear", source: "keyboard" });
        return;
      }
      if (!modifier && event.code === "Escape" && selection) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void dispatch({ type: "selection.cancel", source: "keyboard" });
      }
    }

    function commandObserver(record) {
      const command = record?.command;
      if (!command) return;
      if (selection && command.type === "cursor.select" && command.source === "pointer-cell" && supportedPane(command.pane)) {
        if (!selectionMatchesCurrent() || command.pane !== selection.pane) {
          cancelSelection("selection-context-changed");
        } else if (pasteTargetArmed && clipboardPayload?.cells?.length) {
          const targetSpan = fieldSpan(command.pane, Number(command.col));
          if (!compatibleDestination(command.pane, targetSpan.startCol)) {
            root.setStatus?.("INCOMPATIBLE DESTINATION FIELD", "amber");
            return;
          }
          void setSelection(
            command.pane,
            Number(command.row),
            targetSpan,
            Number(command.row),
            targetSpan,
            "selection-paste-target",
            { rowMode: false },
          );
        } else {
          const focusSpan = selection.rowMode
            ? { startCol: 0, endCol: paneShape(selection.pane).cols - 1 }
            : fieldSpan(command.pane, Number(command.col));
          void setSelection(
            selection.pane,
            selection.anchorRow,
            { startCol: selection.anchorStartCol, endCol: selection.anchorEndCol },
            Number(command.row),
            focusSpan,
            "selection-pointer-extend",
            { rowMode: selection.rowMode },
          );
        }
        return;
      }
      if (selection && (command.type.startsWith("hierarchy.")
          || command.type.startsWith("workspace.")
          || command.type === "context.navigate")) scheduleRender();
      if (selection && !selectionMatchesCurrent()) cancelSelection("selection-context-changed");
    }

    injectPhoneActions();
    root.document?.addEventListener?.("pointerdown", pointerDown, true);
    root.document?.addEventListener?.("pointerup", pointerEnd, true);
    root.document?.addEventListener?.("pointercancel", pointerEnd, true);
    root.document?.addEventListener?.("contextmenu", contextMenuHandler, true);
    root.document?.addEventListener?.("keydown", keyboardHandler, true);
    root.addEventListener?.("click", pasteTargetClick, true);
    root.addEventListener?.("click", suppressLongPressClick, true);
    const unsubscribeCommands = commands.subscribe?.(commandObserver) ?? (() => {});
    const unsubscribeProject = projectStore.subscribe?.("render", scheduleRender) ?? (() => {});
    root.BRKTRKUndoRedo?.subscribe?.(scheduleRender);
    root.addEventListener?.("resize", render);

    const api = {
      installed: true,
      dispatch,
      snapshot,
      render,
      cancelSelection,
      retargetPasteTarget,
      getSelection: publicSelection,
      getClipboardMetadata: publicClipboard,
      dispose() {
        unsubscribeCommands?.();
        unsubscribeProject?.();
        root.document?.removeEventListener?.("pointerdown", pointerDown, true);
        root.document?.removeEventListener?.("pointerup", pointerEnd, true);
        root.document?.removeEventListener?.("pointercancel", pointerEnd, true);
        root.document?.removeEventListener?.("contextmenu", contextMenuHandler, true);
        root.document?.removeEventListener?.("keydown", keyboardHandler, true);
        root.removeEventListener?.("click", pasteTargetClick, true);
        root.removeEventListener?.("click", suppressLongPressClick, true);
        root.removeEventListener?.("resize", render);
      },
    };

    if (!Object.hasOwn(commands, "selectionClipboard")) {
      Object.defineProperty(commands, "selectionClipboard", {
        value: api,
        configurable: false,
        enumerable: true,
        writable: false,
      });
    }
    if (!Object.hasOwn(navigationStore, "selectionClipboard")) {
      Object.defineProperty(navigationStore, "selectionClipboard", {
        value: api,
        configurable: false,
        enumerable: true,
        writable: false,
      });
    }
    diagnostics?.registerSection?.("selectionClipboard", snapshot);
    render();
    return api;
  }

  const exported = Object.freeze({
    LONG_PRESS_MS,
    LONG_PRESS_CLICK_SUPPRESS_MS,
    DEFAULT_SHAPES,
    FIELD_IDS,
    FIELD_TYPES,
    normalizeRange,
    normalizeRectangle,
    clipRows,
    clipRectangle,
    createController,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  globalThis.BRKTRKSelectionClipboardDomain = exported;
  if (globalThis.document && globalThis.BRKTRKCommands?.installed && globalThis.BRKTRKStores?.project) {
    globalThis.BRKTRKSelectionClipboard = createController(globalThis);
  }
})();