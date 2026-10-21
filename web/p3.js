(() => {
  const contract = globalThis.BRKTRKP3;
  if (!contract) throw new Error("P3 contract helpers are not loaded");

  const baseSetFocus = setFocus;
  const baseClearCurrentCell = clearCurrentCell;
  const PITCH_LABELS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const EDIT_STEPS = [0, 1, 2, 4];

  state.p3 ??= {
    parents: [],
    mixReturn: null,
    noteDockOpen: false,
    noteOctave: 4,
    editStep: 1,
  };

  function isPhone() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  function structuralView() {
    if (state.view === "sound" || state.view === "mix") return state.view;
    return state.focus.pane;
  }

  function snapshotContext() {
    return {
      view: state.view,
      dock: state.dock,
      focus: { ...state.focus },
      songRow: state.songRow,
      track: state.track,
      chain: state.chain,
      chainRow: state.chainRow,
      phrase: state.phrase,
      phraseRow: state.phraseRow,
      instrument: state.instrument,
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
    closeNoteDock();
    renderAll();
    focusSelectedCell();
    setStatus(`${message} ${snapshot.focus.pane.toUpperCase()}`);
    return true;
  }

  function firstPopulatedChainRow(chainId) {
    const source = chain(chainId, false) ?? [];
    const row = source.findIndex((entry) => entry.phrase >= 0);
    return row >= 0 ? row : 0;
  }

  function openChild() {
    const pane = state.focus.pane;
    const { row, col } = state.focus;

    if (pane === "song") {
      const chainId = model.song[row][col];
      if (chainId < 0) {
        setStatus("EMPTY · S INSERT · S,S NEW CHAIN", "amber");
        return;
      }
      state.p3.parents.push(snapshotContext());
      state.songRow = row;
      state.track = col;
      state.chain = chainId;
      state.lastChain = chainId;
      state.chainRow = firstPopulatedChainRow(chainId);
      const phraseId = chain(chainId, false)?.[state.chainRow]?.phrase ?? EMPTY;
      if (phraseId >= 0) {
        state.phrase = phraseId;
        state.lastPhrase = phraseId;
      }
      state.view = "chain";
      closeNoteDock();
      baseSetFocus("chain", state.chainRow, 0);
      setStatus(`OPEN CHAIN ${hex(chainId)}`);
      return;
    }

    if (pane === "chain") {
      const entry = chain(state.chain, false)?.[row];
      if (!entry || entry.phrase < 0) {
        setStatus("EMPTY · S INSERT · S,S NEW PHRASE", "amber");
        return;
      }
      state.p3.parents.push(snapshotContext());
      state.chainRow = row;
      state.phrase = entry.phrase;
      state.lastPhrase = entry.phrase;
      state.phraseRow = 0;
      state.view = "phrase";
      closeNoteDock();
      baseSetFocus("phrase", 0, 0);
      setStatus(`OPEN PHRASE ${hex(entry.phrase)}`);
      return;
    }

    if (pane === "phrase") {
      const step = phrase(state.phrase, false)?.[row];
      const fallback = step?.instrument < 0;
      const instrumentId = fallback ? state.instrument : step.instrument;
      state.p3.parents.push(snapshotContext());
      state.phraseRow = row;
      state.instrument = clamp(instrumentId, 0, 255);
      state.view = "sound";
      state.dock = "sound";
      closeNoteDock();
      renderAll();
      setStatus(`SOUND INST ${hex(state.instrument)}${fallback ? " · CURRENT FALLBACK" : ""}`);
      return;
    }

    setStatus("NO CHILD WORKSPACE", "amber");
  }

  function returnToParent() {
    if (state.view === "mix" && state.p3.mixReturn) {
      const target = state.p3.mixReturn;
      state.p3.mixReturn = null;
      restoreContext(target, "RETURN FROM MIX");
      return;
    }
    const parent = state.p3.parents.pop();
    if (parent) {
      restoreContext(parent);
      return;
    }
    if (state.focus.pane === "phrase") {
      state.view = "chain";
      baseSetFocus("chain", state.chainRow, 0);
      setStatus("RETURN CHAIN");
    } else if (state.focus.pane === "chain") {
      state.view = "song";
      baseSetFocus("song", state.songRow, state.track);
      setStatus("RETURN SONG");
    } else {
      setStatus("TOP LEVEL", "muted");
    }
  }

  function openMix() {
    if (state.view === "mix") return;
    state.p3.mixReturn = snapshotContext();
    state.view = "mix";
    state.dock = "mix";
    closeNoteDock();
    renderAll();
    setStatus(`MIX · T${state.track + 1}`);
  }

  function hierarchyNavigate(code) {
    if (code === "ArrowRight") return openChild();
    if (code === "ArrowLeft") return returnToParent();
    if (code === "ArrowDown") return openMix();
    if (code === "ArrowUp" && state.view === "mix") return returnToParent();
    setStatus("NO HIERARCHY TARGET", "muted");
  }

  moveFocus = function p3MoveFocus(code) {
    const { pane, row, col } = state.focus;
    const next = contract.moveWithin(pane, row, col, code, focusLimits(pane));
    setFocus(next.pane, next.row, next.col);
  };

  editCurrentCell = function p3EditCurrentCell(delta, coarse = false) {
    let value = currentValue();
    const { pane, col } = state.focus;
    if (value < 0) {
      if (pane === "phrase" && col === 0) value = contract.noteFromPitchClass(state.p3.noteOctave, 0);
      else if (pane === "phrase" && col === 1) value = 100;
      else value = 0;
    }
    const magnitude = coarse ? contract.LARGE : contract.SMALL;
    const step = contract.fieldStep(pane, col, magnitude);
    setCurrentValue(value + delta * step);
    const next = currentValue();
    const display = pane === "phrase" && col === 0 ? noteName(next) : String(next);
    setStatus(`EDIT ${display} · ${coarse ? "LARGE" : "SMALL"}`);
  };

  clearCurrentCell = function p3ClearCurrentCell() {
    const { pane, col } = state.focus;
    if (pane === "phrase" && col === 0) {
      const next = contract.nextNoteSpecial(currentValue(), EMPTY, NOTE_OFF);
      setCurrentValue(next);
      setStatus(next === NOTE_OFF ? "NOTE OFF" : "NOTE EMPTY", "amber");
      return;
    }
    baseClearCurrentCell();
  };

  keyDown = function p3KeyDown(code, repeat = false) {
    if (!repeat) heldKeys.add(code);
    const option = heldKeys.has("KeyA");
    const edit = heldKeys.has("KeyS");
    const shift = heldKeys.has("KeyZ");

    if (code.startsWith("Arrow")) {
      if (edit) {
        const intent = contract.editIntent(code);
        editCurrentCell(intent.delta, intent.magnitude === contract.LARGE);
      } else if (option) {
        optionNavigate(code);
      } else if (shift) {
        hierarchyNavigate(code);
      } else {
        moveFocus(code);
      }
      return;
    }

    if (code === "KeyS" && !repeat) {
      if (option) clearCurrentCell();
      else insertCurrentCell();
      return;
    }

    if (code === "KeyX" && !repeat) togglePlayback(shift).then(renderTransport);
  };

  function injectNoteDock() {
    const dock = document.createElement("section");
    dock.id = "p3NoteDock";
    dock.className = "p3-note-dock";
    dock.setAttribute("aria-hidden", "true");
    dock.innerHTML = `
      <header class="p3-note-header">
        <div><span>NOTE EDITOR</span><strong id="p3NoteContext">PHRASE 00 · ROW 00</strong></div>
        <button id="p3NoteClose" type="button" aria-label="Close note editor">×</button>
      </header>
      <div id="p3PitchGrid" class="p3-pitch-grid" aria-label="Chromatic note entry">
        ${PITCH_LABELS.map((label, pitch) => `<button type="button" data-pitch="${pitch}">${label}</button>`).join("")}
      </div>
      <div class="p3-note-controls">
        <button id="p3OctaveDown" type="button" aria-label="Previous octave">OCT−</button>
        <button id="p3OctaveValue" type="button" aria-label="Current octave">OCT <b>4</b></button>
        <button id="p3OctaveUp" type="button" aria-label="Next octave">OCT+</button>
        <button id="p3VelocityDown" type="button" aria-label="Decrease velocity">VEL−</button>
        <button id="p3VelocityValue" type="button" aria-label="Current velocity">VEL <b>100</b></button>
        <button id="p3VelocityUp" type="button" aria-label="Increase velocity">VEL+</button>
        <button id="p3EditStep" type="button" aria-label="Edit step">STEP <b>1</b></button>
        <button id="p3NoteOff" class="special" type="button">OFF</button>
        <button id="p3NoteEmpty" class="special" type="button">EMPTY</button>
      </div>`;

    $("#appShell").append(dock);

    const editButton = document.createElement("button");
    editButton.id = "p3EditButton";
    editButton.className = "phone-edit-button p3-edit-button";
    editButton.type = "button";
    editButton.textContent = "EDIT NOTE";
    editButton.hidden = true;
    $(".command-bar").append(editButton);

    $("#p3NoteClose").addEventListener("click", closeNoteDock);
    editButton.addEventListener("click", openNoteDock);
    $("#p3PitchGrid").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-pitch]");
      if (!button) return;
      writeNote(contract.noteFromPitchClass(state.p3.noteOctave, Number(button.dataset.pitch)), true);
    });
    $("#p3OctaveDown").addEventListener("click", () => changeOctave(-1));
    $("#p3OctaveUp").addEventListener("click", () => changeOctave(1));
    $("#p3VelocityDown").addEventListener("click", () => changeVelocity(-1));
    $("#p3VelocityUp").addEventListener("click", () => changeVelocity(1));
    $("#p3EditStep").addEventListener("click", cycleEditStep);
    $("#p3NoteOff").addEventListener("click", () => writeNote(NOTE_OFF, false));
    $("#p3NoteEmpty").addEventListener("click", () => writeNote(EMPTY, false));

    $("#phraseGrid").addEventListener("dblclick", (event) => {
      const cell = event.target.closest('[data-pane="phrase"][data-col="0"]');
      if (!cell) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openNoteDock();
    }, true);

    $("#mobileTabs").addEventListener("click", () => {
      state.p3.parents = [];
      state.p3.mixReturn = null;
      closeNoteDock();
    }, true);
  }

  function changeOctave(delta) {
    state.p3.noteOctave = clamp(state.p3.noteOctave + delta, -1, 9);
    refreshNoteDock();
  }

  function selectedPhraseStep() {
    if (state.focus.pane !== "phrase") return null;
    return phrase(state.phrase)[state.focus.row];
  }

  function changeVelocity(delta) {
    const step = selectedPhraseStep();
    if (!step) return;
    step.velocity = clamp(step.velocity + delta, 1, 127);
    persist();
    renderAll();
    setStatus(`VELOCITY ${step.velocity}`);
  }

  function cycleEditStep() {
    const index = EDIT_STEPS.indexOf(state.p3.editStep);
    state.p3.editStep = EDIT_STEPS[(index + 1) % EDIT_STEPS.length];
    refreshNoteDock();
    setStatus(`EDIT STEP ${state.p3.editStep}`);
  }

  function writeNote(value, preview) {
    if (state.focus.pane !== "phrase" || state.focus.col !== 0) return;
    const row = state.focus.row;
    const step = phrase(state.phrase)[row];
    step.note = value;
    if (value >= 0) state.p3.noteOctave = Math.floor(value / 12) - 1;
    persist();
    if (preview && value >= 0 && audio.ready) auditionCurrentNote(value, step.velocity ?? 100);

    const nextRow = clamp(row + state.p3.editStep, 0, PHRASE_ROWS - 1);
    state.p3.noteDockOpen = true;
    state.view = "phrase";
    baseSetFocus("phrase", nextRow, 0);
    refreshNoteDock();
    setStatus(value === NOTE_OFF ? "NOTE OFF" : value === EMPTY ? "NOTE EMPTY" : `NOTE ${noteName(value)}`);
  }

  function openNoteDock() {
    if (!isPhone() || state.focus.pane !== "phrase" || state.focus.col !== 0) return;
    const value = currentValue();
    if (value >= 0) state.p3.noteOctave = Math.floor(value / 12) - 1;
    state.p3.noteDockOpen = true;
    refreshNoteDock();
    setStatus("NOTE EDITOR OPEN");
  }

  function closeNoteDock() {
    state.p3.noteDockOpen = false;
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
    $("#p3NoteContext").textContent = `PHRASE ${hex(state.phrase)} · ROW ${hex(state.focus.row)} · ${noteName(step.note)}`;
    $("#p3OctaveValue b").textContent = state.p3.noteOctave;
    $("#p3VelocityValue b").textContent = step.velocity;
    $("#p3EditStep b").textContent = state.p3.editStep;
    const pitchClass = step.note >= 0 ? step.note % 12 : -1;
    $$("#p3PitchGrid button").forEach((button) => button.classList.toggle("active", Number(button.dataset.pitch) === pitchClass));
    dock.setAttribute("aria-hidden", String(!state.p3.noteDockOpen));
    document.body.classList.toggle("p3-note-open", state.p3.noteDockOpen);
  }

  setFocus = function p3SetFocus(pane, row, col, shouldFocus = true) {
    const sameCell = state.focus.pane === pane && state.focus.row === row && state.focus.col === col;
    const pointerSelection = shouldFocus === false;
    const noteTarget = pane === "phrase" && col === 0;

    if (pointerSelection && sameCell && noteTarget && isPhone()) {
      openNoteDock();
      return;
    }

    if (!noteTarget) closeNoteDock();
    baseSetFocus(pane, row, col, shouldFocus);
    if (state.p3.noteDockOpen && noteTarget) refreshNoteDock();
  };

  if (!globalThis.BRKTRKRenderRuntime?.registerAfterRender) {
    throw new Error("C3 render runtime must load before P3");
  }
  globalThis.BRKTRKRenderRuntime.registerAfterRender("p3.note-dock", refreshNoteDock);

  window.addEventListener("resize", () => {
    refreshNoteDock();
  });

  injectNoteDock();
  renderAll();
})();