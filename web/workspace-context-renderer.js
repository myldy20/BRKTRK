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

  function renderDock(context = {}) {
    const dock = context.dock ?? (context.activeWorkspace === "sound" ? "sound" : "mix");
    const inspector = document.querySelector("#inspectorPane");
    if (inspector) inspector.dataset.dock = dock;
    document.querySelectorAll("#utilityPanels button[data-panel]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.panel === dock));
    });
    const panelTitle = document.querySelector("#utilityPanelTitle");
    if (panelTitle) panelTitle.textContent = dock === "sound" ? "INSTRUMENT" : "MIXER";
    document.querySelectorAll("#dockTabs button[data-dock]").forEach((button) => {
      button.classList.toggle("active", button.dataset.dock === dock);
    });
    const sound = document.querySelector("#soundDock");
    const mixer = document.querySelector("#mixerSection");
    const placeholder = document.querySelector("#placeholderDock");
    if (sound) sound.hidden = dock !== "sound";
    if (mixer) mixer.hidden = dock !== "mix";
    if (placeholder) placeholder.hidden = dock === "sound" || dock === "mix";
  }

  function render(mutation = {}) {
    if (typeof document === "undefined") throw new Error("Workspace renderer requires a document");
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
    const count = Number(body.dataset.targetedWorkspaceRenders || 0) + 1;
    body.dataset.targetedWorkspaceRenders = String(count);
    body.dataset.targetedWorkspaceFrom = String(before.activeWorkspace ?? before.view ?? "unknown");
    body.dataset.targetedWorkspaceTo = String(after.activeWorkspace ?? after.view ?? "unknown");
    body.dataset.targetedWorkspaceDependencies = Object.entries(changed)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .join(",");

    return Object.freeze({ before, after, dependencies: changed, count });
  }

  const api = Object.freeze({ resolveContexts, dependencies, renderDock, render });
  globalThis.BRKTRKWorkspaceContextRenderer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
