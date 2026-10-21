(() => {
  const FX_SLOTS = 3;
  const FIRST_FX_COL = 3;
  const PHRASE_COLS = 3 + FX_SLOTS * 2;

  function describePhraseColumn(col) {
    const numeric = Number(col);
    if (!Number.isInteger(numeric) || numeric < FIRST_FX_COL || numeric >= PHRASE_COLS) return null;
    const relative = numeric - FIRST_FX_COL;
    return Object.freeze({
      slotIndex: Math.floor(relative / 2),
      component: relative % 2 === 0 ? "command" : "value",
    });
  }

  function commandColumn(slotIndex) {
    return FIRST_FX_COL + Number(slotIndex) * 2;
  }

  function valueColumn(slotIndex) {
    return commandColumn(slotIndex) + 1;
  }

  function runtimeHint(command, value) {
    if (command === 0) return "empty";
    if (command === 0x01) return `CUT · release after ${value} host ticks`;
    if (command === 0x04) return `DLY · delay row execution by ${value} host ticks`;
    if (command === 0x05) {
      const interval = value & 0x0F;
      const wait = (value >> 4) & 0x0F;
      return interval === 0
        ? `RET · one phase-reset retrigger after ${wait} host ticks`
        : "RET repeated/volume-ramp form is preserved but not executed yet";
    }
    return "preserved unknown command · no runtime consumer";
  }

  const api = Object.freeze({ FX_SLOTS, FIRST_FX_COL, PHRASE_COLS, describePhraseColumn, commandColumn, valueColumn, runtimeHint });
  globalThis.BRKTRKPhraseFxSurface = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (typeof document === "undefined") return;

  const styleHref = "./phrase-fx-surface.css";
  if (!document.querySelector(`link[href="${styleHref}"]`)) {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = styleHref;
    document.head.append(style);
  }

  if (typeof focusLimits === "function") {
    const baseFocusLimits = focusLimits;
    focusLimits = function phraseFxFocusLimits(pane) {
      if (pane === "phrase") return { rows: PHRASE_ROWS, cols: PHRASE_COLS };
      return baseFocusLimits(pane);
    };
  }

  if (typeof renderPhrase === "function") {
    renderPhrase = function phraseFxRenderPhrase() {
      const grid = $("#phraseGrid");
      grid.replaceChildren(headerRow(["ROW", "NOTE", "VEL", "INST", "FX1", "VAL1", "FX2", "VAL2", "FX3", "VAL3"]));
      const source = phrase(state.phrase);
      for (let row = 0; row < PHRASE_ROWS; row += 1) {
        const step = source[row];
        const rowEl = document.createElement("div");
        rowEl.className = rowClasses("phrase", row);
        rowEl.dataset.rowPane = "phrase";
        rowEl.dataset.row = row;
        rowEl.setAttribute("role", "row");

        const index = document.createElement("span");
        index.className = "grid-cell index";
        index.textContent = hex(row);
        rowEl.append(index);

        const instrument = instrumentReferencePresentation(step.instrument, model.instrumentPool);
        // UX0-07 (#374): velocity and Instrument belong to the row's note. This
        // renderer replaces the base one, so it asks the same shared verdict
        // rather than keeping a second opinion about the same row.
        const rowPresentation = globalThis.BRKTRKPhraseRowPresentation;
        const presentation = rowPresentation?.phraseRowPresentation(step);
        const inert = rowPresentation?.INOPERATIVE_CLASS ?? "inoperative";
        const inertIf = (operative) => (presentation && operative === false ? inert : "");
        const values = [
          { text: noteName(step.note), className: step.note < 0 ? "empty" : "value", title: "Note" },
          {
            text: String(step.velocity),
            className: inertIf(presentation?.velocityOperative),
            title: rowPresentation?.velocityTitle(presentation) ?? "Velocity",
          },
          {
            text: instrument.text,
            className: `${instrument.state === "empty" ? "empty" : `instrument ${instrument.state}`} ${inertIf(presentation?.instrumentOperative)}`.trim(),
            title: rowPresentation?.instrumentTitle(presentation, instrument.title) ?? instrument.title,
          },
        ];
        for (let slotIndex = 0; slotIndex < FX_SLOTS; slotIndex += 1) {
          const slot = step.fx?.[slotIndex] ?? { command: 0, value: 0 };
          const command = fxCommandCode(slot);
          const value = fxValueByte(slot);
          const name = fxName(slot);
          const hint = runtimeHint(command, value);
          values.push({
            text: name,
            className: command === 0 ? "empty" : "fx",
            title: command === 0
              ? `FX${slotIndex + 1} command · empty`
              : `FX${slotIndex + 1} command ${name} · ${hint}`,
          });
          values.push({
            text: hex(value),
            className: command === 0 ? "empty fx-value" : "fx-value",
            title: `FX${slotIndex + 1} value ${hex(value)} · ${hint}`,
          });
        }

        values.forEach((value, col) => {
          const selected = state.focus.pane === "phrase" && state.focus.row === row && state.focus.col === col;
          rowEl.append(makeCell({
            pane: "phrase",
            row,
            col,
            text: value.text,
            classes: `${value.className} ${selected ? "selected" : ""}`,
            title: value.title,
          }));
        });
        grid.append(rowEl);
      }
      $("#phraseTitle").textContent = hex(state.phrase);
    };
  }

  if (typeof currentValue === "function") {
    const baseCurrentValue = currentValue;
    currentValue = function phraseFxCurrentValue() {
      if (state.focus.pane !== "phrase") return baseCurrentValue();
      const descriptor = describePhraseColumn(state.focus.col);
      if (!descriptor) return baseCurrentValue();
      const step = phrase(state.phrase)[state.focus.row];
      const slot = step.fx?.[descriptor.slotIndex] ?? { command: 0, value: 0 };
      return descriptor.component === "command" ? fxCommandCode(slot) : fxValueByte(slot);
    };
  }

  if (typeof setCurrentValue === "function") {
    const baseSetCurrentValue = setCurrentValue;
    setCurrentValue = function phraseFxSetCurrentValue(value) {
      if (state.focus.pane !== "phrase") return baseSetCurrentValue(value);
      const descriptor = describePhraseColumn(state.focus.col);
      if (!descriptor) return baseSetCurrentValue(value);
      const step = phrase(state.phrase)[state.focus.row];
      step.fx ??= Array.from({ length: FX_SLOTS }, () => ({ command: 0, value: 0 }));
      const next = clamp(Math.round(Number(value) || 0), 0, 255);
      const domain = globalThis.BRKTRKStores?.project?.phraseSteps;
      if (domain?.setFxComponent) {
        domain.setFxComponent(state.phrase, state.focus.row, descriptor.slotIndex, descriptor.component, next, {
          source: "bootstrap-fx-command-value-edit",
        });
      } else {
        const before = step.fx[descriptor.slotIndex] ?? { command: 0, value: 0 };
        if (descriptor.component === "command") {
          step.fx[descriptor.slotIndex] = {
            command: next,
            value: next === 0 ? 0 : fxValueByte(before),
          };
        } else {
          const command = fxCommandCode(before);
          step.fx[descriptor.slotIndex] = {
            command,
            value: command === 0 ? 0 : next,
          };
        }
      }
      persist();
      renderAll();
      focusSelectedCell();
    };
  }

  if (typeof clearCurrentCell === "function") {
    const baseClearCurrentCell = clearCurrentCell;
    clearCurrentCell = function phraseFxClearCurrentCell() {
      const descriptor = state.focus.pane === "phrase" ? describePhraseColumn(state.focus.col) : null;
      if (!descriptor) return baseClearCurrentCell();
      setCurrentValue(0);
      setStatus(descriptor.component === "command" ? "FX COMMAND CLEARED" : "FX VALUE RESET", "amber");
    };
  }

  if (typeof renderAll === "function") renderAll();
})();
