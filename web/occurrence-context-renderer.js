(() => {
  function contextFrom(value) {
    if (value?.context && typeof value.context === "object") return value.context;
    return value && typeof value === "object" ? value : {};
  }

  function resolveContexts(mutation = {}) {
    const before = mutation.contextBefore ?? contextFrom(mutation.before);
    const after = mutation.contextAfter ?? contextFrom(mutation.after ?? mutation.value);
    return Object.freeze({ before, after });
  }

  function dependencies(before = {}, after = {}) {
    const beforeFocus = before.focus ?? {};
    const afterFocus = after.focus ?? {};
    return Object.freeze({
      workspace: before.activeWorkspace !== after.activeWorkspace || before.view !== after.view || before.dock !== after.dock,
      focus: beforeFocus.pane !== afterFocus.pane || beforeFocus.row !== afterFocus.row || beforeFocus.col !== afterFocus.col,
      track: before.track !== after.track || before.songRow !== after.songRow,
      chain: before.chain !== after.chain || before.chainRow !== after.chainRow,
      phrase: before.phrase !== after.phrase || before.phraseRow !== after.phraseRow,
      instrument: before.instrument !== after.instrument || before.soundParam !== after.soundParam,
    });
  }

  function render(mutation = {}) {
    if (typeof document === "undefined") throw new Error("Occurrence renderer requires a document");
    if (typeof renderTrackerCursor !== "function") throw new Error("Targeted Tracker cursor renderer is required");
    const { before, after } = resolveContexts(mutation);
    const changed = dependencies(before, after);

    renderTrackerCursor({ contextBefore: before, contextAfter: after });
    globalThis.BRKTRKTrackMixer?.updateTrackSelection?.(after.track);
    globalThis.BRKTRKWorkspaceFocus?.render?.();
    globalThis.BRKTRKTouchActions?.refresh?.();
    globalThis.BRKTRKCommandBindings?.refreshNoteDock?.();

    const body = document.body;
    const count = Number(body.dataset.targetedOccurrenceRenders || 0) + 1;
    body.dataset.targetedOccurrenceRenders = String(count);
    body.dataset.targetedOccurrenceFrom = `${before.activeWorkspace ?? before.view ?? "unknown"}:${before.songRow ?? 0}:${before.track ?? 0}:${before.chainRow ?? 0}`;
    body.dataset.targetedOccurrenceTo = `${after.activeWorkspace ?? after.view ?? "unknown"}:${after.songRow ?? 0}:${after.track ?? 0}:${after.chainRow ?? 0}`;
    body.dataset.targetedOccurrenceDependencies = Object.entries(changed)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .join(",");

    return Object.freeze({ before, after, dependencies: changed, count });
  }

  const api = Object.freeze({ resolveContexts, dependencies, render });
  globalThis.BRKTRKOccurrenceContextRenderer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
