(() => {
  const base = globalThis.BRKTRKFieldSchema;
  const surface = globalThis.BRKTRKPhraseFxSurface;
  const baseRenderer = globalThis.BRKTRKPhraseStepRenderer;
  if (!base || !surface) throw new Error("Phrase FX semantic surface requires Field Schema and Phrase FX surface mapping");

  const clampValue = (value, min, max) => Math.min(max, Math.max(min, value));
  const hexByte = (value) => clampValue(Math.round(Number(value) || 0), 0, 255).toString(16).toUpperCase().padStart(2, "0");

  function phraseStepDomain(env) {
    const store = env.projectStore ?? globalThis.BRKTRKStores?.project;
    const domain = store?.phraseSteps;
    if (!domain) throw new Error("ProjectStore Phrase-step domain is required for Phrase FX fields");
    return domain;
  }

  function makeDescriptor(slotIndex, component) {
    const slotNumber = slotIndex + 1;
    const command = component === "command";
    return Object.freeze({
      id: command ? `phrase.fx${slotNumber}` : `phrase.fx${slotNumber}.value`,
      label: command ? `FX${slotNumber} COMMAND` : `FX${slotNumber} VALUE`,
      contextLabel: "PHRASE FX SLOT",
      pane: "phrase",
      columns: [command ? surface.commandColumn(slotIndex) : surface.valueColumn(slotIndex)],
      type: command ? "fx-command" : "fx-value",
      editorKind: "fx",
      slotIndex,
      component,
      radix: 16,
      min: 0,
      max: 255,
      fineStep: 1,
      coarseStep: 16,
      defaultValue: 0,
      changeKind: "parameter",
      affectsPlayback: true,
      persistsProject: true,
      read: (env, cursor = env.state.focus) => phraseStepDomain(env).readFxSlot(env.state.phrase, cursor.row, slotIndex)[component],
      write: (env, cursor = env.state.focus, value, options = {}) => phraseStepDomain(env).setFxComponent(
        env.state.phrase,
        cursor.row,
        slotIndex,
        component,
        value,
        options,
      ),
      readSlot: (env, cursor = env.state.focus) => phraseStepDomain(env).readFxSlot(env.state.phrase, cursor.row, slotIndex),
      writeSlot: (env, cursor = env.state.focus, slot, options = {}) => phraseStepDomain(env).setFxSlot(
        env.state.phrase,
        cursor.row,
        slotIndex,
        slot,
        options,
      ),
    });
  }

  const fxDescriptors = Object.freeze(Array.from({ length: surface.FX_SLOTS }, (_, slotIndex) => [
    makeDescriptor(slotIndex, "command"),
    makeDescriptor(slotIndex, "value"),
  ]).flat());
  const retainedDescriptors = base.descriptors.filter((descriptor) => !/^phrase\.fx[123]$/.test(descriptor.id));
  const descriptors = Object.freeze([...retainedDescriptors, ...fxDescriptors]);

  function resolve(pane, col) {
    if (pane === "phrase" && Number(col) >= surface.FIRST_FX_COL) {
      return fxDescriptors.find((descriptor) => descriptor.columns.includes(Number(col))) ?? null;
    }
    return base.resolve(pane, col);
  }

  function format(env, descriptor, value) {
    if (descriptor.type === "fx-value") return hexByte(value);
    return base.format(env, descriptor, value);
  }

  const api = Object.freeze({
    ...base,
    descriptors,
    resolve,
    format,
  });
  globalThis.BRKTRKFieldSchema = api;

  function resetValueClasses(cell) {
    if (!cell) return;
    cell.classList.remove("empty", "value", "instrument", "fx", "fx-value");
  }

  function setText(cell, value) {
    if (!cell) return;
    const marker = cell.querySelector(".p35-effective-note");
    cell.textContent = value;
    if (marker) cell.append(marker);
  }

  function renderFxPair(rowElement, step, slotIndex) {
    const slot = step.fx?.[slotIndex] ?? { command: 0, value: 0 };
    const command = typeof fxCommandCode === "function" ? fxCommandCode(slot) : Number(slot.command ?? 0);
    const value = typeof fxValueByte === "function" ? fxValueByte(slot) : Number(slot.value ?? 0);
    const name = typeof fxName === "function" ? fxName(slot) : command === 0 ? "---" : `?${hexByte(command)}`;
    const hint = surface.runtimeHint?.(command, value) ?? "runtime status unavailable";
    const commandCell = rowElement.querySelector(`[data-pane="phrase"][data-col="${surface.commandColumn(slotIndex)}"]`);
    const valueCell = rowElement.querySelector(`[data-pane="phrase"][data-col="${surface.valueColumn(slotIndex)}"]`);

    resetValueClasses(commandCell);
    commandCell?.classList.add(command === 0 ? "empty" : "fx");
    setText(commandCell, name);
    if (commandCell) commandCell.title = command === 0
      ? `FX${slotIndex + 1} command · empty`
      : `FX${slotIndex + 1} command ${name} · ${hint}`;

    resetValueClasses(valueCell);
    valueCell?.classList.add(command === 0 ? "empty" : "fx-value");
    setText(valueCell, hexByte(value));
    if (valueCell) valueCell.title = `FX${slotIndex + 1} value ${hexByte(value)} · ${hint}`;
  }

  if (baseRenderer?.render) {
    const renderer = Object.freeze({
      ...baseRenderer,
      render(phraseId, row) {
        const rendered = baseRenderer.render(phraseId, row);
        if (!rendered) return false;
        const step = model.phrases?.[phraseId]?.[row];
        const rowElement = document.querySelector(`[data-row-pane="phrase"][data-row="${row}"]`);
        if (!step || !rowElement) return false;
        for (let slotIndex = 0; slotIndex < surface.FX_SLOTS; slotIndex += 1) renderFxPair(rowElement, step, slotIndex);
        return true;
      },
    });
    globalThis.BRKTRKPhraseStepRenderer = renderer;
  }
})();
