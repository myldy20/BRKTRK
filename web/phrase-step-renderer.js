(() => {
  function setText(cell, value) {
    if (!cell) return;
    const markers = [
      cell.querySelector?.(".p35-effective-note"),
      cell.querySelector?.(".condition-badge"),
    ].filter(Boolean);
    cell.textContent = value;
    for (const marker of markers) cell.append(marker);
  }

  function renderConditionBadge(cell, step, row) {
    if (!cell) return;
    const api = globalThis.BRKTRKPhraseConditionPresentation;
    const text = api?.badge(step?.condition) ?? "";
    let marker = cell.querySelector(".condition-badge");
    if (!text) {
      marker?.remove();
      return;
    }
    if (!marker) {
      marker = document.createElement("span");
      marker.className = "badge condition-badge";
      cell.append(marker);
    }
    marker.textContent = text;
    marker.title = api?.title(step?.condition) ?? "";
    marker.dataset.phraseConditionRow = String(row);
  }

  const rowPresentation = () => globalThis.BRKTRKPhraseRowPresentation;
  const INERT = "inoperative";

  function resetValueClasses(cell) {
    if (!cell) return;
    cell.classList.remove("empty", "value", "instrument", "unresolved", "resolved", "fx", INERT);
  }

  // UX0-07 (#374). Shares one verdict with the full grid renderer so a
  // single-row redraw cannot disagree with the rows around it.
  // add/remove rather than toggle: resetValueClasses has already cleared the
  // class, and this renderer's callers supply a minimal classList.
  function applyInert(cell, operative) {
    if (!cell) return;
    if (operative === false) cell.classList.add(INERT);
    else cell.classList.remove(INERT);
  }

  function renderFxCell(rowElement, step, slotIndex) {
    const cell = rowElement.querySelector(`[data-pane="phrase"][data-col="${slotIndex + 3}"]`);
    if (!cell) return;
    const slot = step.fx?.[slotIndex] ?? { command: 0, value: 0 };
    const command = typeof fxCommandCode === "function" ? fxCommandCode(slot) : Number(slot?.command ?? slot ?? 0);
    const value = typeof fxValueByte === "function" ? fxValueByte(slot) : Number(slot?.value ?? 0);
    const name = typeof fxName === "function" ? fxName(slot) : command === 0 ? "---" : `?${hex(command)}`;
    resetValueClasses(cell);
    cell.classList.add(command === 0 ? "empty" : "fx");
    setText(cell, name);
    cell.title = command === 0
      ? "Empty effect slot"
      : `Effect ${name} · value ${hex(value)} · stored but musically inert until M4.1C`;
  }

  function render(phraseId, row) {
    if (typeof state === "undefined" || typeof model === "undefined") return false;
    if (Number(state.phrase) !== Number(phraseId)) return false;
    const step = model.phrases?.[phraseId]?.[row];
    const rowElement = document.querySelector(`[data-row-pane="phrase"][data-row="${row}"]`);
    if (!step || !rowElement) return false;

    const noteCell = rowElement.querySelector('[data-pane="phrase"][data-col="0"]');
    const velocityCell = rowElement.querySelector('[data-pane="phrase"][data-col="1"]');
    const instrumentCell = rowElement.querySelector('[data-pane="phrase"][data-col="2"]');

    const api = rowPresentation();
    const presentation = api?.phraseRowPresentation(step);

    resetValueClasses(noteCell);
    noteCell?.classList.add(step.note < 0 ? "empty" : "value");
    setText(noteCell, noteName(step.note));
    renderConditionBadge(noteCell, step, row);

    resetValueClasses(velocityCell);
    applyInert(velocityCell, presentation?.velocityOperative);
    setText(velocityCell, String(step.velocity));
    if (velocityCell) velocityCell.title = api?.velocityTitle(presentation) ?? "Velocity";

    const instrumentPresentation = typeof instrumentReferencePresentation === "function"
      ? instrumentReferencePresentation(step.instrument, model.instrumentPool)
      : step.instrument < 0
        ? { state: "empty", text: "--", title: "Instrument unassigned" }
        : { state: "resolved", text: hex(step.instrument), title: `Instrument ${hex(step.instrument)}` };
    resetValueClasses(instrumentCell);
    if (instrumentPresentation.state === "empty") instrumentCell?.classList.add("empty");
    else instrumentCell?.classList.add("instrument", instrumentPresentation.state);
    applyInert(instrumentCell, presentation?.instrumentOperative);
    setText(instrumentCell, instrumentPresentation.text);
    if (instrumentCell) {
      instrumentCell.title = api?.instrumentTitle(presentation, instrumentPresentation.title) ?? instrumentPresentation.title;
    }

    for (let slotIndex = 0; slotIndex < 3; slotIndex += 1) renderFxCell(rowElement, step, slotIndex);

    globalThis.BRKTRKCommandBindings?.refreshNoteDock?.();
    globalThis.BRKTRKNoteEntry?.refresh?.();
    if (typeof renderPlayheads === "function") renderPlayheads();
    return true;
  }

  const api = Object.freeze({ render });
  globalThis.BRKTRKPhraseStepRenderer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
