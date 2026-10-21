(() => {
  const commands = globalThis.BRKTRKCommands;
  const fields = globalThis.BRKTRKFieldSchema;
  const transactions = globalThis.BRKTRKPreparedEntryTransaction;
  const entryTypes = globalThis.BRKTRKNavigationEntryState;
  const entryState = commands?.stores?.navigation?.entryState;
  if (!commands?.installed || !fields || !transactions || !entryTypes || !entryState || !globalThis.BRKTRKValueDock) {
    throw new Error("P3.4 note entry requires commands, field schema, NavigationStore entry state, prepared transaction contract and Value Dock");
  }

  const schemaEnv = { state, model, chain, phrase, firstUnused, noteName, fxName, hex, clamp, EMPTY, NOTE_OFF };
  const WHITE_KEYS = [
    { pitch: 0, label: "C" }, { pitch: 2, label: "D" }, { pitch: 4, label: "E" },
    { pitch: 5, label: "F" }, { pitch: 7, label: "G" }, { pitch: 9, label: "A" }, { pitch: 11, label: "B" },
  ];
  const BLACK_KEYS = [
    { pitch: 1, label: "C#", left: "14.2857%" },
    { pitch: 3, label: "D#", left: "28.5714%" },
    { pitch: 6, label: "F#", left: "57.1429%" },
    { pitch: 8, label: "G#", left: "71.4286%" },
    { pitch: 10, label: "A#", left: "85.7143%" },
  ];

  let repeatDelay = 0;
  let repeatTimer = 0;
  let adjustmentQueue = Promise.resolve();
  let lastEditorRow = null;
  let exactEditSession = null;

  function stopEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function stopRepeat() {
    window.clearTimeout(repeatDelay);
    window.clearInterval(repeatTimer);
    repeatDelay = 0;
    repeatTimer = 0;
  }

  function queueAdjustment(action) {
    adjustmentQueue = adjustmentQueue.then(action).catch((error) => console.error(error));
    return adjustmentQueue;
  }

  function bindRepeat(button, action) {
    button.addEventListener("pointerdown", (event) => {
      stopEvent(event);
      try { button.setPointerCapture?.(event.pointerId); } catch {}
      stopRepeat();
      queueAdjustment(action);
      repeatDelay = window.setTimeout(() => {
        repeatTimer = window.setInterval(() => queueAdjustment(action), 65);
      }, 330);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, stopRepeat);
  }

  function instrumentText(value) {
    return Number(value) < 0 ? "--" : hex(Number(value));
  }

  function selectedStep() {
    if (state.focus.pane !== "phrase") return null;
    return phrase(state.phrase)[state.focus.row];
  }

  function valueBounds(descriptor) {
    return {
      min: Object.hasOwn(descriptor, "emptyValue") ? descriptor.emptyValue : descriptor.min,
      max: descriptor.max,
    };
  }

  function syncPreparedValuesFromStep(step = selectedStep(), options = {}) {
    if (!step) return false;
    const prepared = entryState.getPreparedEntry();
    if (prepared.locked && options.force !== true) return false;
    const pair = entryTypes.preparedPairFromStep(step);
    entryState.setPreparedEntry({
      ...pair,
      ...(Object.hasOwn(options, "locked") ? { locked: Boolean(options.locked) } : {}),
    }, { source: options.source ?? "note-editor-sync-row" });
    return true;
  }

  function setEntryLock(nextLocked) {
    const prepared = entryState.getPreparedEntry();
    const after = entryTypes.transitionPreparedLock(prepared, selectedStep(), nextLocked);
    entryState.setPreparedEntry(after, { source: nextLocked ? "note-editor-lock" : "note-editor-unlock" });
    refresh();
    setStatus(nextLocked ? "VEL + INST LOCKED" : "VEL + INST FROM CURRENT ROW");
  }

  function syncMobileSheetViewport(reason = "note-entry") {
    return globalThis.BRKTRKContextualSheetViewport?.sync?.(reason) ?? false;
  }

  function revealSelectedRow() {
    return globalThis.BRKTRKContextualSheetViewport?.revealSelectedCell?.("note-entry-reveal") ?? false;
  }

  function refresh() {
    const prepared = entryState.getPreparedEntry();
    const currentVelocity = $("#p33CurrentVelocity b");
    const currentInstrument = $("#p33CurrentInstrument b");
    const preview = $("#p33Preview b");
    const lock = $("#p33EntryLock");
    if (currentVelocity) currentVelocity.textContent = String(prepared.velocity);
    if (currentInstrument) currentInstrument.textContent = instrumentText(prepared.instrument);
    if (preview) preview.textContent = prepared.preview ? "ON" : "OFF";
    $("#p33Preview")?.setAttribute("aria-pressed", String(prepared.preview));
    if (lock) {
      lock.setAttribute("aria-pressed", String(prepared.locked));
      lock.setAttribute("aria-label", prepared.locked ? "Unlock velocity and instrument" : "Lock velocity and instrument");
      lock.querySelector("span").textContent = prepared.locked ? "🔒" : "🔓";
      lock.querySelector("b").textContent = prepared.locked ? "LOCKED" : "LOCK";
    }
    $("#p33CurrentStep")?.classList.toggle("locked", prepared.locked);
    syncMobileSheetViewport("note-entry-refresh");
  }

  function pianoMarkup() {
    return `
      <div class="p33-white-keys">
        ${WHITE_KEYS.map(({ pitch, label }) => `<button class="p33-white-key" type="button" data-pitch="${pitch}" aria-label="${label}"><span>${label}</span></button>`).join("")}
      </div>
      <div class="p33-black-keys" aria-hidden="false">
        ${BLACK_KEYS.map(({ pitch, label, left }) => `<button class="p33-black-key" type="button" data-pitch="${pitch}" aria-label="${label}" style="--p33-key-left:${left}"><span>${label}</span></button>`).join("")}
      </div>`;
  }

  function valueRowMarkup() {
    return `
      <div class="p33-inline-field">
        <span>VEL</span>
        <div><button type="button" data-p33-adjust="velocity" data-delta="-1" aria-label="Decrease velocity">−</button><button id="p33CurrentVelocity" type="button" aria-label="Set velocity exactly"><b>100</b></button><button type="button" data-p33-adjust="velocity" data-delta="1" aria-label="Increase velocity">+</button></div>
      </div>
      <div class="p33-inline-field">
        <span>INST</span>
        <div><button type="button" data-p33-adjust="instrument" data-delta="-1" aria-label="Previous instrument">−</button><button id="p33CurrentInstrument" type="button" aria-label="Set instrument exactly"><b>--</b></button><button type="button" data-p33-adjust="instrument" data-delta="1" aria-label="Next instrument">+</button></div>
      </div>
      <button id="p33EntryLock" class="p33-entry-lock" type="button" aria-pressed="false" aria-label="Lock velocity and instrument"><span aria-hidden="true">🔓</span><b>LOCK</b></button>`;
  }

  function inject() {
    const dock = $("#p3NoteDock");
    const pitchGrid = $("#p3PitchGrid");
    const controls = dock?.querySelector(".p3-note-controls");
    if (!dock || !pitchGrid || !controls || $("#p33CurrentStep")) return;

    pitchGrid.classList.add("p33-piano");
    pitchGrid.setAttribute("aria-label", "Piano note entry");
    pitchGrid.innerHTML = pianoMarkup();

    const values = document.createElement("section");
    values.id = "p33CurrentStep";
    values.className = "p33-value-row";
    values.setAttribute("aria-label", "Velocity and instrument for the current note entry");
    values.innerHTML = valueRowMarkup();
    pitchGrid.before(values);

    const preview = document.createElement("button");
    preview.id = "p33Preview";
    preview.type = "button";
    preview.setAttribute("aria-pressed", "true");
    preview.innerHTML = `PREVIEW <b>ON</b>`;
    controls.append(preview);

    dock.dataset.noteEntry = "p3.5-sticky";
    dock.dataset.pitchLayout = "piano";
    dock.dataset.valueModel = "sticky-row";
    dock.dataset.entryLock = "e6";

    values.querySelectorAll("[data-p33-adjust]").forEach((button) => {
      bindRepeat(button, () => adjustCurrentField(button.dataset.p33Adjust, Number(button.dataset.delta)));
    });

    const dockObserver = new MutationObserver(() => {
      if (dock.getAttribute("aria-hidden") === "false") {
        const prepared = entryState.getPreparedEntry();
        if (!prepared.applying && !prepared.locked) syncPreparedValuesFromStep();
        lastEditorRow = `${state.phrase}:${state.focus.row}`;
        refresh();
      } else {
        syncMobileSheetViewport("note-entry-hidden");
      }
    });
    dockObserver.observe(dock, { attributes: true, attributeFilter: ["aria-hidden"] });
    refresh();
  }

  async function writePreparedNote(value) {
    const sounding = value >= 0;
    const startRow = state.focus.row;
    const prepared = entryState.getPreparedEntry();
    const transaction = sounding
      ? transactions.create({
        phrase: state.phrase,
        row: startRow,
        before: selectedStep(),
        note: value,
        velocity: prepared.velocity,
        instrument: prepared.instrument,
      })
      : null;
    entryState.setPreparedValue("applying", sounding, { source: "prepared-note-editor" });

    try {
      const result = await commands.dispatch({
        type: "note.write",
        value,
        target: transaction?.target,
        transaction,
        preview: sounding && prepared.preview,
        source: "prepared-note-editor",
      });
      const nextRow = clamp(startRow + prepared.editStep, 0, PHRASE_ROWS - 1);
      if (result?.ok !== false && nextRow !== startRow) {
        await commands.dispatch({
          type: "cursor.select",
          pane: "phrase",
          row: nextRow,
          col: 0,
          focus: true,
          transient: true,
          source: "prepared-note-auto-advance",
        });
        lastEditorRow = `${state.phrase}:${nextRow}`;
      }
      revealSelectedRow();
      return result;
    } finally {
      entryState.setPreparedValue("applying", false, { source: "prepared-note-editor" });
      refresh();
    }
  }

  async function editCurrentColumn(col) {
    const row = state.focus.row;
    const prepared = entryState.getPreparedEntry();
    exactEditSession = {
      column: col,
      descriptorId: fields.resolve("phrase", col)?.id ?? null,
      wasLocked: prepared.locked,
    };
    const initialValue = col === 1 ? prepared.velocity : prepared.instrument;
    await commands.dispatch({ type: "cursor.select", pane: "phrase", row, col, focus: false, transient: true, source: "note-editor-current-field" });
    globalThis.BRKTRKValueDock?.open?.({
      returnSheet: "note",
      returnCursor: { pane: "phrase", row, col: 0 },
      source: "note-editor-exact-field",
      draftOnly: prepared.locked,
      initialValue,
    });
  }

  async function adjustCurrentField(key, delta) {
    const col = key === "velocity" ? 1 : 2;
    const row = state.focus.row;
    const descriptor = fields.resolve("phrase", col);
    const cursor = { pane: "phrase", row, col };
    const prepared = entryState.getPreparedEntry();
    const current = fields.read(schemaEnv, descriptor, cursor);
    const bounds = valueBounds(descriptor);
    let next;
    let preparedAfter = null;

    if (prepared.locked) {
      const transition = entryTypes.transitionLockedFieldEdit(prepared, selectedStep(), key, delta);
      next = transition.value;
      preparedAfter = transition.prepared;
    } else {
      const base = Number.isFinite(current) ? current : descriptor.defaultValue;
      next = clamp(base + delta, bounds.min, bounds.max);
    }
    if (next === current && !prepared.locked) return;

    const result = await commands.dispatch({
      type: "field.setExact",
      value: next,
      cursor,
      source: "note-editor-inline-field",
    });
    if (result?.ok === false) return;

    if (preparedAfter) {
      entryState.setPreparedEntry(preparedAfter, { source: "note-editor-inline-unlock" });
    } else {
      entryState.setPreparedValue(col === 1 ? "velocity" : "instrument", next, {
        source: "note-editor-inline-field",
      });
    }
    refresh();
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target.closest("[data-p33-adjust]")) {
      stopEvent(event);
      return;
    }
    if (target.closest("#p33EntryLock")) {
      stopEvent(event);
      setEntryLock(!entryState.getPreparedEntry().locked);
      return;
    }
    const pitch = target.closest("#p3PitchGrid [data-pitch]");
    if (pitch) {
      stopEvent(event);
      writePreparedNote(BRKTRKP3.noteFromPitchClass(entryState.getPreparedEntry().octave, Number(pitch.dataset.pitch)));
      return;
    }
    if (target.closest("#p3NoteOff")) {
      stopEvent(event);
      writePreparedNote(NOTE_OFF);
      return;
    }
    if (target.closest("#p3NoteEmpty")) {
      stopEvent(event);
      writePreparedNote(EMPTY);
      return;
    }
    if (target.closest("#p33CurrentVelocity")) {
      stopEvent(event);
      editCurrentColumn(1);
      return;
    }
    if (target.closest("#p33CurrentInstrument")) {
      stopEvent(event);
      editCurrentColumn(2);
      return;
    }
    if (target.closest("#p33Preview")) {
      stopEvent(event);
      const preview = !entryState.getPreparedEntry().preview;
      entryState.setPreparedValue("preview", preview, { source: "note-editor-preview" });
      refresh();
      setStatus(`NOTE PREVIEW ${preview ? "ON" : "OFF"}`);
    }
  }, true);

  commands.subscribe((record) => {
    const source = record?.command?.source ?? "";
    const rowKey = state.focus.pane === "phrase" ? `${state.phrase}:${state.focus.row}` : null;

    if (exactEditSession
        && record?.ok !== false
        && record?.changeSet?.target === exactEditSession.descriptorId
        && source.startsWith("value-dock")) {
      const after = entryTypes.transitionLockedExactCommit(entryState.getPreparedEntry(), selectedStep());
      entryState.setPreparedEntry(after, { source: "note-editor-exact-commit" });
      exactEditSession = null;
    } else if (rowKey && rowKey !== lastEditorRow && source !== "prepared-note-auto-advance"
        && entryState.getActiveSheet() === "note" && !entryState.getPreparedEntry().locked) {
      syncPreparedValuesFromStep();
    }

    if (rowKey) lastEditorRow = rowKey;
    refresh();
  });

  commands.stores.navigation.subscribe("navigation", (changeSet) => {
    if (changeSet?.target === "navigation.activeSheet"
        && changeSet.before === "value" && changeSet.after !== "value"
        && exactEditSession) {
      exactEditSession = null;
    }
  });

  inject();
  refresh();

  function releaseInput() {
    stopRepeat();
  }

  globalThis.BRKTRKNoteEntry = Object.freeze({
    refresh,
    writePreparedNote,
    revealSelectedRow,
    syncMobileSheetViewport,
    setEntryLock,
    releaseInput,
  });
})();
