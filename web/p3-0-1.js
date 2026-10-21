(() => {
  const STRUCTURAL = new Set(["song", "chain", "phrase"]);
  const baseKeyDown = keyDown;
  const baseSetFocus = setFocus;

  state.p3 ??= {};
  state.p3.activeWorkspace ??= STRUCTURAL.has(state.view) ? state.view : state.focus.pane;
  state.p3.soundParam ??= 0;

  function snapshotContext() {
    const structuralView = STRUCTURAL.has(state.focus.pane) ? state.focus.pane : "phrase";
    const activeWorkspace = state.p3.activeWorkspace ?? structuralView;
    return {
      view: activeWorkspace === "mix" || activeWorkspace === "sound" ? activeWorkspace : structuralView,
      dock: state.dock,
      activeWorkspace,
      focus: { ...state.focus },
      songRow: state.songRow,
      track: state.track,
      chain: state.chain,
      chainRow: state.chainRow,
      phrase: state.phrase,
      phraseRow: state.phraseRow,
      instrument: state.instrument,
      soundParam: state.p3.soundParam,
    };
  }

  function restoreContext(snapshot, message = "RETURN") {
    if (!snapshot) return false;
    state.view = snapshot.view;
    state.dock = snapshot.dock;
    state.songRow = snapshot.songRow;
    state.track = snapshot.track;
    state.chain = snapshot.chain;
    state.chainRow = snapshot.chainRow;
    state.phrase = snapshot.phrase;
    state.phraseRow = snapshot.phraseRow;
    state.instrument = snapshot.instrument;
    state.focus = { ...snapshot.focus };
    state.p3.soundParam = snapshot.soundParam ?? 0;
    state.p3.activeWorkspace = snapshot.activeWorkspace ?? snapshot.focus.pane;
    state.p3.noteDockOpen = false;
    renderAll();
    if (STRUCTURAL.has(state.p3.activeWorkspace)) focusSelectedCell();
    else focusUtilityControl();
    setStatus(`${message} ${state.p3.activeWorkspace.toUpperCase()}`);
    return true;
  }

  function ensureCellVisible(cell) {
    const grid = cell?.closest(".tracker-grid");
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const headerHeight = grid.querySelector(".grid-header")?.getBoundingClientRect().height ?? 0;
    const visibleTop = gridRect.top + headerHeight;
    const visibleBottom = gridRect.bottom;
    const visibleLeft = gridRect.left;
    const visibleRight = gridRect.right;

    if (cellRect.top < visibleTop) grid.scrollTop -= visibleTop - cellRect.top;
    else if (cellRect.bottom > visibleBottom) grid.scrollTop += cellRect.bottom - visibleBottom;

    if (cellRect.left < visibleLeft) grid.scrollLeft -= visibleLeft - cellRect.left;
    else if (cellRect.right > visibleRight) grid.scrollLeft += cellRect.right - visibleRight;
  }

  focusSelectedCell = function p301FocusSelectedCell() {
    requestAnimationFrame(() => {
      const selector = `[data-pane="${state.focus.pane}"][data-row="${state.focus.row}"][data-col="${state.focus.col}"]`;
      const cell = $(selector);
      if (!cell || cell.offsetParent === null) return;
      cell.focus({ preventScroll: true });
      const sheetOpen = document.body.classList.contains("p3-note-open") || document.body.classList.contains("p32-value-open");
      if (sheetOpen && state.focus.pane === "phrase" && globalThis.BRKTRKNoteEntry?.revealSelectedRow) {
        globalThis.BRKTRKNoteEntry.revealSelectedRow();
        return;
      }
      ensureCellVisible(cell);
    });
  };

  setFocus = function p301SetFocus(pane, row, col, shouldFocus = true) {
    if (STRUCTURAL.has(pane)) {
      state.view = pane;
      state.p3.activeWorkspace = pane;
    }
    return baseSetFocus(pane, row, col, shouldFocus);
  };

  function focusMixChannel() {
    requestAnimationFrame(() => {
      const channels = $$("#mixer .track-bus-channel");
      channels.forEach((channel, index) => {
        channel.dataset.channel = String(index);
        channel.tabIndex = index === state.track ? 0 : -1;
        channel.classList.toggle("p301-keyboard-focus", index === state.track);
      });
      const active = channels[state.track];
      if (!active || active.offsetParent === null) return;
      active.focus({ preventScroll: true });
      active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    });
  }

  function focusSoundParameter() {
    requestAnimationFrame(() => {
      const cards = $$("#instrumentInspector .a4a-param");
      cards.forEach((card, index) => {
        card.tabIndex = index === state.p3.soundParam ? 0 : -1;
        card.classList.toggle("p301-keyboard-focus", index === state.p3.soundParam);
      });
      const active = cards[state.p3.soundParam];
      if (active && active.offsetParent !== null) {
        active.focus({ preventScroll: true });
        active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
        return;
      }
      const fallback = $("#instrumentInspector .a4a-create-panel select, #instrumentInspector .a4a-create-panel button");
      if (fallback && fallback.offsetParent !== null) fallback.focus({ preventScroll: true });
    });
  }

  function focusUtilityControl() {
    if (state.p3.activeWorkspace === "mix") focusMixChannel();
    else if (state.p3.activeWorkspace === "sound") focusSoundParameter();
  }

  function renderWorkspaceFocus() {
    const workspace = state.p3.activeWorkspace;
    const utility = workspace === "mix" || workspace === "sound";
    $("#inspectorPane")?.classList.toggle("p301-active-workspace", utility);
    if (!utility) return;

    $("#songPane")?.classList.remove("active-pane");
    $("#patternPane")?.classList.remove("active-pane");
    $(".chain-subpane")?.classList.remove("active-subpane");
    $(".phrase-subpane")?.classList.remove("active-subpane");

    if (workspace === "mix") {
      if (!globalThis.BRKTRKTrackMixer?.renderMixStatus?.(state.track)) {
        const mix = globalThis.BRKTRKTrackMix?.get?.(state.track) ?? { gain: 1, pan: 0, mute: false };
        const pan = globalThis.BRKTRKTrackMixer?.panLabel?.(mix.pan) ?? (mix.pan === 0 ? "C" : mix.pan < 0 ? `L${Math.round(Math.abs(mix.pan) * 100)}` : `R${Math.round(mix.pan * 100)}`);
        $("#activeEditorLabel").textContent = "EDITING MIX";
        $("#editBreadcrumb").innerHTML = `EDIT · MIX · TRACK <b>${state.track + 1}</b> · GAIN ${Math.round(mix.gain * 100)}% · PAN ${pan} · MUTE ${mix.mute ? "ON" : "OFF"}`;
      }
      focusMixChannel();
    } else {
      const renderer = globalThis.BRKTRKSoundEditRenderer;
      const context = renderer?.selectedParameterContext?.(state.instrument, state.p3.soundParam) ?? null;
      const instrument = globalThis.BRKTRKStores?.project?.getState?.()?.instrumentPool?.[state.instrument] ?? null;
      $("#activeEditorLabel").textContent = "EDITING SOUND";
      if (context) {
        const label = String(context.parameter?.name ?? context.parameter?.label ?? context.parameterId ?? "PARAM");
        const value = renderer.displayValue(context.parameter, context.value, {});
        $("#editBreadcrumb").innerHTML = `EDIT · SOUND · INST ${hex(state.instrument)} · ${label} <b>${value}</b>`;
      } else {
        const stateLabel = instrument?.engineRef
          ? `${instrument.engineRef.engineId}@${instrument.engineRef.resolvedVersion ?? instrument.engineRef.requestedVersion ?? "?"}`
          : "EMPTY PRODUCTION SLOT";
        $("#editBreadcrumb").innerHTML = `EDIT · SOUND · INST ${hex(state.instrument)} · <b>${stateLabel}</b>`;
      }
      focusSoundParameter();
    }
  }

  globalThis.BRKTRKWorkspaceFocus = Object.freeze({ render: renderWorkspaceFocus });
  if (!globalThis.BRKTRKRenderRuntime?.registerAfterRender) {
    throw new Error("C3 render runtime must load before P3.0.1");
  }
  globalThis.BRKTRKRenderRuntime.registerAfterRender("p301.workspace-focus", renderWorkspaceFocus);

  function openMix() {
    if (state.p3.activeWorkspace === "mix") return;
    state.p3.mixReturn = snapshotContext();
    state.p3.activeWorkspace = "mix";
    state.view = "mix";
    state.dock = "mix";
    state.p3.noteDockOpen = false;
    renderAll();
    focusMixChannel();
    setStatus(`MIX · T${state.track + 1}`);
  }

  function returnFromMix() {
    const target = state.p3.mixReturn;
    state.p3.mixReturn = null;
    if (!restoreContext(target, "RETURN FROM MIX")) setStatus("NO MIX RETURN TARGET", "amber");
  }

  function selectMixTrack(delta) {
    const next = clamp(state.track + delta, 0, TRACKS - 1);
    if (globalThis.BRKTRKTrackMixer?.selectTrack) {
      globalThis.BRKTRKTrackMixer.selectTrack(next);
    } else {
      const navigation = globalThis.BRKTRKStores?.navigation;
      const before = navigation?.captureContext?.();
      navigation?.restoreContext?.({ ...before, track: next }, {
        source: "p301-mix-key-selection",
        subtype: "track.select",
        target: "navigation.track",
        path: ["track"],
        renderTargets: ["navigation.track-selection"],
      });
    }
    focusMixChannel();
    setStatus(`MIX TRACK ${next + 1}`);
  }

  function editMixVolume(code) {
    const mixer = globalThis.BRKTRKTrackMixer;
    const domain = globalThis.BRKTRKTrackMix;
    if (!mixer?.applyMix || !domain?.get) {
      setStatus("TRACK MIX INITIALIZING", "amber");
      return;
    }
    const current = domain.get(state.track).gain;
    const large = code === "ArrowUp" || code === "ArrowDown";
    const direction = code === "ArrowRight" || code === "ArrowUp" ? 1 : -1;
    const step = large ? 0.1 : 0.01;
    const next = clamp(Math.round((current + direction * step) * 100) / 100, 0, 1);
    const result = mixer.applyMix(state.track, { gain: next }, "gain", "p301-mix-key-gain");
    const channel = document.querySelector(`#mixer .track-bus-channel[data-track="${state.track}"]`);
    const input = channel?.querySelector(".track-gain-range");
    const output = channel?.querySelector(".track-gain-control output");
    if (input) input.value = String(Math.round(result.after.gain * 100));
    if (output) output.textContent = `${Math.round(result.after.gain * 100)}%`;
    mixer.renderMixStatus?.(state.track);
    setStatus(`MIX T${state.track + 1} · GAIN ${Math.round(result.after.gain * 100)}%`);
  }

  function navigateSound(code, option, edit) {
    const commands = globalThis.BRKTRKCommands;
    if (commands?.installed && commands.dispatch) {
      if (option && (code === "ArrowLeft" || code === "ArrowRight")) {
        return commands.dispatch({ type: "sound.selectInstrument", direction: code, source: "p301-compat" });
      }
      if (edit) return commands.dispatch({ type: "sound.adjustParam", direction: code, source: "p301-compat" });
      if (code === "ArrowLeft" || code === "ArrowRight") {
        return commands.dispatch({ type: "sound.selectParam", direction: code, source: "p301-compat" });
      }
    }

    if (option && (code === "ArrowLeft" || code === "ArrowRight")) {
      state.instrument = clamp(state.instrument + (code === "ArrowRight" ? 1 : -1), 0, 255);
      renderAll();
      setStatus(`SOUND INST ${hex(state.instrument)}`);
      return;
    }
    if (edit) {
      setStatus("PRODUCTION SOUND COMMAND LAYER INITIALIZING", "amber");
      return;
    }
    if (code === "ArrowLeft" || code === "ArrowRight") {
      const count = globalThis.BRKTRKSoundEditRenderer?.parameterCount?.(state.instrument) ?? 0;
      if (!count) {
        setStatus("PRODUCTION SOUND PARAMETERS UNAVAILABLE", "amber");
        return;
      }
      state.p3.soundParam = clamp(state.p3.soundParam + (code === "ArrowRight" ? 1 : -1), 0, count - 1);
      renderWorkspaceFocus();
      setStatus(`SOUND PARAM ${state.p3.soundParam + 1}`);
      return;
    }
    setStatus("SOUND · USE ←/→ TO SELECT PARAMETER", "muted");
  }

  function syncWorkspaceAfterBaseCommand() {
    if (state.view === "sound") state.p3.activeWorkspace = "sound";
    else if (STRUCTURAL.has(state.view)) state.p3.activeWorkspace = state.focus.pane;
    renderWorkspaceFocus();
  }

  keyDown = function p301KeyDown(code, repeat = false) {
    const option = heldKeys.has("KeyA");
    const edit = heldKeys.has("KeyS");
    const shift = heldKeys.has("KeyZ");
    const workspace = state.p3.activeWorkspace;

    if (code.startsWith("Arrow")) {
      if (shift && code === "ArrowDown" && workspace !== "mix") {
        openMix();
        return;
      }
      if (workspace === "mix") {
        if (shift && (code === "ArrowUp" || code === "ArrowLeft")) {
          returnFromMix();
          return;
        }
        if (edit) {
          editMixVolume(code);
          return;
        }
        if (code === "ArrowLeft" || code === "ArrowRight") {
          selectMixTrack(code === "ArrowRight" ? 1 : -1);
          return;
        }
        setStatus("MIX · ←/→ SELECT TRACK · S+ARROWS GAIN", "muted");
        return;
      }
      if (workspace === "sound") {
        if (shift && code === "ArrowLeft") {
          baseKeyDown(code, repeat);
          syncWorkspaceAfterBaseCommand();
          return;
        }
        navigateSound(code, option, edit);
        return;
      }
    }

    if ((workspace === "mix" || workspace === "sound") && code === "KeyS" && !repeat) {
      heldKeys.add(code);
      setStatus(`${workspace.toUpperCase()} EDIT HELD`);
      return;
    }

    const result = baseKeyDown(code, repeat);
    if (code.startsWith("Arrow") && shift) syncWorkspaceAfterBaseCommand();
    return result;
  };

  audio.updateSequence = function p301UpdateSequence(sequence) {
    if (!this.ready || !this.node) return;
    this.node.port.postMessage({ type: "update-sequence", sequence });
  };

  function refreshLivePlayback() {
    return globalThis.BRKTRKProjectPlaybackRefresh?.refreshLegacy?.({ source: "p301-compat-refresh" }) ?? false;
  }

  function bindSafeTempoPrompt() {
    const button = $("#tempoButton");
    if (!button) return;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const raw = window.prompt("Tempo (30–300 BPM)", String(model.tempo));
      if (raw === null || raw.trim() === "") {
        setStatus(`BPM ${model.tempo} · UNCHANGED`, "muted");
        return;
      }
      const parsed = Number(raw.trim().replace(",", "."));
      if (!Number.isFinite(parsed)) {
        setStatus("INVALID BPM", "danger");
        return;
      }
      model.tempo = clamp(Math.round(parsed), 30, 300);
      audio.tempo(model.tempo);
      persist();
      renderTransport();
      setStatus(`BPM ${model.tempo}`);
    }, true);
  }

  window.BRKTRKP301 = {
    ensureCellVisible,
    refreshLivePlayback,
    snapshotContext,
    restoreContext,
    openMix,
    returnFromMix,
  };

  bindSafeTempoPrompt();
  renderAll();
})();