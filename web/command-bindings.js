(() => {
  if (!globalThis.BRKTRKCommands?.installed) throw new Error("P3.1 dispatcher must load before command bindings");
  const commands = globalThis.BRKTRKCommands;
  const entryState = commands.stores?.navigation?.entryState;
  if (!entryState) throw new Error("NavigationStore entry state must load before command bindings");
  const isPhone = () => window.matchMedia("(max-width: 760px)").matches;

  function stopEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function closeNoteDock() {
    entryState.closeSheet("note", { source: "note-editor-close" });
  }

  function refreshNoteDock() {
    const dock = $("#p3NoteDock");
    if (!dock) return;
    const noteSelected = state.focus.pane === "phrase" && state.focus.col === 0;
    const editButton = $("#p3EditButton");
    if (editButton) editButton.hidden = !isPhone() || !noteSelected;
    if (!noteSelected || !isPhone()) {
      closeNoteDock();
      return;
    }
    const step = phrase(state.phrase)[state.focus.row];
    const prepared = entryState.getPreparedEntry();
    $("#p3NoteContext").textContent = `PHRASE ${hex(state.phrase)} · ROW ${hex(state.focus.row)} · ${noteName(step.note)}`;
    $("#p3OctaveValue b").textContent = prepared.octave;
    $("#p3VelocityValue b").textContent = step.velocity;
    $("#p3EditStep b").textContent = prepared.editStep;
    $$("#p3PitchGrid [data-pitch]").forEach((button) => {
      const note = BRKTRKP3.noteFromPitchClass(prepared.octave, Number(button.dataset.pitch));
      button.classList.toggle("active", step.note === note);
    });
  }

  function openNoteDock() {
    if (!isPhone() || state.focus.pane !== "phrase" || state.focus.col !== 0) return false;
    const value = currentValue();
    if (value >= 0) entryState.setPreparedValue("octave", Math.floor(value / 12) - 1, { source: "note-editor-open" });
    entryState.openSheet("note", { source: "note-editor-open" });
    refreshNoteDock();
    setStatus("NOTE EDITOR OPEN");
    return true;
  }

  function releaseHeldKeys() {
    for (const code of [...heldKeys]) {
      const press = commands.runtime?.modifierPresses?.get(code);
      if (press) press.used = true;
      commands.keyUp(code);
    }
    commands.runtime?.modifierPresses?.clear?.();
    heldKeys.clear();
  }

  function focusUtility() {
    requestAnimationFrame(() => {
      if (commands.runtime.activeWorkspace === "mix") {
        const channels = $$("#mixer .channel:not(.master)");
        channels.forEach((channel, index) => {
          channel.dataset.channel = String(index);
          channel.tabIndex = index === state.track ? 0 : -1;
          channel.classList.toggle("p301-keyboard-focus", index === state.track);
        });
        channels[state.track]?.focus({ preventScroll: true });
      } else if (commands.runtime.activeWorkspace === "sound") {
        const cards = $$("#instrumentInspector .a4a-param, #instrumentInspector .parameter-card");
        cards.forEach((card, index) => {
          card.dataset.param = String(index);
          card.tabIndex = index === (state.p3.soundParam ?? 0) ? 0 : -1;
          card.classList.toggle("p301-keyboard-focus", index === (state.p3.soundParam ?? 0));
        });
        cards[state.p3.soundParam ?? 0]?.focus({ preventScroll: true });
      }
    });
  }

  function channelIndex(element) {
    const channel = element.closest("#mixer .channel:not(.master)");
    if (!channel) return -1;
    const channels = $$("#mixer .channel:not(.master)");
    return channels.indexOf(channel);
  }

  function parameterIndex(element) {
    const card = element.closest("#instrumentInspector .a4a-param, #instrumentInspector .parameter-card");
    if (!card) return -1;
    return $$("#instrumentInspector .a4a-param, #instrumentInspector .parameter-card").indexOf(card);
  }

  async function selectPointerCell(pane, row, col, source = "pointer-double") {
    const activeWorkspace = commands.runtime?.activeWorkspace ?? state.p3?.activeWorkspace ?? state.view;
    if (activeWorkspace !== pane) {
      const workspace = await commands.dispatch({
        type: "workspace.select",
        workspace: pane,
        ...(source === "pointer-cell" ? { source: "pointer-cell-workspace" } : { source: "pointer-double-workspace" }),
      });
      if (!workspace || workspace.ok === false) return false;
    }
    const selected = await commands.dispatch({
      type: "cursor.select",
      pane,
      row,
      col,
      focus: false,
      ...(source === "pointer-cell" ? { source: "pointer-cell" } : { source: "pointer-double-select" }),
    });
    return Boolean(selected && selected.ok !== false);
  }

  async function handlePointerDouble(cell) {
    const pane = cell.dataset.pane;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!await selectPointerCell(pane, row, col)) return;

    if (pane === "phrase" && col === 0) {
      if (isPhone()) {
        openNoteDock();
        return;
      }
      const currentNote = phrase(state.phrase, false)?.[row]?.note ?? EMPTY;
      await commands.dispatch({
        type: "note.write",
        value: currentNote < 0 ? 48 : NOTE_OFF,
        preview: currentNote < 0,
        source: "pointer-double-note",
      });
      return;
    }

    const structuralReference = pane === "song" || (pane === "chain" && col === 0);
    if (structuralReference) {
      if (currentValue() < 0) {
        const mutation = await commands.dispatch({
          type: "field.insert",
          cursor: { pane, row, col },
          fresh: true,
          source: "pointer-double-create",
        });
        if (!mutation || mutation.ok === false) return;
      }
      await commands.dispatch({ type: "hierarchy.openChild", source: "pointer-double-open" });
      return;
    }

    await commands.dispatch({ type: "field.insert", source: "pointer-double-field" });
  }

  let tempoDelay = 0;
  let tempoRepeat = 0;
  function stopTempoRepeat() {
    window.clearTimeout(tempoDelay);
    window.clearInterval(tempoRepeat);
    tempoDelay = 0;
    tempoRepeat = 0;
  }
  function changeTempo(delta) {
    commands.dispatch({ type: "tempo.set", value: model.tempo + delta, source: "pointer-tempo" });
  }

  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("#tempoDown, #tempoUp");
    if (!button) return;
    stopEvent(event);
    stopTempoRepeat();
    const delta = button.id === "tempoUp" ? 1 : -1;
    changeTempo(delta);
    tempoDelay = window.setTimeout(() => {
      tempoRepeat = window.setInterval(() => changeTempo(delta), 75);
    }, 340);
  }, true);
  document.addEventListener("pointerup", stopTempoRepeat, true);
  document.addEventListener("pointercancel", stopTempoRepeat, true);

  document.addEventListener("input", (event) => {
    const soundSlider = event.target.closest("#instrumentInspector .parameter-card input[type=range]");
    if (soundSlider) {
      stopEvent(event);
      const index = parameterIndex(soundSlider);
      commands.dispatch({ type: "sound.setParam", index, value: Number(soundSlider.value), transient: true, source: "pointer-slider" });
      soundSlider.closest(".parameter-card")?.querySelector("output")?.replaceChildren(document.createTextNode(hex(Number(soundSlider.value))));
      return;
    }
    const mixSlider = event.target.closest("#mixer .channel:not(.master) input[type=range]");
    if (mixSlider) {
      stopEvent(event);
      const index = channelIndex(mixSlider);
      commands.dispatch({ type: "mix.selectTrack", index, source: "pointer-slider" });
      commands.dispatch({ type: "mix.setVolume", value: Number(mixSlider.value) / 100, transient: true, source: "pointer-slider" });
      const meter = mixSlider.closest(".channel")?.querySelector(".channel-meter i");
      if (meter) meter.style.width = `${Math.round(Number(mixSlider.value) * 0.55)}%`;
    }
  }, true);

  document.addEventListener("dblclick", (event) => {
    const cell = event.target.closest("[data-pane][data-row][data-col]");
    if (!cell) return;
    stopEvent(event);
    void handlePointerDouble(cell).catch((error) => {
      console.error(error);
      setStatus("POINTER EDIT FAILED", "danger");
    });
  }, true);

  document.addEventListener("click", (event) => {
    const target = event.target;

    if (target.closest("#tempoDown, #tempoUp")) return stopEvent(event);
    if (target.closest("#playButton")) {
      stopEvent(event);
      commands.dispatch({ type: "transport.toggle", source: "pointer" });
      return;
    }
    if (target.closest("#stopButton")) {
      stopEvent(event);
      commands.dispatch({ type: "transport.stop", source: "pointer" });
      return;
    }
    const scope = target.closest("#scopeSwitch [data-scope]");
    if (scope) {
      stopEvent(event);
      commands.dispatch({ type: "scope.set", scope: scope.dataset.scope, source: "pointer" });
      return;
    }
    if (target.closest("#tempoButton")) {
      stopEvent(event);
      const raw = window.prompt("Tempo (30–300 BPM)", String(model.tempo));
      if (raw === null || raw.trim() === "") {
        setStatus(`BPM ${model.tempo} · UNCHANGED`, "muted");
        return;
      }
      commands.dispatch({ type: "tempo.set", value: Number(raw.trim().replace(",", ".")), source: "tempo-dialog" });
      return;
    }
    if (target.closest("#projectName")) {
      stopEvent(event);
      const value = window.prompt("Project name", model.projectName);
      if (value !== null) commands.dispatch({ type: "project.rename", value, source: "project-name-dialog" });
      return;
    }
    if (target.closest("#p3NoteClose")) {
      stopEvent(event);
      closeNoteDock();
      return;
    }
    if (target.closest("#p3EditButton")) {
      stopEvent(event);
      openNoteDock();
      return;
    }
    const pitch = target.closest("#p3PitchGrid [data-pitch]");
    if (pitch) {
      stopEvent(event);
      commands.dispatch({
        type: "note.write",
        value: BRKTRKP3.noteFromPitchClass(entryState.getPreparedEntry().octave, Number(pitch.dataset.pitch)),
        preview: true,
        source: "note-editor",
      });
      return;
    }
    if (target.closest("#p3OctaveDown")) {
      stopEvent(event);
      commands.dispatch({ type: "note.octave", delta: -1, source: "note-editor" });
      return;
    }
    if (target.closest("#p3OctaveUp")) {
      stopEvent(event);
      commands.dispatch({ type: "note.octave", delta: 1, source: "note-editor" });
      return;
    }
    if (target.closest("#p3VelocityDown")) {
      stopEvent(event);
      commands.dispatch({ type: "note.velocity", delta: -1, source: "note-editor" });
      return;
    }
    if (target.closest("#p3VelocityUp")) {
      stopEvent(event);
      commands.dispatch({ type: "note.velocity", delta: 1, source: "note-editor" });
      return;
    }
    if (target.closest("#p3EditStep")) {
      stopEvent(event);
      commands.dispatch({ type: "note.editStep", source: "note-editor" });
      return;
    }
    if (target.closest("#p3NoteOff")) {
      stopEvent(event);
      commands.dispatch({ type: "note.write", value: NOTE_OFF, source: "note-editor" });
      return;
    }
    if (target.closest("#p3NoteEmpty")) {
      stopEvent(event);
      commands.dispatch({ type: "note.write", value: EMPTY, source: "note-editor" });
      return;
    }

    const mobileTab = target.closest("#mobileTabs [data-view]");
    if (mobileTab) {
      stopEvent(event);
      const workspace = mobileTab.dataset.view;
      commands.dispatch(workspace === "mix"
        ? { type: "workspace.openMix", source: "mobile-tab" }
        : { type: "workspace.select", workspace, direct: true, source: "mobile-tab" });
      return;
    }
    const panelButton = target.closest("#utilityPanels [data-panel]");
    if (panelButton) {
      stopEvent(event);
      commands.dispatch({ type: "dock.toggle", dock: panelButton.dataset.panel, source: "topbar-panel" });
      return;
    }
    const dockTab = target.closest("#dockTabs [data-dock], #mobileSoundTabs [data-dock]");
    if (dockTab) {
      stopEvent(event);
      commands.dispatch({ type: "dock.select", dock: dockTab.dataset.dock, activateWorkspace: isPhone(), source: "dock-tab" });
      return;
    }
    if (target.closest("#chainPrev")) {
      stopEvent(event);
      commands.dispatch({ type: "context.navigate", direction: "ArrowUp", source: "pointer" });
      return;
    }
    if (target.closest("#chainNext")) {
      stopEvent(event);
      commands.dispatch({ type: "context.navigate", direction: "ArrowDown", source: "pointer" });
      return;
    }
    if (target.closest("#phrasePrev")) {
      stopEvent(event);
      commands.dispatch({ type: "cursor.select", pane: "phrase", row: state.phraseRow, col: state.focus.col, focus: false, source: "pointer" });
      commands.dispatch({ type: "context.navigate", direction: "ArrowUp", source: "pointer" });
      return;
    }
    if (target.closest("#phraseNext")) {
      stopEvent(event);
      commands.dispatch({ type: "cursor.select", pane: "phrase", row: state.phraseRow, col: state.focus.col, focus: false, source: "pointer" });
      commands.dispatch({ type: "context.navigate", direction: "ArrowDown", source: "pointer" });
      return;
    }

    const mute = target.closest("#mixer .channel:not(.master) button");
    if (mute) {
      stopEvent(event);
      const index = channelIndex(mute);
      commands.dispatch({ type: "mix.selectTrack", index, source: "pointer" });
      commands.dispatch({ type: "mix.toggleMute", source: "pointer" });
      return;
    }
    const channel = target.closest("#mixer .channel:not(.master)");
    if (channel && !target.closest("input")) {
      stopEvent(event);
      commands.dispatch({ type: "mix.selectTrack", index: channelIndex(channel), source: "pointer" });
      return;
    }
    const parameter = target.closest("#instrumentInspector .a4a-param, #instrumentInspector .parameter-card");
    if (parameter && !target.closest("input, select, button")) {
      stopEvent(event);
      commands.dispatch({ type: "sound.selectParam", index: parameterIndex(parameter), source: "pointer" });
      return;
    }

    const cell = target.closest("[data-pane][data-row][data-col]");
    if (cell) {
      stopEvent(event);
      // Selecting a visible tracker cell also hands keyboard input back to its
      // workspace. A cursor selection alone leaves Sound owning S+arrows.
      void selectPointerCell(cell.dataset.pane, Number(cell.dataset.row), Number(cell.dataset.col), "pointer-cell")
        .catch((error) => {
          console.error(error);
          setStatus("POINTER SELECTION FAILED", "danger");
        });
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Escape") return;
    const activeSheet = entryState.getActiveSheet();
    if (activeSheet === "note") closeNoteDock();
  }, true);

  commands.subscribe((record) => {
    document.body.dataset.commandId = String(record.id);
    document.body.dataset.commandType = record.command?.type ?? "unknown";
    refreshNoteDock();
  });

  globalThis.BRKTRKCommandBindings = Object.freeze({
    openNoteDock,
    closeNoteDock,
    refreshNoteDock,
    releaseHeldKeys,
    focusUtility,
    selectPointerCell,
    handlePointerDouble,
  });
  releaseHeldKeys();
  globalThis.BRKTRKStoreRuntime?.navigationSubscribers?.refreshActiveSheet?.();
  refreshNoteDock();
  focusUtility();
})();
