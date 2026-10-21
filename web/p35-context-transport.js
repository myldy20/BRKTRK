(() => {
  const policy = globalThis.BRKTRKPlaybackContextPolicy;
  if (!policy) throw new Error("P3.5 playback context policy is required");

  const LEGACY_POLICY_KEY = "brktrk-web-p35-policy-1";
  const STRUCTURAL = new Set(["song", "chain", "phrase"]);

  function restorePolicy() {
    const applicationFollow = globalThis.BRKTRKApplicationSettings?.getFollowPlayhead?.();
    try {
      localStorage.removeItem(LEGACY_POLICY_KEY);
    } catch (error) {
      console.warn("Could not retire legacy P3.5 playback policy", error);
    }
    return {
      followPlayhead: typeof applicationFollow === "boolean" ? applicationFollow : false,
      scopeLocked: false,
      lockedScope: "phrase",
    };
  }

  state.p35 = { ...restorePolicy(), pauseUntil: 0, editHeld: false };

  const baseBuildSequence = buildSequence;
  buildSequence = function p35BuildSequence(scope = state.scope) {
    const origin = {
      songRow: state.songRow,
      track: state.track,
      chainId: state.chain,
      chainRow: state.chainRow,
      phraseId: state.phrase,
    };
    return policy.annotate(baseBuildSequence(scope), origin);
  };

  function emptyPlayhead() {
    return {
      step: -1,
      songRow: -1,
      chainRow: -1,
      phraseRow: -1,
      chainId: -1,
      phraseId: -1,
      transpose: 0,
      sourceNote: -1,
      effectiveNote: -1,
      context: null,
    };
  }

  locatePlayhead = function p35LocatePlayhead(index) {
    const context = policy.resolve({ sequence: state.currentSequence, index, track: state.track, model });
    if (!context) return emptyPlayhead();
    return {
      step: context.step,
      songRow: context.songRow,
      chainRow: context.chainRow,
      phraseRow: context.phraseRow,
      chainId: context.chainId,
      phraseId: context.phraseId,
      transpose: context.transpose,
      sourceNote: context.sourceNote,
      effectiveNote: context.effectiveNote,
      context,
    };
  };

  function clearPlaybackDecorations() {
    $$(".grid-cell.playing").forEach((cell) => cell.classList.remove("playing"));
    $$(".grid-row.playing-row").forEach((row) => row.classList.remove("playing-row"));
    $$(".p35-effective-note").forEach((node) => node.remove());
  }

  function markRow(pane, row) {
    if (row < 0) return;
    $$(`[data-pane="${pane}"][data-row="${row}"]`).forEach((cell) => cell.classList.add("playing"));
    $(`[data-row-pane="${pane}"][data-row="${row}"]`)?.classList.add("playing-row");
  }

  function renderPlaybackContext(context) {
    const target = $("#p35PlaybackContext");
    if (!target) return;
    target.hidden = !context;
    if (!context) {
      target.textContent = "";
      delete target.dataset.match;
      return;
    }
    target.textContent = policy.format(context, { hex, noteName });
    target.dataset.match = state.phrase === context.phraseId ? "current" : "other";
  }

  renderPlayheads = function p35RenderPlayheads() {
    clearPlaybackDecorations();
    const playhead = state.playhead;
    const context = playhead?.context ?? null;
    renderPlaybackContext(context);
    if (!context || playhead.step < 0) return;

    markRow("song", context.songRow);
    if (state.chain === context.chainId) markRow("chain", context.chainRow);
    if (state.phrase === context.phraseId) {
      markRow("phrase", context.phraseRow);
      if (context.transpose !== 0 && context.sourceNote >= 0) {
        const noteCell = $(`[data-pane="phrase"][data-row="${context.phraseRow}"][data-col="0"]`);
        if (noteCell) {
          const effective = document.createElement("span");
          effective.className = "p35-effective-note";
          effective.textContent = `→${noteName(context.effectiveNote)}`;
          effective.title = `Occurrence transpose ${context.transpose >= 0 ? "+" : ""}${context.transpose}`;
          noteCell.append(effective);
        }
      }
    }
  };

  function currentStructuralPane() {
    const workspace = state.p3?.activeWorkspace ?? state.view;
    if (STRUCTURAL.has(workspace)) return workspace;
    return STRUCTURAL.has(state.focus?.pane) ? state.focus.pane : "phrase";
  }

  function updatePolicyButtons() {
    const follow = $("#p35FollowButton");
    if (follow) {
      const held = state.p35.followHeld === true;
      follow.textContent = held ? "VIEW HOLD" : state.p35.followPlayhead ? "VIEW FOLLOW" : "VIEW FIXED";
      follow.setAttribute("aria-label", held ? "FOLLOW PAUSED" : "FOLLOW PLAYBACK");
      follow.setAttribute("aria-pressed", String(state.p35.followPlayhead));
      follow.dataset.followState = held ? "held" : state.p35.followPlayhead ? "following" : "off";
      follow.title = held
        ? "Manual browsing is protected. Press to resume view following."
        : state.p35.followPlayhead
          ? "The visible editor follows playback context until you browse manually"
          : "The visible editor stays where you browse while playback continues";
    }
    const scopeMode = $("#p35ScopeModeButton");
    if (scopeMode) {
      scopeMode.textContent = state.p35.scopeLocked ? "AUTO" : `AUTO→${state.scope.toUpperCase()}`;
      scopeMode.setAttribute("aria-label", "AUTO");
      scopeMode.setAttribute("aria-pressed", String(!state.p35.scopeLocked));
      scopeMode.title = state.p35.scopeLocked
        ? `Use the active Song, Chain or Phrase editor instead of fixed ${state.p35.lockedScope.toUpperCase()}`
        : `Play follows the active editor; currently ${state.scope.toUpperCase()}`;
    }
    $$("#scopeSwitch button[data-scope]").forEach((button) => {
      const selected = state.p35.scopeLocked && button.dataset.scope === state.p35.lockedScope;
      button.setAttribute("aria-pressed", String(selected));
      button.title = `Play ${button.dataset.scope.toUpperCase()} for this session`;
    });
    const settingsFollow = $("#followSetting");
    if (settingsFollow && settingsFollow.checked !== state.p35.followPlayhead) settingsFollow.checked = state.p35.followPlayhead;
  }

  function setFollow(enabled) {
    state.p35.followPlayhead = Boolean(enabled);
    globalThis.BRKTRKApplicationSettings?.setFollowPlayhead?.(state.p35.followPlayhead);
    updatePolicyButtons();
    setStatus(state.p35.followPlayhead ? "VIEW FOLLOWS PLAYBACK" : "VIEW STAYS PUT");
  }

  function syncAutoScope() {
    if (state.p35.scopeLocked) {
      state.scope = state.p35.lockedScope;
    } else {
      state.scope = currentStructuralPane();
    }
    renderTransport();
    updatePolicyButtons();
  }

  function setScopeLocked(locked, scope = state.scope) {
    state.p35.scopeLocked = Boolean(locked);
    if (STRUCTURAL.has(scope)) state.p35.lockedScope = scope;
    syncAutoScope();
    setStatus(state.p35.scopeLocked ? `PLAY SCOPE · ${state.p35.lockedScope.toUpperCase()}` : `PLAY AUTO→${state.scope.toUpperCase()}`);
  }

  function editActive() {
    const activeSheet = globalThis.BRKTRKStores?.navigation?.entryState?.getActiveSheet?.() ?? null;
    return state.p35.editHeld
      || performance.now() < state.p35.pauseUntil
      || activeSheet !== null;
  }

  function suspendFollow(milliseconds = 1200) {
    state.p35.pauseUntil = Math.max(state.p35.pauseUntil, performance.now() + milliseconds);
  }

  function syncVisibleContext(context) {
    if (!context || context.chainId < 0 || context.phraseId < 0) return false;
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
    const pane = currentStructuralPane();
    let row = -1;
    if (pane === "song") row = context.songRow;
    else if (pane === "chain" && state.chain === context.chainId) row = context.chainRow;
    else if (pane === "phrase" && state.phrase === context.phraseId) row = context.phraseRow;
    if (row < 0) return;
    $(`[data-row-pane="${pane}"][data-row="${row}"]`)?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  function handleStep(index) {
    if (index < 0) {
      state.playing = false;
      state.playhead = emptyPlayhead();
      renderTransport();
      renderPlayheads();
      return;
    }

    state.playhead = locatePlayhead(index);
    const context = state.playhead.context;
    const shouldFollow = state.p35.followPlayhead && !editActive();
    if (shouldFollow && syncVisibleContext(context)) renderAll();
    renderPlayheads();
    if (shouldFollow) requestAnimationFrame(() => scrollToContext(context));
  }

  function normalizeMixer() {
    $$("#mixer .channel:not(.master)").forEach((channel) => {
      const slider = channel.querySelector('input[type="range"]');
      const fill = channel.querySelector(".channel-meter i");
      const pan = channel.querySelector(".pan-readout");
      if (slider) {
        slider.classList.add("p35-vertical-fader");
        slider.setAttribute("orient", "vertical");
      }
      if (fill && slider) {
        fill.style.width = "100%";
        fill.style.height = `${Number(slider.value)}%`;
      }
      if (pan) {
        const raw = pan.textContent?.replace(/^PAN\s+/, "") || "C";
        const label = `PAN ${raw}`;
        if (pan.textContent !== label) pan.textContent = label;
        pan.title = raw === "C" ? "Pan center" : raw === "L" ? "Panned left" : "Panned right";
      }
    });
  }

  if (!globalThis.BRKTRKRenderRuntime?.registerAfterMixer || !globalThis.BRKTRKRenderRuntime?.registerAfterTransport) {
    throw new Error("C3 render runtime must load before P3.5");
  }
  globalThis.BRKTRKRenderRuntime.registerAfterMixer("p35.normalize-mixer", normalizeMixer);
  globalThis.BRKTRKRenderRuntime.registerAfterTransport("p35.playback-policy", updatePolicyButtons);

  function injectUi() {
    if (!$("#p35PlaybackContext")) {
      const context = document.createElement("span");
      context.id = "p35PlaybackContext";
      context.className = "p35-playback-context";
      context.hidden = true;
      $(".phrase-subpane .subpane-header")?.insertBefore(context, $(".phrase-subpane .subpane-actions"));
    }

    const scopeSwitch = $("#scopeSwitch");
    if (scopeSwitch && !$("#p35FollowButton")) {
      const scopeMode = document.createElement("button");
      scopeMode.id = "p35ScopeModeButton";
      scopeMode.className = "p35-policy-button p35-auto-scope-button";
      scopeMode.type = "button";
      const follow = document.createElement("button");
      follow.id = "p35FollowButton";
      follow.className = "p35-policy-button p35-view-button";
      follow.type = "button";
      scopeSwitch.insertBefore(scopeMode, scopeSwitch.querySelector("button[data-scope]"));
      scopeSwitch.append(follow);
      scopeMode.addEventListener("click", () => setScopeLocked(false, state.scope));
      follow.addEventListener("click", () => setFollow(!state.p35.followPlayhead));
      scopeSwitch.addEventListener("click", (event) => {
        const selected = event.target.closest("button[data-scope]");
        if (!selected) return;
        state.p35.lockedScope = selected.dataset.scope;
        setScopeLocked(true, selected.dataset.scope);
      });
    }

    const followSetting = $("#followSetting");
    if (followSetting) followSetting.checked = state.p35.followPlayhead;

    updatePolicyButtons();
  }

  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-pane][data-row][data-col]")) suspendFollow(1500);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.code === "KeyS") {
      state.p35.editHeld = true;
      state.p35.pauseUntil = Number.POSITIVE_INFINITY;
    }
  }, true);
  document.addEventListener("keyup", (event) => {
    if (event.code === "KeyS") {
      state.p35.editHeld = false;
      state.p35.pauseUntil = performance.now() + 600;
    }
    requestAnimationFrame(syncAutoScope);
  }, true);
  window.addEventListener("blur", () => {
    state.p35.editHeld = false;
    state.p35.pauseUntil = performance.now() + 600;
  });
  document.addEventListener("focusin", (event) => {
    if (event.target.closest?.("[data-pane][data-row][data-col]")) requestAnimationFrame(syncAutoScope);
  });
  document.addEventListener("input", (event) => {
    if (event.target.closest?.("#mixer .channel:not(.master) input[type=range]")) requestAnimationFrame(normalizeMixer);
  });

  const mixer = $("#mixer");
  if (mixer) new MutationObserver(normalizeMixer).observe(mixer, { childList: true, subtree: true });

  audio.onStep = handleStep;
  injectUi();
  syncAutoScope();
  normalizeMixer();
  renderPlayheads();
  document.body.dataset.playbackArchitecture = "p3.5";

  let scopeSubscribed = false;
  const subscribeScope = () => {
    if (scopeSubscribed || !globalThis.BRKTRKCommands?.subscribe) return;
    globalThis.BRKTRKCommands.subscribe(syncAutoScope);
    scopeSubscribed = true;
  };
  window.addEventListener("brktrk-runtime-ready", subscribeScope, { once: true });
  window.addEventListener("load", () => window.setTimeout(subscribeScope, 0), { once: true });

  globalThis.BRKTRKPlaybackContext = Object.freeze({
    handleStep,
    setFollow,
    setScopeLocked,
    syncAutoScope,
    suspendFollow,
    normalizeMixer,
    isEditing: editActive,
  });
})();