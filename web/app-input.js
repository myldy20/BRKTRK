function stopPlayback() {
  audio.stop();
  state.playing = false;
  state.playhead = locatePlayhead(-1);
  $("#playButton").setAttribute("aria-pressed", "false");
  renderPlayheads();
  setStatus("STOPPED", "muted");
}

function activeCellKey() {
  const { pane, row, col } = state.focus;
  return `${pane}:${row}:${col}`;
}

function focusLimits(pane) {
  if (pane === "song") return { rows: SONG_ROWS, cols: TRACKS };
  if (pane === "chain") return { rows: CHAIN_ROWS, cols: 2 };
  return { rows: PHRASE_ROWS, cols: 6 };
}

function syncContextFromFocus() {
  const { pane, row, col } = state.focus;
  if (pane === "song") {
    state.songRow = row;
    state.track = col;
    const chainId = model.song[row][col];
    if (chainId >= 0) {
      state.chain = chainId;
      state.lastChain = chainId;
      const first = chain(chainId, false)?.findIndex((entry) => entry.phrase >= 0) ?? -1;
      state.chainRow = Math.max(0, first);
      const phraseId = chain(chainId, false)?.[state.chainRow]?.phrase ?? EMPTY;
      if (phraseId >= 0) {
        state.phrase = phraseId;
        state.lastPhrase = phraseId;
      }
    }
  } else if (pane === "chain") {
    state.chainRow = row;
    const phraseId = chain(state.chain)?.[row]?.phrase ?? EMPTY;
    if (phraseId >= 0) {
      state.phrase = phraseId;
      state.lastPhrase = phraseId;
    }
  } else {
    state.phraseRow = row;
    const step = phrase(state.phrase)?.[row];
    if (step?.instrument >= 0) state.instrument = step.instrument;
  }
}

function setFocus(pane, row, col, shouldFocus = true) {
  const limits = focusLimits(pane);
  state.focus = {
    pane,
    row: clamp(row, 0, limits.rows - 1),
    col: clamp(col, 0, limits.cols - 1),
  };
  syncContextFromFocus();
  renderAll();
  if (shouldFocus) focusSelectedCell();
}

function revealFocusedCell(cell) {
  const grid = cell?.closest(".grid");
  if (!grid) return;
  const gridRect = grid.getBoundingClientRect();
  const headerRect = grid.querySelector(".grid-header")?.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const visibleTop = Math.max(gridRect.top + 4, (headerRect?.bottom ?? gridRect.top) + 2);
  const visibleBottom = gridRect.bottom - 4;
  if (cellRect.bottom > visibleBottom) grid.scrollTop += cellRect.bottom - visibleBottom + 6;
  else if (cellRect.top < visibleTop) grid.scrollTop -= visibleTop - cellRect.top + 6;
}

function focusSelectedCell() {
  requestAnimationFrame(() => {
    const selector = `[data-pane="${state.focus.pane}"][data-row="${state.focus.row}"][data-col="${state.focus.col}"]`;
    const cell = $(selector);
    cell?.focus({ preventScroll: true });
    const sheetOpen = document.body.classList.contains("p3-note-open") || document.body.classList.contains("p32-value-open");
    if (sheetOpen && state.focus.pane === "phrase" && globalThis.BRKTRKNoteEntry?.revealSelectedRow) {
      globalThis.BRKTRKNoteEntry.revealSelectedRow();
      return;
    }
    revealFocusedCell(cell);
  });
}

function moveFocus(code, page = false) {
  const { pane, row, col } = state.focus;
  const amount = page ? 16 : 1;
  if (code === "ArrowUp") return setFocus(pane, row - amount, col);
  if (code === "ArrowDown") return setFocus(pane, row + amount, col);
  if (code === "ArrowLeft") {
    if (col > 0) return setFocus(pane, row, col - 1);
    if (pane === "phrase") return setFocus("chain", state.chainRow, 1);
    if (pane === "chain") return setFocus("song", state.songRow, state.track);
  }
  if (code === "ArrowRight") {
    const limits = focusLimits(pane);
    if (col < limits.cols - 1) return setFocus(pane, row, col + 1);
    if (pane === "song") return setFocus("chain", state.chainRow, 0);
    if (pane === "chain") return setFocus("phrase", state.phraseRow, 0);
  }
}

function optionNavigate(code) {
  if (code === "ArrowLeft" || code === "ArrowRight") {
    state.track = clamp(state.track + (code === "ArrowRight" ? 1 : -1), 0, TRACKS - 1);
    if (state.focus.pane === "song") state.focus.col = state.track;
    renderAll();
    focusSelectedCell();
    setStatus(`TRACK ${state.track + 1}`);
    return;
  }
  const delta = code === "ArrowDown" ? 1 : -1;
  if (state.focus.pane === "phrase") {
    state.phrase = clamp(state.phrase + delta, 0, 255);
    state.lastPhrase = state.phrase;
    phrase(state.phrase);
    renderAll();
    setStatus(`PHRASE ${hex(state.phrase)}`);
  } else {
    state.chain = clamp(state.chain + delta, 0, 255);
    state.lastChain = state.chain;
    chain(state.chain);
    const phraseId = chain(state.chain)[state.chainRow].phrase;
    if (phraseId >= 0) state.phrase = phraseId;
    renderAll();
    setStatus(`CHAIN ${hex(state.chain)}`);
  }
}

function currentValue() {
  const { pane, row, col } = state.focus;
  if (pane === "song") return model.song[row][col];
  if (pane === "chain") {
    const entry = chain(state.chain)[row];
    return col === 0 ? entry.phrase : entry.transpose;
  }
  const step = phrase(state.phrase)[row];
  if (col === 0) return step.note;
  if (col === 1) return step.velocity;
  if (col === 2) return step.instrument;
  return fxCommandCode(step.fx[col - 3]);
}

function setCurrentValue(value) {
  const { pane, row, col } = state.focus;
  if (pane === "song") {
    model.song[row][col] = clamp(value, EMPTY, 255);
    if (model.song[row][col] >= 0) {
      state.chain = model.song[row][col];
      state.lastChain = state.chain;
      chain(state.chain);
    }
  } else if (pane === "chain") {
    const entry = chain(state.chain)[row];
    if (col === 0) {
      entry.phrase = clamp(value, EMPTY, 255);
      if (entry.phrase >= 0) {
        state.phrase = entry.phrase;
        state.lastPhrase = entry.phrase;
        phrase(entry.phrase);
      }
    } else {
      entry.transpose = clamp(value, -48, 48);
    }
  } else {
    const step = phrase(state.phrase)[row];
    if (col === 0) step.note = clamp(value, NOTE_OFF, 127);
    else if (col === 1) step.velocity = clamp(value, 1, 127);
    else if (col === 2) {
      step.instrument = clamp(value, EMPTY, 255);
      if (step.instrument >= 0) state.instrument = step.instrument;
    } else {
      const slot = col - 3;
      const command = clamp(Math.round(value), 0, 255);
      const domain = globalThis.BRKTRKStores?.project?.phraseSteps;
      if (domain?.setFxComponent) {
        domain.setFxComponent(state.phrase, row, slot, "command", command, { source: "bootstrap-field-edit" });
      } else {
        const before = step.fx?.[slot] ?? emptyFxSlot();
        step.fx[slot] = { command, value: command === 0 ? 0 : fxValueByte(before) };
      }
    }
  }
  persist();
  renderAll();
  focusSelectedCell();
}

function clearCurrentCell() {
  const { pane, col } = state.focus;
  if (pane === "chain" && col === 1) setCurrentValue(0);
  else if (pane === "phrase" && col === 1) setCurrentValue(100);
  else if (pane === "phrase" && col >= 3) setCurrentValue(0);
  else setCurrentValue(EMPTY);
  setStatus("CELL CLEARED", "amber");
}

function editCurrentCell(delta, coarse = false) {
  let value = currentValue();
  const { pane, col } = state.focus;
  if (value < 0) {
    if (pane === "phrase" && col === 0) value = 48;
    else if (pane === "phrase" && col === 1) value = 100;
    else value = 0;
  }
  let step = coarse ? 16 : 1;
  if (pane === "chain" && col === 1) step = coarse ? 12 : 1;
  if (pane === "phrase" && col === 1) step = coarse ? 8 : 1;
  setCurrentValue(value + delta * step);
  setStatus(`EDIT ${currentValue()}`);
}

function auditionCurrentNote(note, velocity = 100) {
  if (!audio.ready || state.playing) return false;
  const project = globalThis.BRKTRKStores?.project?.getState?.() ?? model;
  const instrument = project?.instrumentPool?.[state.instrument];
  if (!instrument?.engineRef?.moduleId || !instrument?.engineRef?.engineId) return false;
  return globalThis.BRKTRKProductionEngineBootstrap?.audition?.({
    track: state.track,
    instrumentId: state.instrument,
    note,
    velocity,
    durationMs: 240,
  }) ?? false;
}

function insertCurrentCell() {
  const key = activeCellKey();
  const now = performance.now();
  const doubleTap = state.lastEditCell === key && now - state.lastEditTapAt < 300;
  state.lastEditCell = key;
  state.lastEditTapAt = now;

  const { pane, row, col } = state.focus;
  if (pane === "song") {
    if (doubleTap || model.song[row][col] < 0) {
      const id = doubleTap ? firstUnused(model.chains) : state.lastChain;
      model.song[row][col] = id;
      state.chain = id;
      state.lastChain = id;
      chain(id);
      setStatus(doubleTap ? `NEW CHAIN ${hex(id)}` : `CHAIN ${hex(id)} INSERTED`);
    } else {
      state.chain = model.song[row][col];
      state.view = "chain";
      setStatus(`OPEN CHAIN ${hex(state.chain)}`);
    }
  } else if (pane === "chain" && col === 0) {
    const entry = chain(state.chain)[row];
    if (doubleTap || entry.phrase < 0) {
      const id = doubleTap ? firstUnused(model.phrases) : state.lastPhrase;
      entry.phrase = id;
      state.phrase = id;
      state.lastPhrase = id;
      phrase(id);
      setStatus(doubleTap ? `NEW PHRASE ${hex(id)}` : `PHRASE ${hex(id)} INSERTED`);
    } else {
      state.phrase = entry.phrase;
      setStatus(`OPEN PHRASE ${hex(state.phrase)}`);
    }
  } else if (pane === "phrase" && col === 0) {
    const step = phrase(state.phrase)[row];
    if (step.note < 0) step.note = 48;
    auditionCurrentNote(step.note, step.velocity ?? 100);
    setStatus(`NOTE ${noteName(step.note)}`);
  } else if (currentValue() < 0) {
    setCurrentValue(0);
  } else {
    editCurrentCell(1, false);
    return;
  }
  persist();
  renderAll();
  focusSelectedCell();
}

const heldKeys = new Set();
function keyDown(code, repeat = false) {
  if (!repeat) heldKeys.add(code);
  const option = heldKeys.has("KeyA");
  const edit = heldKeys.has("KeyS");
  const shift = heldKeys.has("KeyZ");

  if (code.startsWith("Arrow")) {
    if (edit) editCurrentCell(code === "ArrowUp" || code === "ArrowRight" ? 1 : -1, code === "ArrowLeft" || code === "ArrowRight");
    else if (option) optionNavigate(code);
    else moveFocus(code, shift);
    return;
  }
  if (code === "KeyS" && !repeat) {
    if (option) clearCurrentCell();
    else insertCurrentCell();
    return;
  }
  if (code === "KeyX" && !repeat) {
    togglePlayback(shift).then(renderTransport);
  }
}

function keyUp(code) {
  heldKeys.delete(code);
}