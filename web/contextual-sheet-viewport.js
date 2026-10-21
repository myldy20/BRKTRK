((root, factory) => {
  const api = factory();
  root.BRKTRKContextualSheetViewportPolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root.document) {
    const liveState = typeof state !== "undefined" ? state : root.state;
    api.install(root, { state: liveState });
  }
})(globalThis, () => {
  const PHONE_QUERY = "(max-width: 760px)";
  const STRUCTURAL = Object.freeze(["song", "chain", "phrase"]);
  const SHEET_SELECTORS = Object.freeze({
    note: "#p3NoteDock",
    value: "#p32ValueDock",
    context: "#p3ContextPicker",
    "follow-scope": "#p36MobilePolicyPanel",
  });
  const GRID_SELECTORS = Object.freeze({
    song: "#songGrid",
    chain: "#chainGrid",
    phrase: "#phraseGrid",
  });
  const STYLE_KEYS = Object.freeze([
    "height",
    "maxHeight",
    "minHeight",
    "overflowY",
    "overflowAnchor",
    "scrollPaddingBottom",
  ]);

  function structuralPane(value) {
    return STRUCTURAL.includes(value) ? value : null;
  }

  function resolveViewportTarget({ activeSheet = null, workspace = null, focus = null } = {}) {
    const sheetSelector = SHEET_SELECTORS[activeSheet];
    if (!sheetSelector) return null;
    const pane = activeSheet === "note"
      ? "phrase"
      : structuralPane(workspace) ?? structuralPane(focus?.pane);
    if (!pane) return null;
    return Object.freeze({
      activeSheet,
      sheetSelector,
      pane,
      gridSelector: GRID_SELECTORS[pane],
      row: Number.isInteger(focus?.row) ? focus.row : 0,
      col: activeSheet === "note" ? 0 : Number.isInteger(focus?.col) ? focus.col : 0,
    });
  }

  function computeAvailableHeight({ gridTop, sheetTop, gap = 8, minHeight = 86 } = {}) {
    const top = Number(gridTop);
    const sheet = Number(sheetTop);
    if (!Number.isFinite(top) || !Number.isFinite(sheet)) return Math.max(0, Number(minHeight) || 0);
    return Math.max(Number(minHeight) || 0, Math.floor(sheet - top - (Number(gap) || 0)));
  }

  function computeScrollTop({
    scrollTop = 0,
    scrollHeight = 0,
    clientHeight = 0,
    gridTop = 0,
    gridBottom = 0,
    sheetTop = Number.POSITIVE_INFINITY,
    cellTop = 0,
    cellBottom = 0,
    edgeGap = 6,
  } = {}) {
    const visibleTop = Number(gridTop) + 4;
    const visibleBottom = Math.min(Number(gridBottom), Number(sheetTop) - 8);
    const maxScroll = Math.max(0, Number(scrollHeight) - Number(clientHeight));
    let target = Number(scrollTop) || 0;
    if (Number(cellBottom) > visibleBottom) target += Number(cellBottom) - visibleBottom + Number(edgeGap);
    else if (Number(cellTop) < visibleTop) target -= visibleTop - Number(cellTop) + Number(edgeGap);
    return Math.max(0, Math.min(maxScroll, target));
  }

  function computeRowScrollTop({
    scrollTop = 0,
    scrollHeight = 0,
    clientHeight = 0,
    headerHeight = 0,
    rowOffsetTop = 0,
    rowHeight = 0,
    edgeGap = 6,
  } = {}) {
    const current = Number(scrollTop) || 0;
    const viewportHeight = Math.max(0, Number(clientHeight) || 0);
    const stickyHeader = Math.max(0, Number(headerHeight) || 0);
    const rowTop = Math.max(0, Number(rowOffsetTop) || 0);
    const rowBottom = rowTop + Math.max(0, Number(rowHeight) || 0);
    const maxScroll = Math.max(0, Number(scrollHeight) - viewportHeight);
    const visibleTop = current + stickyHeader + Number(edgeGap);
    const visibleBottom = current + viewportHeight - Number(edgeGap);
    let target = current;
    if (rowBottom > visibleBottom) target = rowBottom - viewportHeight + Number(edgeGap);
    else if (rowTop < visibleTop) target = rowTop - stickyHeader - Number(edgeGap);
    return Math.max(0, Math.min(maxScroll, target));
  }

  function snapshotInlineStyles(element) {
    const snapshot = {};
    for (const key of STYLE_KEYS) snapshot[key] = element.style[key];
    return Object.freeze(snapshot);
  }

  function restoreInlineStyles(element, snapshot) {
    for (const key of STYLE_KEYS) element.style[key] = snapshot?.[key] ?? "";
  }

  function createRuntime(root, environment = {}) {
    const document = root.document;
    const originalStyles = new WeakMap();
    const fittedElements = new Set();
    let activeGrid = null;
    let activeFrame = null;
    let observedSheet = null;
    let scheduled = false;
    let frameId = 0;
    let revealFrameId = 0;

    const entryState = () => environment.entryState
      ?? root.BRKTRKStores?.navigation?.entryState
      ?? root.BRKTRKCommands?.stores?.navigation?.entryState
      ?? null;
    const currentState = () => environment.state ?? root.state ?? {};
    const phoneMedia = root.matchMedia?.(PHONE_QUERY) ?? null;
    const isPhone = () => phoneMedia?.matches ?? Number(root.innerWidth) <= 760;
    const requestFrame = root.requestAnimationFrame?.bind(root)
      ?? ((callback) => root.setTimeout(callback, 0));
    const cancelFrame = root.cancelAnimationFrame?.bind(root)
      ?? root.clearTimeout?.bind(root);

    const resizeObserver = typeof root.ResizeObserver === "function"
      ? new root.ResizeObserver(() => schedule("sheet-resize"))
      : null;

    function workspaceFor(value) {
      return value.p3?.activeWorkspace ?? value.view ?? value.focus?.pane ?? null;
    }

    function currentTarget() {
      const navigation = entryState();
      const value = currentState();
      return resolveViewportTarget({
        activeSheet: navigation?.getActiveSheet?.() ?? null,
        workspace: workspaceFor(value),
        focus: value.focus,
      });
    }

    function selectedCell(target) {
      return document.querySelector(
        `[data-pane="${target.pane}"][data-row="${target.row}"][data-col="${target.col}"]`,
      );
    }

    function trackerFrame(grid) {
      return grid?.closest?.(".subpane, .pane") ?? null;
    }

    function rememberElement(element) {
      if (!element) return;
      if (!originalStyles.has(element)) originalStyles.set(element, snapshotInlineStyles(element));
      fittedElements.add(element);
    }

    function cancelPendingReveal() {
      if (revealFrameId) cancelFrame?.(revealFrameId);
      revealFrameId = 0;
    }

    function restoreElement(element) {
      if (!element) return;
      const snapshot = originalStyles.get(element);
      if (snapshot) restoreInlineStyles(element, snapshot);
      originalStyles.delete(element);
      fittedElements.delete(element);
      delete element.dataset.contextualViewportOwner;
      delete element.dataset.contextualScrollTarget;
      delete element.dataset.contextualScrollApplied;
      delete element.dataset.contextualViewportRow;
      if (activeGrid === element) activeGrid = null;
      if (activeFrame === element) activeFrame = null;
    }

    function restoreAll(exceptions = []) {
      const retained = new Set(Array.isArray(exceptions) ? exceptions : [exceptions]);
      if (retained.has(activeGrid) && activeFrame) retained.add(activeFrame);
      if (!retained.size) cancelPendingReveal();
      for (const element of [...fittedElements]) {
        if (!retained.has(element)) restoreElement(element);
      }
      if (!retained.size) {
        activeGrid = null;
        activeFrame = null;
      }
    }

    function observeSheet(sheet) {
      if (observedSheet === sheet) return;
      if (observedSheet) resizeObserver?.unobserve(observedSheet);
      observedSheet = sheet ?? null;
      if (observedSheet) resizeObserver?.observe(observedSheet);
    }

    function applyGeometry(grid, sheet, frame) {
      const sheetRect = sheet.getBoundingClientRect();
      if (frame) {
        const frameRect = frame.getBoundingClientRect();
        const frameHeight = computeAvailableHeight({
          gridTop: frameRect.top,
          sheetTop: sheetRect.top,
          gap: 8,
          minHeight: 128,
        });
        const frameSize = `${frameHeight}px`;
        frame.style.height = frameSize;
        frame.style.maxHeight = frameSize;
        frame.style.minHeight = "0";
      }

      const gridRect = grid.getBoundingClientRect();
      const availableHeight = computeAvailableHeight({
        gridTop: gridRect.top,
        sheetTop: sheetRect.top,
        gap: 12,
      });
      const height = `${availableHeight}px`;
      grid.style.height = height;
      grid.style.maxHeight = height;
      grid.style.minHeight = "0";
      grid.style.overflowY = "auto";
      grid.style.overflowAnchor = "none";
      grid.style.scrollPaddingBottom = "8px";
      return availableHeight;
    }

    function reveal(target, grid) {
      const cell = selectedCell(target);
      const row = cell?.closest?.(".grid-row");
      if (!cell?.isConnected || !row) return false;
      const rows = [...grid.querySelectorAll(".grid-row")];
      const rowIndex = rows.indexOf(row);
      if (rowIndex < 0) return false;

      const headerHeight = grid.querySelector(".grid-header")?.getBoundingClientRect().height ?? 0;
      const rowHeights = rows.map((entry) => entry.getBoundingClientRect().height || entry.offsetHeight || 31);
      const rowContentTop = headerHeight + rowHeights.slice(0, rowIndex).reduce((total, height) => total + height, 0);
      const rowHeight = rowHeights[rowIndex] || 31;
      const logicalScrollHeight = headerHeight + rowHeights.reduce((total, height) => total + height, 0);
      const reservedHeight = Number.parseFloat(grid.style.height);
      const viewportHeight = Number.isFinite(reservedHeight) && reservedHeight > 0 ? reservedHeight : grid.clientHeight;
      const targetScroll = computeRowScrollTop({
        scrollTop: grid.scrollTop,
        scrollHeight: Math.max(grid.scrollHeight, logicalScrollHeight),
        clientHeight: viewportHeight,
        headerHeight,
        rowOffsetTop: rowContentTop,
        rowHeight,
      });

      grid.dataset.contextualViewportRow = String(target.row);
      grid.dataset.contextualScrollTarget = String(Math.round(targetScroll));
      if (typeof grid.scrollTo === "function") grid.scrollTo({ top: targetScroll, behavior: "auto" });
      grid.scrollTop = targetScroll;
      grid.dataset.contextualScrollApplied = String(Math.round(grid.scrollTop));
      return Math.abs(grid.scrollTop - targetScroll) < 1;
    }

    function sameTarget(candidate, expected, grid, sheet) {
      return Boolean(candidate
        && candidate.activeSheet === expected.activeSheet
        && candidate.gridSelector === expected.gridSelector
        && candidate.pane === expected.pane
        && grid.dataset.contextualViewportOwner === expected.activeSheet
        && sheet.getAttribute("aria-hidden") === "false");
    }

    function scheduleReveal(target, grid, sheet, frame) {
      cancelPendingReveal();
      revealFrameId = requestFrame(() => {
        revealFrameId = 0;
        const latestTarget = currentTarget();
        if (!sameTarget(latestTarget, target, grid, sheet)) return;
        applyGeometry(grid, sheet, frame);
        reveal(latestTarget, grid);
        revealFrameId = requestFrame(() => {
          revealFrameId = 0;
          const finalTarget = currentTarget();
          if (!sameTarget(finalTarget, target, grid, sheet)) return;
          reveal(finalTarget, grid);
        });
      });
    }

    function syncNow(reason = "manual") {
      const target = currentTarget();
      if (!isPhone() || !target) {
        observeSheet(null);
        restoreAll();
        if (document.body) document.body.dataset.contextualViewportState = "restored";
        return Object.freeze({ fitted: false, reason, target });
      }

      const sheet = document.querySelector(target.sheetSelector);
      const grid = document.querySelector(target.gridSelector);
      const frame = trackerFrame(grid);
      if (!sheet || !grid || sheet.getAttribute("aria-hidden") !== "false") {
        observeSheet(null);
        restoreAll();
        if (document.body) document.body.dataset.contextualViewportState = "restored";
        return Object.freeze({ fitted: false, reason, target });
      }

      if (activeGrid && activeGrid !== grid) restoreElement(activeGrid);
      if (activeFrame && activeFrame !== frame) restoreElement(activeFrame);
      rememberElement(frame);
      rememberElement(grid);
      activeFrame = frame;
      activeGrid = grid;
      observeSheet(sheet);

      const availableHeight = applyGeometry(grid, sheet, frame);
      grid.dataset.contextualViewportOwner = target.activeSheet;
      if (frame) frame.dataset.contextualViewportOwner = target.activeSheet;
      restoreAll(grid);
      reveal(target, grid);
      scheduleReveal(target, grid, sheet, frame);

      if (document.body) {
        document.body.dataset.contextualViewportState = target.activeSheet;
        document.body.dataset.contextualViewportPane = target.pane;
      }
      return Object.freeze({ fitted: true, reason, target, availableHeight });
    }

    function schedule(reason = "scheduled") {
      if (scheduled) return false;
      scheduled = true;
      frameId = requestFrame(() => {
        scheduled = false;
        frameId = 0;
        syncNow(reason);
      });
      return true;
    }

    function revealSelectedCell(reason = "reveal-selected") {
      return syncNow(reason);
    }

    function disconnect() {
      if (scheduled && frameId) cancelFrame?.(frameId);
      cancelPendingReveal();
      scheduled = false;
      frameId = 0;
      resizeObserver?.disconnect();
      root.removeEventListener?.("resize", onViewportChange);
      root.removeEventListener?.("orientationchange", onViewportChange);
      root.visualViewport?.removeEventListener?.("resize", onViewportChange);
      phoneMedia?.removeEventListener?.("change", onViewportChange);
      restoreAll();
    }

    function onViewportChange() {
      schedule("viewport-change");
    }

    root.addEventListener?.("resize", onViewportChange);
    root.addEventListener?.("orientationchange", onViewportChange);
    root.visualViewport?.addEventListener?.("resize", onViewportChange);
    phoneMedia?.addEventListener?.("change", onViewportChange);

    return Object.freeze({
      sync: schedule,
      syncNow,
      revealSelectedCell,
      restore: restoreAll,
      disconnect,
      resolveViewportTarget,
      computeAvailableHeight,
      computeScrollTop,
      computeRowScrollTop,
    });
  }

  function install(root, environment = {}) {
    if (root.BRKTRKContextualSheetViewport?.installed) return root.BRKTRKContextualSheetViewport;
    const runtime = createRuntime(root, environment);
    const api = Object.freeze({ installed: true, ...runtime });
    root.BRKTRKContextualSheetViewport = api;
    if (root.document?.body) root.document.body.dataset.contextualViewportArchitecture = "m4.0a-e4";
    api.sync("install");
    return api;
  }

  return Object.freeze({
    PHONE_QUERY,
    SHEET_SELECTORS,
    GRID_SELECTORS,
    resolveViewportTarget,
    computeAvailableHeight,
    computeScrollTop,
    computeRowScrollTop,
    snapshotInlineStyles,
    restoreInlineStyles,
    createRuntime,
    install,
  });
});
