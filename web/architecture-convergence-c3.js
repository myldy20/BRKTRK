(() => {
  const installedAt = performance.now();

  function functionName(value) {
    return typeof value === "function" ? (value.name || "anonymous") : null;
  }

  function snapshot() {
    const render = globalThis.BRKTRKRenderRuntime?.snapshot?.() ?? null;
    const bootstrap = globalThis.BRKTRKBootstrapInput?.snapshot?.() ?? null;
    const playbackRefresh = globalThis.BRKTRKProjectPlaybackRefresh?.snapshot?.() ?? null;
    const commands = globalThis.BRKTRKCommands ?? null;
    return Object.freeze({
      version: 3,
      owner: "architecture-convergence-c3",
      installedAtMs: Number(installedAt.toFixed(3)),
      bootstrap,
      render,
      playbackRefresh,
      reservedShortcutOwner: globalThis.BRKTRKKeyboardCommandResolver?.snapshot?.() ?? null,
      wrappers: Object.freeze({
        persist: functionName(globalThis.persist ?? (typeof persist !== "undefined" ? persist : null)),
        renderAll: functionName(globalThis.renderAll ?? (typeof renderAll !== "undefined" ? renderAll : null)),
        renderTransport: functionName(globalThis.renderTransport ?? (typeof renderTransport !== "undefined" ? renderTransport : null)),
        renderMixer: functionName(globalThis.renderMixer ?? (typeof renderMixer !== "undefined" ? renderMixer : null)),
        keyDown: functionName(globalThis.keyDown ?? (typeof keyDown !== "undefined" ? keyDown : null)),
        setFocus: functionName(globalThis.setFocus ?? (typeof setFocus !== "undefined" ? setFocus : null)),
        buildSequence: functionName(globalThis.buildSequence ?? (typeof buildSequence !== "undefined" ? buildSequence : null)),
      }),
      commandOwners: Object.freeze({
        keyDownCanonical: Boolean(commands?.keyDown && globalThis.keyDown === commands.keyDown),
        keyDown: functionName(commands?.keyDown),
        legacyKeyDown: functionName(commands?.legacy?.keyDown),
        legacySetFocus: functionName(commands?.legacy?.setFocus),
        setFocusUsesSemanticCompatibility: typeof globalThis.setFocus === "function"
          && String(globalThis.setFocus).includes("compatibility-setFocus"),
      }),
      intendedCompatibility: Object.freeze({
        keyDown: "BRKTRKCommands is the canonical live keyDown owner; p301KeyDown remains captured in commands.legacy until semantic utility-workspace/input migration is complete",
        setFocus: "BRKTRKCommands owns the global semantic setFocus compatibility adapter; p301SetFocus remains captured in commands.legacy until navigation/focus migration is complete",
        buildSequence: "p35BuildSequence retained as the single legacy playback-context decorator",
        playbackRefreshAdapter: playbackRefresh?.runtimeAdapterOwner ?? "pending",
        renderMixer: "renderTrackMixer is the canonical late production Mixer renderer; routing quarantine is a released named hook",
        renderTransport: "base app-render Transport renderer remains canonical; durable status UI uses named Transport hooks",
      }),
      removedInterceptors: Object.freeze([
        "p3RenderAll",
        "p301RenderAll",
        "p301Persist",
        "p35RenderMixer",
        "p36RenderAll",
        "p36Persist",
        "safetyRenderMixer",
        "safetyRenderTransport",
        "i1RenderAll",
        "i1ProjectPlaybackRefreshOwner",
        "transportStateRenderAll",
        "transportStateRenderTransport",
        "audioLifecycleRenderTransport",
      ]),
      retainedSafetyHooks: Object.freeze([
        "mixer-safety.scope-status",
      ]),
      workletBudgetOwner: "K4B realtime-event-window-domain unchanged",
    });
  }

  globalThis.BRKTRKArchitectureConvergenceC3 = Object.freeze({
    installed: true,
    snapshot,
  });
  globalThis.BRKTRKDiagnostics?.registerSection?.("architectureConvergenceC3", snapshot);
  document.body.dataset.architectureConvergenceC3 = "instrumented";
})();