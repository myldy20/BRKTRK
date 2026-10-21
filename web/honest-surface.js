(() => {
  const phraseSurface = globalThis.BRKTRKPhraseFxSurface;

  renderInspector = function honestRenderInspector() {
    const dock = ["sound", "mix"].includes(state.dock) ? state.dock : "none";
    renderInspectorIdentity();
    renderInstrumentParameters();
    renderMixer();

    globalThis.BRKTRKWorkspaceContextRenderer?.renderDock?.({ dock });
    $("#inspectorPane").dataset.dock = dock;
    $$("#dockTabs button").forEach((button) => button.classList.toggle("active", button.dataset.dock === state.dock));
    $("#soundDock").hidden = state.dock !== "sound";
    $("#mixerSection").hidden = state.dock !== "mix";
  };

  function removeUnavailableSurfaces() {
    $$('[data-dock="mod"], [data-dock="fx"]').forEach((element) => element.remove());
    $("#placeholderDock")?.remove();
  }

  removeUnavailableSurfaces();
  renderAll();
  focusSelectedCell();
  document.body.dataset.honestSurface = "0.8.26";

  globalThis.BRKTRKHonestSurface = Object.freeze({
    phraseColumns: phraseSurface?.PHRASE_COLS ?? 3,
    removeUnavailableSurfaces,
  });
})();
