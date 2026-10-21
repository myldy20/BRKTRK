(() => {
  const compiler = globalThis.BRKTRKEventPlanCompiler;
  const queueDomain = globalThis.BRKTRKI1TransportDomain;
  const songPolicy = globalThis.BRKTRKSongTransportPolicy;
  const p35 = globalThis.BRKTRKPlaybackContext;
  const transportStore = globalThis.BRKTRKStores?.transport;
  const runtime = transportStore?.runtime;
  const legacyTransport = globalThis.BRKTRKTransport;
  const playbackRefreshOwner = globalThis.BRKTRKProjectPlaybackRefresh;
  const renderRuntime = globalThis.BRKTRKRenderRuntime;
  if (!compiler || !queueDomain || !songPolicy || !p35 || !transportStore || !runtime || !legacyTransport
      || !playbackRefreshOwner?.installRuntimeAdapter || !renderRuntime?.registerAfterRender) {
    throw new Error("I1 transport requires compiler, queue domain, Song policy, P3.5 context, TransportStore runtime, ProjectPlaybackRefresh owner and render runtime");
  }

  const STRUCTURAL = new Set(["song", "chain", "phrase"]);
  const queue = queueDomain.install(transportStore, runtime);
  const programByIdentity = new Map();
  let appliedProgram = runtime.snapshot().applied ? runtime.getProgram() : null;
  let refreshTimer = 0;
  let deferredRefresh = false;
  let acceptedStepReportSerial = 0;

  function identityKey(identity) {
    return identity ? `${identity.id}:${identity.version}` : "";
  }

  function registerRequest(request, program) {
    if (request?.identity) programByIdentity.set(identityKey(request.identity), program);
    return request;
  }

  function currentStructuralPane() {
    const workspace = state.p3?.activeWorkspace ?? state.view;
    if (STRUCTURAL.has(workspace)) return workspace;
    return STRUCTURAL.has(state.focus?.pane) ? state.focus.pane : "phrase";
  }

  function originFromState(overrides = {}) {
    return Object.freeze({
      songRow: Number.isInteger(overrides.songRow) ? overrides.songRow : Number.isInteger(overrides.anchorRow) ? overrides.anchorRow : state.songRow,
      track: Number.isInteger(overrides.track) ? overrides.track : state.track,
      chainId: Number.isInteger(overrides.chainId) ? overrides.chainId : state.chain,
      chainRow: Number.isInteger(overrides.chainRow) ? overrides.chainRow : state.chainRow,
      phraseId: Number.isInteger(overrides.phraseId) ? overrides.phraseId : state.phrase,
    });
  }

  function sequenceHasContent(program) {
    if (program?.mode === "track-plan") return program.active === true;
    return Array.isArray(program?.steps) && program.steps.length > 0;
  }

  function buildProgram(scope = state.scope, options = {}) {
    const normalizedScope = STRUCTURAL.has(scope) ? scope : "phrase";
    const origin = originFromState(options.origin ?? options);
    if (normalizedScope === "song") {
      return compiler.compileSongPlan({
        model,
        songPolicy,
        origin,
        continueFromChain: options.continueFromChain === true,
        trackCount: TRACKS,
      });
    }
    if (normalizedScope === "chain") {
      return compiler.compileChainProgram({ model, origin, trackCount: TRACKS });
    }
    return compiler.compilePhraseProgram({ model, origin, trackCount: TRACKS });
  }

  function sendStart(program, request) {
    if (program.mode === "track-plan") audio.playPlan(program, model.tempo, request.identity);
    else audio.play(program.steps, model.tempo, request.identity);
  }

  function sendUpdate(program, request) {
    if (program.mode === "track-plan") audio.updatePlan(program, request.identity);
    else audio.updateSequence(program.steps, request.identity);
  }

  function startProgram(program, status, source = "i1-start") {
    if (!sequenceHasContent(program)) {
      setStatus("NOTHING TO PLAY", "amber");
      return false;
    }
    queue.cancelQueue({ source: `${source}-cancel-queue` });
    state.p36.queue = null;
    state.queued = null;
    const request = registerRequest(runtime.requestStart(program, { source }), program);
    $("#playButton")?.setAttribute("aria-pressed", "true");
    sendStart(program, request);
    // Notes with nothing to play them stay silent by design - a fresh
    // Project's demo notes are unassigned. Say so, and what to do, instead of
    // reporting production audio over silence (#511).
    const pool = globalThis.BRKTRKStores?.project?.getState?.()?.instrumentPool ?? model.instrumentPool;
    const silence = compiler.silentNotesStatus?.(compiler.playableNoteSummary?.(program, pool)) ?? null;
    if (silence) {
      const playing = String(status ?? `PLAY ${program.scope.toUpperCase()}`).replace(/ · PRODUCTION AUDIO$/, "");
      setStatus(`${playing} · ${silence}`, "amber");
    } else {
      setStatus(status ?? `PLAY ${program.scope.toUpperCase()} · PRODUCTION AUDIO`);
    }
    renderAll();
    return request;
  }

  function playbackProgram() {
    const snapshot = runtime.snapshot();
    if (snapshot.applied) return appliedProgram ?? programByIdentity.get(identityKey(snapshot.applied)) ?? runtime.getProgram();
    return runtime.getProgram();
  }

  function boundaryTrack(program) {
    if (program?.mode !== "track-plan") return state.track;
    if (program.tracks?.[state.track]?.active) return state.track;
    const fallback = program.tracks?.findIndex?.((track) => track.active) ?? -1;
    return fallback >= 0 ? fallback : state.track;
  }

  function requestDescriptor(scope, options = {}) {
    const origin = originFromState(options.origin ?? options);
    return Object.freeze({
      scope,
      ...origin,
      continueFromChain: options.continueFromChain === true,
      explicit: options.explicit !== false,
    });
  }

  function requestQueuedProgram(program, options = {}) {
    if (!sequenceHasContent(program)) {
      setStatus("NOTHING TO QUEUE", "amber");
      return false;
    }
    const current = playbackProgram();
    const snapshot = runtime.snapshot();
    const request = requestDescriptor(program.scope, options);
    const queued = queue.requestQueue(program, {
      source: options.source ?? "i1-queue",
      request,
      boundary: {
        kind: "phrase",
        track: boundaryTrack(current),
        requestedAfter: snapshot.globalStep,
        requestedReportSerial: acceptedStepReportSerial,
      },
    });
    state.queued = program.scope === "song"
      ? { pane: "song", row: request.songRow, track: request.track }
      : { pane: program.scope, row: program.scope === "chain" ? request.chainRow : 0, track: request.track };
    setStatus(`QUEUED ${program.scope.toUpperCase()} · NEXT PHRASE · Q${queued.descriptor.version}`, "amber");
    renderAll();
    return queued;
  }

  function cancelQueuedProgram(source, status = null) {
    const result = queue.cancelQueue({ source });
    state.queued = null;
    if (status) setStatus(status, "muted");
    if (result.mutated) renderAll();
    return result;
  }

  function requestScopeTransition(scope, options = {}) {
    const normalizedScope = STRUCTURAL.has(scope) ? scope : state.scope;
    const explicit = options.explicit !== false;
    const snapshot = runtime.snapshot();
    if (!explicit) {
      cancelQueuedProgram(options.source ?? "i1-auto-next-start", `SCOPE AUTO · NEXT ${state.scope.toUpperCase()}`);
      return Object.freeze({ policy: "next-start", scope: state.scope, queued: false });
    }
    if (snapshot.phase === "stopping" || !runtime.isPlaying()) {
      cancelQueuedProgram(options.source ?? "i1-scope-next-start");
      setStatus(`NEXT ${normalizedScope.toUpperCase()} · START WHEN PLAY IS PRESSED`, "muted");
      return Object.freeze({ policy: "next-start", scope: normalizedScope, queued: false });
    }
    const appliedScope = snapshot.applied?.scope ?? snapshot.requested?.scope ?? playbackProgram()?.scope;
    if (appliedScope === normalizedScope) {
      cancelQueuedProgram(options.source ?? "i1-scope-already-running", `RUNNING ${normalizedScope.toUpperCase()} · QUEUE CLEARED`);
      return Object.freeze({ policy: "already-applied", scope: normalizedScope, queued: false });
    }
    const request = requestDescriptor(normalizedScope, options);
    const program = buildProgram(normalizedScope, { origin: request, continueFromChain: request.continueFromChain });
    const queued = requestQueuedProgram(program, { ...options, origin: request, explicit: true });
    return Object.freeze({ policy: "next-phrase", scope: normalizedScope, queued: Boolean(queued), descriptor: queued?.descriptor ?? null });
  }

  function contextFromTrackPlan(program, index, trackSteps) {
    const track = clamp(state.track, 0, TRACKS - 1);
    const trackProgram = program?.tracks?.[track];
    const storedPositions = runtime.snapshot().trackPositions;
    const stepIndex = Number.isInteger(trackSteps?.[track]) ? trackSteps[track] : storedPositions[track];
    const structural = songPolicy.contextAt(trackProgram, stepIndex);
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
    const source = model.phrases?.[structural.phraseId]?.[structural.phraseRow] ?? { note: EMPTY };
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

  function contextFromSequence(program, index) {
    const contexts = program?.contexts ?? [];
    if (!contexts.length) return null;
    const position = ((index % contexts.length) + contexts.length) % contexts.length;
    const structural = contexts[position];
    const source = model.phrases?.[structural.phraseId]?.[structural.phraseRow] ?? { note: EMPTY };
    const sourceNote = Number.isFinite(source.note) ? source.note : EMPTY;
    const effectiveNote = sourceNote >= 0 ? clamp(sourceNote + (structural.transpose ?? 0), 0, 127) : sourceNote;
    return Object.freeze({
      ...structural,
      step: index,
      scope: program.scope,
      track: program.origin?.track ?? state.track,
      sourceNote,
      effectiveNote,
      noteOff: sourceNote === NOTE_OFF,
      silent: false,
      occurrenceKey: `${structural.songRow}:${program.origin?.track ?? state.track}:${structural.chainId}:${structural.chainRow}:${structural.phraseId}`,
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

  function setPlaybackContext(context, index) {
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
    if (shouldFollow) requestAnimationFrame(() => scrollToContext(context));
  }

  function transitionBoundaryAhead(index, trackSteps) {
    const queued = queue.snapshot().queued;
    if (!queued) return false;
    const requestedReportSerial = Number.isInteger(queued.boundary.requestedReportSerial)
      ? queued.boundary.requestedReportSerial
      : -1;
    if (acceptedStepReportSerial <= requestedReportSerial) return false;

    // Worklet step reports arrive only after the reported row has already been
    // rendered. Committing when that reported row is Phrase row 0 is therefore
    // one musical row too late: the outgoing program has already emitted its
    // boundary NOTE_TRIGGER, then the replacement can begin from its own row 0
    // and audibly double the note. Commit on the last accepted row whose
    // successor is the Phrase boundary instead. The replacement then reaches
    // the Worklet before that next due frame, so one program owns boundary row 0.
    const program = playbackProgram();
    if (program?.mode === "track-plan") {
      const trackProgram = program.tracks?.[queued.boundary.track];
      const step = trackSteps?.[queued.boundary.track];
      return Boolean(
        trackProgram?.active
        && Number.isInteger(step)
        && songPolicy.phraseBoundary(trackProgram, step + 1)
      );
    }

    const contexts = program?.contexts ?? [];
    if (!contexts.length || !Number.isInteger(index)) return false;
    const nextPosition = ((((index + 1) % contexts.length) + contexts.length) % contexts.length);
    return contexts[nextPosition]?.phraseRow === 0;
  }

  function commitQueuedProgram(source = "i1-boundary-commit") {
    const committed = queue.commitQueue({ source });
    if (!committed.committed) return false;
    registerRequest(committed.request, committed.program);
    state.queued = null;
    sendUpdate(committed.program, committed.request);
    setStatus(`APPLYING ${committed.program.scope.toUpperCase()} · V${committed.request.identity.version}`, "amber");
    renderAll();
    return committed;
  }

  function handleStep(index, trackSteps = null, transport = null) {
    if (state.p36.queue && !queue.snapshot().queued) {
      return legacyTransport.handleStep(index, trackSteps, transport);
    }
    if (index < 0) {
      p35.handleStep(index);
      return true;
    }
    const report = runtime.reportStep({
      index,
      trackSteps,
      transport: transport ?? runtime.getAppliedIdentity() ?? runtime.getRequestedIdentity(),
    }, { source: "i1-audio-worklet-step" });
    if (!report.accepted) return false;
    acceptedStepReportSerial += 1;
    const program = playbackProgram();
    const context = program?.mode === "track-plan"
      ? contextFromTrackPlan(program, index, trackSteps)
      : contextFromSequence(program, index);
    setPlaybackContext(context, index);
    if (transitionBoundaryAhead(index, trackSteps)) commitQueuedProgram();
    return true;
  }

  async function i1TogglePlayback(forceSong = false) {
    const beforeInit = runtime.snapshot();
    if (beforeInit.phase === "stopping") {
      setStatus("STOPPING · WAIT FOR AUDIO ACK", "amber");
      return false;
    }
    // STOP is a control-plane escape hatch for an already allocated graph.
    // Canonical package readiness may be revoked while revalidation fails, but
    // that must never make the normal Play/Stop control unable to stop audio.
    if (runtime.isPlaying() && !forceSong) {
      i1StopPlayback();
      return true;
    }

    await audio.init();
    const snapshot = runtime.snapshot();
    if (snapshot.phase === "stopping") {
      setStatus("STOPPING · WAIT FOR AUDIO ACK", "amber");
      return false;
    }
    if (runtime.isPlaying()) {
      if (forceSong) {
        const continueFromChain = currentStructuralPane() !== "song";
        return requestScopeTransition("song", {
          source: "i1-continue-song",
          explicit: true,
          continueFromChain,
          origin: originFromState(),
        });
      }
      i1StopPlayback();
      return true;
    }
    const scope = forceSong ? "song" : state.scope;
    const continueFromChain = forceSong && currentStructuralPane() !== "song";
    const program = buildProgram(scope, { continueFromChain, origin: originFromState() });
    return startProgram(
      program,
      forceSong
        ? `CONTINUE SONG · S${hex(state.songRow)} · C${hex(state.chain)}:${hex(state.chainRow)}`
        : `PLAY ${scope.toUpperCase()} · PRODUCTION AUDIO`,
      forceSong ? "i1-continue-start" : "i1-play-start",
    );
  }

  function i1StopPlayback() {
    cancelQueuedProgram("i1-stop-cancel-queue");
    state.p36.queue = null;
    state.queued = null;
    const request = runtime.requestStop({ source: "i1-stop" });
    if (!request.mutated && runtime.snapshot().worklet.terminal) {
      setStatus("AUDIO PROCESSOR STOPPED · RELOAD APP", "danger");
      renderAll();
      return request;
    }
    audio.stop(request.identity);
    p35.handleStep(-1);
    $("#playButton")?.setAttribute("aria-pressed", "false");
    setStatus("STOPPED", "muted");
    renderAll();
    return request;
  }

  function rebuildFromRequest(request) {
    return buildProgram(request.scope, {
      origin: request,
      continueFromChain: request.continueFromChain,
    });
  }

  function refreshQueuedProgram() {
    const queued = queue.snapshot().queued;
    if (!queued) return false;
    const next = rebuildFromRequest(queued.request);
    if (!sequenceHasContent(next)) {
      cancelQueuedProgram("i1-refresh-empty-queue", "QUEUED PROGRAM REMOVED · NO PLAYABLE CONTENT");
      return false;
    }
    queue.requestQueue(next, {
      source: "i1-project-refresh-queue",
      request: queued.request,
      boundary: {
        ...queued.boundary,
        requestedAfter: runtime.snapshot().globalStep,
      },
    });
    return true;
  }

  function refreshCurrentProgram() {
    const snapshot = runtime.snapshot();
    if (!runtime.isPlaying()) return false;
    if (snapshot.applied && snapshot.requested && snapshot.applied.version !== snapshot.requested.version) {
      deferredRefresh = true;
      return false;
    }
    const current = playbackProgram();
    if (!current) return false;
    const request = requestDescriptor(current.scope, {
      origin: current.origin ?? originFromState(),
      continueFromChain: current.scope === "song" && (current.origin?.chainRow ?? 0) > 0,
    });
    const next = rebuildFromRequest(request);
    if (!sequenceHasContent(next)) {
      i1StopPlayback();
      return false;
    }
    const update = registerRequest(runtime.requestUpdate(next, { source: "i1-project-refresh" }), next);
    sendUpdate(next, update);
    refreshQueuedProgram();
    return true;
  }

  function refreshPlayback(changeSet = {}) {
    window.clearTimeout(refreshTimer);
    if (!changeSet.affectsPlayback || !runtime.isPlaying()) return false;
    refreshTimer = window.setTimeout(refreshCurrentProgram, 28);
    return true;
  }

  function refreshLegacyPlayback() {
    window.clearTimeout(refreshTimer);
    if (!runtime.isPlaying()) return false;
    refreshTimer = window.setTimeout(refreshCurrentProgram, 28);
    return true;
  }

  function decorateQueue() {
    $$(".i1-queued-scope").forEach((node) => node.classList.remove("i1-queued-scope"));
    const queued = queue.snapshot().queued;
    document.body.dataset.queuedPlaybackScope = queued?.scope ?? "none";
    if (!queued) return;
    $(`#scopeSwitch [data-scope="${queued.scope}"]`)?.classList.add("i1-queued-scope");
    if (queued.scope !== "song") return;
    const cell = $(`[data-pane="song"][data-row="${queued.request.songRow}"][data-col="${queued.request.track}"]`);
    if (!cell) return;
    cell.classList.add("p36-queued-cell");
    if (!cell.querySelector(".p36-queue-marker")) {
      const marker = document.createElement("span");
      marker.className = "p36-queue-marker";
      marker.textContent = "Q";
      marker.title = `Queued ${queued.scope} transition at the next Phrase boundary`;
      cell.append(marker);
    }
  }

  renderRuntime.registerAfterRender("i1.decorate-queue", decorateQueue);

  transportStore.subscribe("transport", (changeSet) => {
    const snapshot = runtime.snapshot();
    if (changeSet.target === "transport.program.applied" && snapshot.applied) {
      appliedProgram = programByIdentity.get(identityKey(snapshot.applied)) ?? runtime.getProgram();
      if (deferredRefresh) {
        deferredRefresh = false;
        queueMicrotask(refreshCurrentProgram);
      }
    }
    if (changeSet.target === "transport.program.stopped") appliedProgram = null;
    // Worklet retained the applied program at the stopped-engine boundary.
    // Do not immediately retry the same Project snapshot in a microtask loop.
    if (changeSet.target === "transport.program.deferred") deferredRefresh = false;
    queueMicrotask(decorateQueue);
  });

  togglePlayback = i1TogglePlayback;
  stopPlayback = i1StopPlayback;
  audio.onStep = handleStep;

  playbackRefreshOwner.installRuntimeAdapter(Object.freeze({
    owner: "i1-transport",
    refresh: refreshPlayback,
    refreshLegacy: refreshLegacyPlayback,
    refreshLinear: refreshCurrentProgram,
    refreshTrackPlan: refreshCurrentProgram,
    refreshQueuedProgram,
    buildSongPlan: (anchorRow = state.songRow) => buildProgram("song", { anchorRow }),
  }));

  function combinedSnapshot() {
    return Object.freeze({
      ...runtime.snapshot(),
      queued: queue.snapshot().queued,
      acceptedStepReportSerial,
    });
  }

  globalThis.BRKTRKTransport = Object.freeze({
    ...legacyTransport,
    buildProgram,
    buildSongPlan: (options = {}) => buildProgram("song", options),
    requestScopeTransition,
    queueProgram: requestQueuedProgram,
    commitI1Queue: commitQueuedProgram,
    cancelI1Queue: cancelQueuedProgram,
    handleStep,
    contextFromPlan: contextFromTrackPlan,
    runtimeSnapshot: combinedSnapshot,
    queueSnapshot: queue.snapshot,
    getPlaybackProgram: playbackProgram,
    refreshQueuedProgram,
    renderNavigationState: legacyTransport.renderNavigationState,
  });

  renderAll();
  document.body.dataset.playbackArchitecture = "m4.0a-i1";
  document.body.dataset.instrumentCarry = "cyclic-project-owned";
  document.body.dataset.transportQueueOwner = "transport-store";
  document.body.dataset.scopeBoundaryClock = "accepted-report-serial";
})();
