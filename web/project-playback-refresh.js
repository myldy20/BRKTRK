(() => {
  // C3 bootstrap convergence: publish one playback-refresh owner early. The
  // later I1 transport may install a specialized adapter, but it may not
  // replace this global owner.
  let refreshTimer = 0;
  let runtimeAdapter = null;
  const metrics = {
    projectRequests: 0,
    legacyRequests: 0,
    scheduled: 0,
    skipped: 0,
    nonStructuralRejected: 0,
    dependencyMisses: 0,
    adapterInstalls: 0,
    adapterDelegations: 0,
    linearApplied: 0,
    trackPlanApplied: 0,
    lastSource: null,
  };

  function resolveDependencies() {
    return Object.freeze({
      songPolicy: globalThis.BRKTRKSongTransportPolicy ?? null,
      transportRuntime: globalThis.BRKTRKStores?.transport?.runtime ?? null,
      eventCompiler: globalThis.BRKTRKEventPlanCompiler ?? null,
    });
  }

  function requireDependencies() {
    const dependencies = resolveDependencies();
    if (!dependencies.songPolicy || !dependencies.transportRuntime || !dependencies.eventCompiler) {
      metrics.dependencyMisses += 1;
      throw new Error("Song transport policy, EventPlanCompiler and TransportStore runtime are required for project playback refresh");
    }
    return dependencies;
  }

  function installRuntimeAdapter(candidate) {
    if (!candidate || typeof candidate !== "object") throw new TypeError("Playback refresh runtime adapter is required");
    if (typeof candidate.refresh !== "function") throw new TypeError("Playback refresh runtime adapter must expose refresh(changeSet)");
    if (typeof candidate.refreshLegacy !== "function") throw new TypeError("Playback refresh runtime adapter must expose refreshLegacy(details)");
    const owner = String(candidate.owner ?? "runtime-adapter").trim() || "runtime-adapter";
    runtimeAdapter = Object.freeze({ ...candidate, owner });
    metrics.adapterInstalls += 1;
    return runtimeAdapter;
  }

  // I0 compatibility contract: state.currentSequence remains a Store-backed mirror; this module never assigns it.
  // A4B2: even before the later I1 adapter installs, Song refresh must compile through
  // the same production EventPlan compiler as P3.6. There is no preview Instrument fallback.
  function fallbackBuildSongPlan(anchorRow) {
    const { songPolicy, eventCompiler } = requireDependencies();
    return eventCompiler.compileSongPlan({
      model,
      songPolicy,
      origin: {
        songRow: anchorRow,
        track: state.track,
        chainId: state.chain,
        chainRow: 0,
        phraseId: state.phrase,
      },
      continueFromChain: false,
      trackCount: TRACKS,
    });
  }

  function fallbackRefreshLinear(source = "project-store-linear-refresh") {
    const { transportRuntime } = requireDependencies();
    const current = transportRuntime.getProgram();
    const scope = current?.scope ?? state.scope;
    const next = buildSequence(scope);
    if (!next.steps.length) {
      stopPlayback();
      return false;
    }
    const request = transportRuntime.requestUpdate(next, { source });
    audio.updateSequence?.(next.steps, request.identity);
    metrics.linearApplied += 1;
    return true;
  }

  function fallbackRefreshTrackPlan(source = "project-store-track-plan-refresh") {
    const { transportRuntime } = requireDependencies();
    const current = transportRuntime.getProgram();
    const anchorRow = current?.origin?.songRow ?? state.songRow;
    const next = fallbackBuildSongPlan(anchorRow);
    if (!next.active) {
      stopPlayback();
      return false;
    }
    const request = transportRuntime.requestUpdate(next, { source });
    audio.updatePlan?.(next, request.identity);
    metrics.trackPlanApplied += 1;
    return true;
  }

  function fallbackScheduleRefresh({ requirePlaybackChange, changeSet = {}, source }) {
    window.clearTimeout(refreshTimer);
    refreshTimer = 0;
    const { transportRuntime } = requireDependencies();
    const current = transportRuntime.getProgram();
    if ((requirePlaybackChange && !changeSet.affectsPlayback) || !transportRuntime.isPlaying() || !current) {
      metrics.skipped += 1;
      return false;
    }
    metrics.scheduled += 1;
    metrics.lastSource = source;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      const activeRuntime = resolveDependencies().transportRuntime;
      const active = activeRuntime?.getProgram?.() ?? null;
      if (!activeRuntime?.isPlaying?.() || !active) return;
      if (active.mode === "track-plan") fallbackRefreshTrackPlan(source);
      else fallbackRefreshLinear(source);
    }, current.mode === "track-plan" ? 32 : 24);
    return true;
  }

  function delegate(method, ...args) {
    const target = runtimeAdapter?.[method];
    if (typeof target !== "function") return undefined;
    metrics.adapterDelegations += 1;
    return target(...args);
  }

  function refresh(changeSet = {}) {
    // A non-structural change never re-plans playback, whichever subscriber
    // routed it here. This owner refuses it before the adapter delegation so a
    // live Instrument parameter can never reach updatePlan/prepareProgram
    // through an alternative caller.
    metrics.projectRequests += 1;
    if (changeSet?.structuralPlayback === false) {
      metrics.nonStructuralRejected += 1;
      metrics.skipped += 1;
      return false;
    }
    if (runtimeAdapter) return delegate("refresh", changeSet);
    return fallbackScheduleRefresh({
      requirePlaybackChange: true,
      changeSet,
      source: "project-store-playback-refresh",
    });
  }

  function refreshLegacy(details = {}) {
    metrics.legacyRequests += 1;
    if (runtimeAdapter) return delegate("refreshLegacy", details);
    return fallbackScheduleRefresh({
      requirePlaybackChange: false,
      source: String(details.source ?? "legacy-compat-playback-refresh"),
    });
  }

  function refreshLinear(source = "project-store-linear-refresh") {
    if (runtimeAdapter?.refreshLinear) return delegate("refreshLinear", source);
    return fallbackRefreshLinear(source);
  }

  function refreshTrackPlan(source = "project-store-track-plan-refresh") {
    if (runtimeAdapter?.refreshTrackPlan) return delegate("refreshTrackPlan", source);
    return fallbackRefreshTrackPlan(source);
  }

  function refreshQueuedProgram(...args) {
    if (runtimeAdapter?.refreshQueuedProgram) return delegate("refreshQueuedProgram", ...args);
    return false;
  }

  function buildSongPlan(anchorRow = state.songRow) {
    if (runtimeAdapter?.buildSongPlan) return delegate("buildSongPlan", anchorRow);
    return fallbackBuildSongPlan(anchorRow);
  }

  function snapshot() {
    const dependencies = resolveDependencies();
    return Object.freeze({
      version: 2,
      owner: "project-playback-refresh",
      runtimeAdapterOwner: runtimeAdapter?.owner ?? null,
      timerPending: refreshTimer !== 0,
      dependencies: Object.freeze({
        songPolicy: Boolean(dependencies.songPolicy),
        transportRuntime: Boolean(dependencies.transportRuntime),
        eventCompiler: Boolean(dependencies.eventCompiler),
      }),
      ...metrics,
    });
  }

  const api = Object.freeze({
    installRuntimeAdapter,
    refresh,
    refreshLegacy,
    refreshLinear,
    refreshTrackPlan,
    refreshQueuedProgram,
    buildSongPlan,
    resolveDependencies,
    snapshot,
  });
  globalThis.BRKTRKProjectPlaybackRefresh = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
