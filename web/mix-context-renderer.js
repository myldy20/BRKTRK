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
      workspace: before.activeWorkspace !== after.activeWorkspace || before.view !== after.view,
      dock: before.dock !== after.dock,
      focus: beforeFocus.pane !== afterFocus.pane || beforeFocus.row !== afterFocus.row || beforeFocus.col !== afterFocus.col,
      track: before.track !== after.track || before.songRow !== after.songRow,
      chain: before.chain !== after.chain || before.chainRow !== after.chainRow,
      phrase: before.phrase !== after.phrase || before.phraseRow !== after.phraseRow,
      instrument: before.instrument !== after.instrument || before.soundParam !== after.soundParam,
    });
  }

  function renderDock(context = {}) {
    const dock = context.activeWorkspace === "sound"
      ? "sound"
      : context.activeWorkspace === "mix"
        ? "mix"
        : context.dock === "sound" ? "sound" : "mix";
    const inspector = document.querySelector("#inspectorPane");
    if (inspector) inspector.dataset.dock = dock;
    document.querySelectorAll("#dockTabs button[data-dock], #mobileSoundTabs button[data-dock]").forEach((button) => {
      button.classList.toggle("active", button.dataset.dock === dock);
    });
    const sound = document.querySelector("#soundDock");
    const mixer = document.querySelector("#mixerSection");
    if (sound) sound.hidden = dock !== "sound";
    if (mixer) mixer.hidden = dock !== "mix";
  }

  function render(mutation = {}) {
    if (typeof document === "undefined") throw new Error("Mix renderer requires a document");
    if (typeof renderTrackerCursor !== "function") throw new Error("Targeted Tracker cursor renderer is required");
    const { before, after } = resolveContexts(mutation);
    const changed = dependencies(before, after);

    if (typeof renderMobileView === "function") renderMobileView();
    renderDock(after);
    renderTrackerCursor({ contextBefore: before, contextAfter: after });
    globalThis.BRKTRKTrackMixer?.updateTrackSelection?.(after.track);
    globalThis.BRKTRKWorkspaceFocus?.render?.();
    globalThis.BRKTRKTouchActions?.refresh?.();
    globalThis.BRKTRKCommandBindings?.refreshNoteDock?.();

    const body = document.body;
    const count = Number(body.dataset.targetedMixRenders || 0) + 1;
    body.dataset.targetedMixRenders = String(count);
    body.dataset.targetedMixFrom = String(before.activeWorkspace ?? before.view ?? "unknown");
    body.dataset.targetedMixTo = String(after.activeWorkspace ?? after.view ?? "unknown");
    body.dataset.targetedMixDependencies = Object.entries(changed)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .join(",");

    return Object.freeze({ before, after, dependencies: changed, count });
  }

  const api = Object.freeze({ resolveContexts, dependencies, render });
  globalThis.BRKTRKMixContextRenderer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
