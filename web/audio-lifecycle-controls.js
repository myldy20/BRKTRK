(() => {
  const lifecycle = globalThis.BRKTRKAudioLifecycle;
  const transportStore = globalThis.BRKTRKStores?.transport;
  const runtime = transportStore?.runtime;
  const transport = globalThis.BRKTRKTransport;
  if (!lifecycle || !runtime || !transport || typeof togglePlayback !== "function") {
    throw new Error("Audio lifecycle controls require lifecycle, transport runtime and I1 transport");
  }
  if (globalThis.BRKTRKAudioLifecycleControls) return;

  const inheritedTogglePlayback = togglePlayback;
  const inheritedOnStep = audio.onStep;
  const inheritedOnMeter = audio.onMeter;
  const FOREGROUND_COALESCE_MS = 1400;
  let coalesceUntil = 0;
  let pendingStep = null;
  let pendingMeter = null;
  let stepFrame = 0;
  let meterFrame = 0;
  let recoveryTimer = 0;
  let recoveryPromise = null;
  let episodeSerial = 0;
  let episode = null;

  function originFromState() {
    return Object.freeze({
      songRow: state.songRow,
      track: state.track,
      chainId: state.chain,
      chainRow: state.chainRow,
      phraseId: state.phrase,
    });
  }

  function hasContent(program) {
    if (program?.mode === "track-plan") return program.active === true;
    return Array.isArray(program?.steps) && program.steps.length > 0;
  }

  function sendStart(program, request) {
    if (program.mode === "track-plan") audio.playPlan(program, model.tempo, request.identity);
    else audio.play(program.steps, model.tempo, request.identity);
  }

  async function restartDuringPendingStop(forceSong) {
    await lifecycle.ensureReady("transport-restart-during-stop");
    const scope = forceSong ? "song" : state.scope;
    const program = transport.buildProgram(scope, {
      origin: originFromState(),
      continueFromChain: forceSong && (state.p3?.activeWorkspace ?? state.view) !== "song",
    });
    if (!hasContent(program)) {
      setStatus("NOTHING TO PLAY", "amber");
      return false;
    }
    transport.cancelI1Queue?.("audio-lifecycle-restart-cancel-queue");
    state.p36.queue = null;
    state.queued = null;
    const request = runtime.requestStart(program, { source: "audio-lifecycle-restart" });
    sendStart(program, request);
    $("#playButton")?.setAttribute("aria-pressed", "true");
    setStatus(`RESTARTING ${scope.toUpperCase()} · V${request.identity.version}`, "amber");
    renderAll();
    return request;
  }

  async function lifecycleTogglePlayback(forceSong = false) {
    const runtimeBefore = runtime.snapshot();

    if (runtimeBefore.phase === "stopping") return restartDuringPendingStop(forceSong);

    // The outer lifecycle wrapper must preserve the transport owner's normal
    // Play/Stop meaning. If transport is already playing, a non-forceSong
    // toggle is STOP even when the AudioContext is suspended/interrupted or
    // canonical package readiness is currently invalid. The inherited I1
    // transport owns that readiness-independent stop escape hatch.
    if (runtime.isPlaying() && !forceSong) return inheritedTogglePlayback(false);

    return inheritedTogglePlayback(forceSong);
  }

  function currentEpisode() {
    if (!episode) return null;
    return Object.freeze({ ...episode });
  }

  function shouldCoalesceRuntimeReports() {
    return document.visibilityState === "hidden" || performance.now() < coalesceUntil;
  }

  function flushStep() {
    stepFrame = 0;
    const pending = pendingStep;
    pendingStep = null;
    if (!pending || typeof inheritedOnStep !== "function") return false;
    inheritedOnStep(...pending);
    if (episode) episode.stepAfterRecovery = runtime.snapshot().globalStep;
    return true;
  }

  function flushMeter() {
    meterFrame = 0;
    const pending = pendingMeter;
    pendingMeter = null;
    if (!pending || typeof inheritedOnMeter !== "function") return false;
    inheritedOnMeter(...pending);
    return true;
  }

  function scheduleFlushes() {
    if (document.visibilityState === "hidden") return;
    if (pendingStep && !stepFrame) stepFrame = requestAnimationFrame(flushStep);
    if (pendingMeter && !meterFrame) meterFrame = requestAnimationFrame(flushMeter);
  }

  audio.onStep = function lifecycleAwareStep(index, trackSteps = null, transportIdentity = null) {
    // A pending Song queue needs every boundary report. In the ordinary case,
    // hidden/foreground bursts are presentation/position backlog and may be
    // collapsed to the newest report without touching Worklet musical timing.
    if (!shouldCoalesceRuntimeReports() || state.p36?.queue) {
      return inheritedOnStep?.(index, trackSteps, transportIdentity);
    }
    if (pendingStep && episode) episode.coalescedStepReports += 1;
    pendingStep = [index, trackSteps, transportIdentity];
    scheduleFlushes();
    return true;
  };

  audio.onMeter = function lifecycleAwareMeter(left, right) {
    if (!shouldCoalesceRuntimeReports()) return inheritedOnMeter?.(left, right);
    if (pendingMeter && episode) episode.coalescedMeterReports += 1;
    pendingMeter = [left, right];
    scheduleFlushes();
    return true;
  };

  function captureHidden(source = "visibility-hidden") {
    if (episode?.active) return currentEpisode();
    const lifecycleState = lifecycle.snapshot();
    const runtimeState = runtime.snapshot();
    episode = {
      version: 1,
      id: ++episodeSerial,
      active: true,
      source,
      hiddenAt: new Date().toISOString(),
      visibleAt: null,
      hiddenDurationMs: null,
      transportVersion: runtimeState.version,
      playingAtHidden: runtime.isPlaying(),
      stepBeforeHidden: runtimeState.globalStep,
      stepAfterRecovery: runtimeState.globalStep,
      contextBefore: lifecycleState.contextState,
      contextAfter: lifecycleState.contextState,
      ensureReadyAttempted: false,
      ensureReadySucceeded: false,
      coalescedStepReports: 0,
      coalescedMeterReports: 0,
      queueBypass: Boolean(state.p36?.queue),
      error: null,
      hiddenEpochMs: Date.now(),
    };
    coalesceUntil = Number.POSITIVE_INFINITY;
    return currentEpisode();
  }

  async function recoverForeground(source = "visibility-visible") {
    if (recoveryPromise) return recoveryPromise;
    if (!episode?.active) captureHidden("foreground-without-hidden-event");
    const activeEpisode = episode;
    activeEpisode.source = `${activeEpisode.source} → ${source}`;
    activeEpisode.visibleAt = new Date().toISOString();
    activeEpisode.hiddenDurationMs = Math.max(0, Date.now() - activeEpisode.hiddenEpochMs);
    activeEpisode.contextAfter = lifecycle.snapshot().contextState;
    coalesceUntil = performance.now() + FOREGROUND_COALESCE_MS;
    scheduleFlushes();

    recoveryPromise = (async () => {
      if (runtime.isPlaying()) {
        activeEpisode.ensureReadyAttempted = true;
        try {
          await lifecycle.ensureReady("foreground-playing-recovery");
          activeEpisode.ensureReadySucceeded = true;
          activeEpisode.contextAfter = lifecycle.snapshot().contextState;
        } catch (error) {
          activeEpisode.error = error instanceof Error ? error.message : String(error);
        }
      }
      window.clearTimeout(recoveryTimer);
      recoveryTimer = window.setTimeout(() => {
        if (episode !== activeEpisode) return;
        coalesceUntil = 0;
        flushStep();
        flushMeter();
        activeEpisode.stepAfterRecovery = runtime.snapshot().globalStep;
        activeEpisode.contextAfter = lifecycle.snapshot().contextState;
        activeEpisode.active = false;
      }, FOREGROUND_COALESCE_MS + 80);
      return currentEpisode();
    })().finally(() => { recoveryPromise = null; });
    return recoveryPromise;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") captureHidden("document-visibilitychange");
    else recoverForeground("document-visibilitychange");
  });
  window.addEventListener("pagehide", () => captureHidden("window-pagehide"));
  window.addEventListener("pageshow", () => {
    if (document.visibilityState !== "hidden" && episode?.active) recoverForeground("window-pageshow");
  });

  togglePlayback = lifecycleTogglePlayback;
  const api = Object.freeze({
    toggle: lifecycleTogglePlayback,
    restartDuringPendingStop,
    captureHidden,
    recoverForeground,
    flushPendingReports() {
      flushStep();
      flushMeter();
      return currentEpisode();
    },
    snapshot: currentEpisode,
    constants: Object.freeze({ FOREGROUND_COALESCE_MS }),
  });
  globalThis.BRKTRKAudioLifecycleControls = api;
  globalThis.BRKTRKDiagnostics?.registerSection?.("audioForegroundRecovery", () => api.snapshot());
  document.body.dataset.audioLifecycleControls = "newest-intent-authoritative";
})();