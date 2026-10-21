(() => {
  const songPolicy = globalThis.BRKTRKSongTransportPolicy;
  const projectPolicy = globalThis.BRKTRKProjectTransportPolicy;
  const contextPolicy = globalThis.BRKTRKPlaybackContextPolicy;
  const compiler = globalThis.BRKTRKEventPlanCompiler;
  const p35 = globalThis.BRKTRKPlaybackContext;
  const entryState = globalThis.BRKTRKCommands?.stores?.navigation?.entryState;
  const transportRuntime = globalThis.BRKTRKStores?.transport?.runtime;
  if (!songPolicy || !projectPolicy || !contextPolicy || !compiler || !p35 || !entryState || !transportRuntime) {
    throw new Error("P3.6/P3.7 transport, EventPlanCompiler, TransportStore and NavigationStore entry dependencies are required");
  }

  const STRUCTURAL = new Set(["song", "chain", "phrase"]);
  const inheritedAudioInit = audio.init.bind(audio);
  let planRefreshTimer = 0;

  state.p36 = { queue: null };
  Object.defineProperties(state.p36, {
    globalStep: {
      enumerable: true,
      get: () => transportRuntime.snapshot().globalStep,
    },
    lastTrackSteps: {
      enumerable: true,
      get: () => [...transportRuntime.snapshot().trackPositions],
    },
  });

  function currentProgram() {
    return transportRuntime.getProgram();
  }

  function currentStructuralPane() {
    const workspace = state.p3?.activeWorkspace ?? state.view;
    if (STRUCTURAL.has(workspace)) return workspace;
    return STRUCTURAL.has(state.focus?.pane) ? state.focus.pane : "phrase";
  }

  function transportSnapshot() {
    return projectPolicy.normalizeTransport({
      followPlayhead: state.p35?.followPlayhead,
      scopeLocked: state.p35?.scopeLocked,
      lockedScope: state.p35?.lockedScope,
    });
  }

  function syncTransportToModel() {
    updateMobilePolicyUi();
    return transportSnapshot();
  }

  function applyTransport(candidate) {
    const next = projectPolicy.normalizeTransport(candidate);
    state.p35.followPlayhead = next.followPlayhead;
    state.p35.scopeLocked = next.scopeLocked;
    state.p35.lockedScope = next.lockedScope;
    p35.syncAutoScope();
    updateMobilePolicyUi();
    return next;
  }

  function bindAudioPort() {
    if (!audio.node?.port || audio.node.__p36PortBound) return;
    audio.node.__p36PortBound = true;
    audio.node.port.onmessage = ({ data }) => {
      if (globalThis.BRKTRKAudioReadiness?.snapshot?.().terminalError) return;
      if (data.type === "transport-ready") transportRuntime.markWorkletReady({ source: "audio-worklet-ready" });
      if (data.type === "transport-applied") {
        transportRuntime.acknowledgeApplied(data, { source: "audio-worklet-applied" });
      }
      if (data.type === "step") audio.onStep(data.index, data.trackSteps ?? null, data.transport ?? null);
      if (data.type === "meter") audio.onMeter(data.left, data.right);
      if (data.type === "production-transport-rejected") {
        const code = String(data.code ?? "production-program-error");
        const message = String(data.message ?? code);
        if (data.stoppedTransport === false) {
          if (data.deferredUpdate === true
            && !transportRuntime.acknowledgeDeferred(data, { source: "production-transport-deferred" }).accepted) return;
          setStatus(`PROJECT EDITS PENDING · STOP → PLAY · ${message.slice(0, 120)}`, "amber");
          return;
        }
        transportRuntime.markWorkletError(new Error(message), { source: "production-transport-rejected", code });
        state.p36.queue = null;
        state.queued = null;
        $("#playButton")?.setAttribute("aria-pressed", "false");
        audio.onStep(-1, null, data.transport ?? null);
        setStatus(`PLAYBACK REJECTED · ${message.slice(0, 160)}`, "amber");
        renderAll();
      }
      // The Worklet stops transport itself when the production render path
      // throws, and says why just before its stop acknowledgement. Name that
      // reason; a bare stop is what made #496 item 2 undiagnosable. The
      // engine host keeps the durable record for the debug snapshot.
      if (data.type === "production-engine-error" && data.stoppedTransport === true) {
        const failure = globalThis.BRKTRKProductionEngineHost?.failureStatus?.(data);
        if (failure) setStatus(failure.text, failure.tone);
      }
      if (data.type === "transport-stopped" || data.type === "stopped") {
        transportRuntime.acknowledgeStopped(data, { source: "audio-worklet-stopped" });
        audio.onStep(-1, null, data.transport ?? null);
      }
    };
    transportRuntime.markWorkletReady({ source: "audio-port-bound" });
  }

  // Subscribe before the first init. BrowserAudio reports processorerror before
  // the graph is resumed, including crashes while package readiness is pending.
  globalThis.BRKTRKAudioReadiness?.subscribe?.((event) => {
    if (event.type !== "terminal-failed") return;
    const message = String(event.error ?? "AudioWorkletProcessor stopped")
      .replace(/;\s*reload BRKTRK to restore audio$/, "");
    transportRuntime.markWorkletError(new Error(message), {
      source: "audio-worklet-processorerror", code: "worklet-processor-error", terminal: true,
    });
    globalThis.BRKTRKTransport?.cancelI1Queue?.("audio-worklet-processorerror");
    state.p36.queue = null;
    state.queued = null;
    $("#playButton")?.setAttribute("aria-pressed", "false");
    audio.onStep(-1, null, null);
    audio.onMeter(0, 0);
    const failure = globalThis.BRKTRKProductionEngineHost?.failureStatus?.({ source: "processorerror", message });
    setStatus(`${failure?.text ?? `AUDIO PROCESSOR STOPPED · ${message.slice(0, 140)}`} · RELOAD APP`, failure?.tone ?? "danger");
    renderAll();
  });

  audio.init = async function p36AudioInit() {
    try {
      await inheritedAudioInit();
      bindAudioPort();
    } catch (error) {
      transportRuntime.markWorkletError(error, { source: "audio-init" });
      throw error;
    }
  };

  audio.play = function p36PlaySequence(sequence, tempo, transport) {
    if (!this.ready || !this.node) return;
    this.node.port.postMessage({ type: "play", sequence, tempo, transport });
  };

  audio.playPlan = function p36PlayPlan(plan, tempo, transport) {
    if (!this.ready || !this.node) return;
    this.node.port.postMessage({ type: "play-plan", plan, tempo, transport });
  };

  audio.updateSequence = function p36UpdateSequence(sequence, transport) {
    if (!this.ready || !this.node) return;
    this.node.port.postMessage({ type: "update-sequence", sequence, transport });
  };

  audio.updatePlan = function p36UpdatePlan(plan, transport) {
    if (!this.ready || !this.node) return;
    this.node.port.postMessage({ type: "update-plan", plan, transport });
  };

  audio.stop = function p36AudioStop(transport) {
    if (!this.ready || !this.node) return;
    this.node.port.postMessage({ type: "stop", transport });
  };

  if (audio.ready) bindAudioPort();

  function buildSongPlan({ continueFromChain = false, anchorRow = state.songRow } = {}) {
    return compiler.compileSongPlan({
      model,
      songPolicy,
      origin: {
        songRow: anchorRow,
        track: state.track,
        chainId: state.chain,
        chainRow: continueFromChain ? state.chainRow : 0,
        phraseId: state.phrase,
      },
      continueFromChain,
      trackCount: TRACKS,
    });
  }

  function sequenceHasContent(sequence) {
    if (sequence?.mode === "track-plan") return sequence.active === true;
    return Array.isArray(sequence?.steps) && sequence.steps.length > 0;
  }

  function startSequence(sequence, status) {
    if (!sequenceHasContent(sequence)) {
      setStatus("NOTHING TO PLAY", "amber");
      return false;
    }
    const request = transportRuntime.requestStart(sequence, { source: "p36-start" });
    state.queued = null;
    state.p36.queue = null;
    $("#playButton")?.setAttribute("aria-pressed", "true");
    if (sequence.mode === "track-plan") audio.playPlan(sequence, model.tempo, request.identity);
    else audio.play(sequence.steps, model.tempo, request.identity);
    setStatus(status ?? `PLAY ${sequence.scope.toUpperCase()} · PRODUCTION AUDIO`);
    renderAll();
    return true;
  }

  function queueSongPlan(plan) {
    if (!sequenceHasContent(plan)) {
      setStatus("NOTHING TO QUEUE", "amber");
      return false;
    }
    const currentPlan = currentProgram()?.mode === "track-plan" ? currentProgram() : null;
    const preferred = currentPlan?.tracks?.[state.track]?.active ? state.track : -1;
    const fallback = currentPlan?.tracks?.findIndex?.((program) => program.active) ?? -1;
    const boundaryTrack = preferred >= 0 ? preferred : fallback >= 0 ? fallback : state.track;
    state.p36.queue = {
      plan,
      requestedAfter: transportRuntime.snapshot().globalStep,
      boundaryTrack,
      requestedTrack: state.track,
      row: state.songRow,
      chain: model.song?.[state.songRow]?.[state.track] ?? EMPTY,
    };
    state.queued = { pane: "song", row: state.songRow, track: state.track };
    setStatus(`QUEUE T${state.track + 1} · S${hex(state.songRow)} · NEXT PHRASE`, "amber");
    renderAll();
    return true;
  }

  function boundaryReached(index, trackSteps) {
    const queued = state.p36.queue;
    if (!queued || index <= queued.requestedAfter) return false;
    const current = currentProgram();
    if (current?.mode === "track-plan") {
      const program = current.tracks?.[queued.boundaryTrack];
      const step = trackSteps?.[queued.boundaryTrack];
      if (program?.active && Number.isInteger(step)) return songPolicy.phraseBoundary(program, step);
    }
    return state.playhead?.phraseRow === 0;
  }

  function commitQueue() {
    const queued = state.p36.queue;
    if (!queued) return false;
    state.p36.queue = null;
    state.queued = null;
    startSequence(queued.plan, `QUEUE COMMITTED · SONG S${hex(queued.row)}`);
    return true;
  }

  togglePlayback = async function p36TogglePlayback(forceSong = false) {
    // Stopping an already allocated/running graph is always available. A
    // package revalidation failure may revoke canonical READY, but it must
    // never trap the user in playback by making STOP wait for those gates.
    if (transportRuntime.isPlaying() && !forceSong) {
      stopPlayback();
      return;
    }

    await audio.init();
    if (transportRuntime.isPlaying()) {
      if (forceSong) {
        queueSongPlan(buildSongPlan({ continueFromChain: currentStructuralPane() !== "song" }));
      } else {
        stopPlayback();
      }
      return;
    }

    const scope = forceSong ? "song" : state.scope;
    if (scope === "song") {
      startSequence(
        buildSongPlan({ continueFromChain: forceSong && currentStructuralPane() !== "song" }),
        forceSong ? `CONTINUE SONG · S${hex(state.songRow)} · C${hex(state.chain)}:${hex(state.chainRow)}` : `PLAY SONG · S${hex(state.songRow)}`,
      );
      return;
    }
    startSequence(buildSequence(scope));
  };

  stopPlayback = function p36StopPlayback() {
    state.p36.queue = null;
    state.queued = null;
    const request = transportRuntime.requestStop({ source: "p36-stop" });
    if (!request.mutated && transportRuntime.snapshot().worklet.terminal) {
      setStatus("AUDIO PROCESSOR STOPPED · RELOAD APP", "danger");
      return;
    }
    audio.stop(request.identity);
    p35.handleStep(-1);
    $("#playButton")?.setAttribute("aria-pressed", "false");
    setStatus("STOPPED", "muted");
    renderAll();
  };

  function contextFromPlan(index, trackSteps) {
    const plan = currentProgram();
    if (plan?.mode !== "track-plan") return null;
    const track = clamp(state.track, 0, TRACKS - 1);
    const program = plan.tracks?.[track];
    const positions = transportRuntime.snapshot().trackPositions;
    const stepIndex = Number.isInteger(trackSteps?.[track])
      ? trackSteps[track]
      : positions[track];
    const structural = songPolicy.contextAt(program, stepIndex);
    if (!structural) {
      return Object.freeze({
        step: index,
        scope: "song",
        track,
        songRow: -1,
        chainId: EMPTY,
        chainRow: -1,
        phraseId: EMPTY,
        phraseRow: -1,
        transpose: 0,
        sourceNote: EMPTY,
        effectiveNote: EMPTY,
        noteOff: false,
        silent: true,
        occurrenceKey: `silent:${track}`,
      });
    }
    const source = model.phrases?.[structural.phraseId]?.[structural.phraseRow]
      ?? { note: EMPTY };
    const sourceNote = Number.isFinite(source.note) ? source.note : EMPTY;
    const effectiveNote = sourceNote >= 0 ? clamp(sourceNote + structural.transpose, 0, 127) : sourceNote;
    return Object.freeze({
      ...structural,
      step: index,
      scope: "song",
      track,
      sourceNote,
      effectiveNote,
      noteOff: sourceNote === NOTE_OFF,
      silent: false,
      occurrenceKey: `${structural.songRow}:${track}:${structural.chainId}:${structural.chainRow}:${structural.phraseId}`,
    });
  }

  function syncVisibleContext(context) {
    if (!context || context.silent || context.chainId < 0 || context.phraseId < 0) return false;
    let changed = false;
    const assign = (key, value) => {
      if (state[key] !== value) {
        state[key] = value;
        changed = true;
      }
    };
    assign("songRow", context.songRow);
    assign("chain", context.chainId);
    assign("chainRow", context.chainRow);
    assign("phrase", context.phraseId);
    state.lastChain = context.chainId;
    state.lastPhrase = context.phraseId;
    return changed;
  }

  function scrollToContext(context) {
    if (!context || context.silent) return;
    const pane = currentStructuralPane();
    const row = pane === "song"
      ? context.songRow
      : pane === "chain" && state.chain === context.chainId
        ? context.chainRow
        : pane === "phrase" && state.phrase === context.phraseId
          ? context.phraseRow
          : -1;
    if (row < 0) return;
    $(`[data-row-pane="${pane}"][data-row="${row}"]`)?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  function setPlanPlayhead(index, trackSteps) {
    const context = contextFromPlan(index, trackSteps);
    state.playhead = {
      step: index,
      songRow: context?.songRow ?? -1,
      chainRow: context?.chainRow ?? -1,
      phraseRow: context?.phraseRow ?? -1,
      chainId: context?.chainId ?? EMPTY,
      phraseId: context?.phraseId ?? EMPTY,
      transpose: context?.transpose ?? 0,
      sourceNote: context?.sourceNote ?? EMPTY,
      effectiveNote: context?.effectiveNote ?? EMPTY,
      context,
    };
    const shouldFollow = state.p35?.followPlayhead && !p35.isEditing();
    if (shouldFollow && syncVisibleContext(context)) renderAll();
    renderPlayheads();
    const label = $("#p35PlaybackContext");
    if (label) {
      label.dataset.silent = String(Boolean(context?.silent));
      label.dataset.match = context?.silent ? "silent" : state.phrase === context?.phraseId ? "current" : "other";
    }
    if (shouldFollow) requestAnimationFrame(() => scrollToContext(context));
  }

  function handleStep(index, trackSteps = null, transport = null) {
    if (index < 0) {
      p35.handleStep(index);
      return true;
    }
    const report = transportRuntime.reportStep({
      index,
      trackSteps,
      transport: transport ?? transportRuntime.getAppliedIdentity() ?? transportRuntime.getRequestedIdentity(),
    }, { source: "audio-worklet-step" });
    if (!report.accepted) return false;

    if (currentProgram()?.mode === "track-plan") setPlanPlayhead(index, trackSteps);
    else p35.handleStep(index);

    if (boundaryReached(index, trackSteps)) commitQueue();
    return true;
  }

  audio.onStep = handleStep;

  function rebuildRunningPlan() {
    window.clearTimeout(planRefreshTimer);
    const current = currentProgram();
    if (!transportRuntime.isPlaying() || current?.mode !== "track-plan") return;
    planRefreshTimer = window.setTimeout(() => {
      const active = currentProgram();
      if (!transportRuntime.isPlaying() || active?.mode !== "track-plan") return;
      const next = buildSongPlan({ continueFromChain: false, anchorRow: active.origin?.songRow ?? state.songRow });
      if (!next.active) {
        stopPlayback();
        return;
      }
      const request = transportRuntime.requestUpdate(next, { source: "legacy-project-refresh" });
      audio.updatePlan(next, request.identity);
    }, 32);
  }

  function decorateQueue() {
    $$(".p36-queue-marker").forEach((node) => node.remove());
    $$(".p36-queued-cell").forEach((node) => node.classList.remove("p36-queued-cell"));
    const queued = state.p36.queue;
    if (!queued) return;
    const cell = $(`[data-pane="song"][data-row="${queued.row}"][data-col="${queued.requestedTrack ?? queued.boundaryTrack}"]`);
    if (!cell) return;
    cell.classList.add("p36-queued-cell");
    const marker = document.createElement("span");
    marker.className = "p36-queue-marker";
    marker.textContent = "Q";
    marker.title = "Queued song occurrence; commits at the next phrase boundary";
    cell.append(marker);
  }

  function updateMobilePolicyUi() {
    const button = $("#p36MobilePolicyButton");
    const follow = state.p35?.followHeld ? "HOLD" : state.p35?.followPlayhead ? "FOLLOW" : "FIXED";
    if (button) {
      const scope = state.p35?.scopeLocked ? state.p35.lockedScope.toUpperCase() : "AUTO";
      button.innerHTML = `<b>${scope}</b><small>${follow}</small>`;
      button.dataset.followState = follow.toLowerCase();
      const visibleFollow = follow === "HOLD" ? "PAUSED" : follow === "FIXED" ? "MANUAL" : "FOLLOW";
      button.setAttribute("aria-label", `${scope} · ${visibleFollow}`);
      button.setAttribute("aria-expanded", String(entryState.getActiveSheet() === "follow-scope"));
    }
    const panel = $("#p36MobilePolicyPanel");
    if (!panel) return;
    const followButton = $("#p36MobileFollow");
    if (followButton) {
      followButton.textContent = state.p35?.followHeld
        ? "RESUME VIEW FOLLOW"
        : state.p35?.followPlayhead ? "VIEW FOLLOWS PLAYBACK" : "VIEW STAYS PUT";
      followButton.setAttribute("aria-label", state.p35?.followHeld
        ? "RESUME FOLLOWING"
        : state.p35?.followPlayhead ? "FOLLOW PLAYBACK · ON" : "FOLLOW PLAYBACK · OFF");
      followButton.setAttribute("aria-pressed", String(Boolean(state.p35?.followPlayhead)));
      followButton.dataset.followState = follow.toLowerCase();
    }
    $("#p36MobileAuto").setAttribute("aria-pressed", String(!state.p35?.scopeLocked));
    $$("#p36MobilePolicyPanel [data-lock-scope]").forEach((control) => {
      control.setAttribute("aria-pressed", String(Boolean(state.p35?.scopeLocked && state.p35.lockedScope === control.dataset.lockScope)));
    });
  }

  function closeMobilePolicy() {
    return entryState.closeSheet("follow-scope", { source: "follow-scope-close" });
  }

  function renderNavigationState(activeSheet = entryState.getActiveSheet()) {
    if (activeSheet === "follow-scope") updateMobilePolicyUi();
  }

  function injectMobilePolicy() {
    if ($("#p36MobilePolicyButton")) return;
    const button = document.createElement("button");
    button.id = "p36MobilePolicyButton";
    button.className = "p36-mobile-policy-button";
    button.type = "button";
    button.setAttribute("aria-label", "Play scope and editor view behavior");
    button.setAttribute("aria-expanded", "false");
    $(".transport-cluster")?.append(button);

    const panel = document.createElement("section");
    panel.id = "p36MobilePolicyPanel";
    panel.className = "p36-mobile-policy-panel";
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
      <header><div><span>PLAYBACK</span><strong>PLAY SCOPE &amp; VIEW</strong></div><button id="p36MobilePolicyClose" type="button" aria-label="Close playback policy">×</button></header>
      <button id="p36MobileFollow" type="button">VIEW STAYS PUT</button>
      <div class="p36-mobile-scope-grid">
        <button id="p36MobileAuto" type="button">AUTO</button>
        <button type="button" data-lock-scope="song">SONG</button>
        <button type="button" data-lock-scope="chain">CHAIN</button>
        <button type="button" data-lock-scope="phrase">PHRASE</button>
      </div>
      <p>AUTO plays the active Song, Chain or Phrase editor. A named scope fixes what Play starts for this session. FOLLOW PLAYBACK moves the editor with playback. PAUSED means manual browsing has temporarily paused following; choose RESUME FOLLOWING to continue. MANUAL keeps the editor where you put it.</p>`;
    document.body.append(panel);

    button.addEventListener("click", () => {
      if (entryState.getActiveSheet() === "follow-scope") closeMobilePolicy();
      else entryState.openSheet("follow-scope", { source: "follow-scope-open" });
    });
    $("#p36MobilePolicyClose").addEventListener("click", closeMobilePolicy);
    $("#p36MobileFollow").addEventListener("click", () => {
      const livePlaybackContext = globalThis.BRKTRKPlaybackContext;
      if (state.p35?.followHeld && livePlaybackContext?.resumeFollow) {
        livePlaybackContext.resumeFollow("phone-follow-button");
      } else {
        p35.setFollow(!state.p35.followPlayhead);
      }
      syncTransportToModel();
      updateMobilePolicyUi();
    });
    $("#p36MobileAuto").addEventListener("click", () => {
      p35.setScopeLocked(false, state.scope);
      syncTransportToModel();
    });
    panel.addEventListener("click", (event) => {
      const scope = event.target.closest("[data-lock-scope]")?.dataset.lockScope;
      if (!scope) return;
      p35.setScopeLocked(true, scope);
      syncTransportToModel();
    });
    updateMobilePolicyUi();
    globalThis.BRKTRKStoreRuntime?.navigationSubscribers?.refreshActiveSheet?.();
  }

  injectMobilePolicy();
  applyTransport(state.p35);
  syncTransportToModel();
  renderAll();
  document.body.dataset.playbackArchitecture = "p3.7";

  globalThis.BRKTRKTransport = Object.freeze({
    buildSongPlan,
    queueSongPlan,
    commitQueue,
    handleStep,
    contextFromPlan,
    syncTransportToModel,
    closeMobilePolicy,
    renderNavigationState,
    refreshPolicyUi: updateMobilePolicyUi,
    runtimeSnapshot: transportRuntime.snapshot,
  });
})();
