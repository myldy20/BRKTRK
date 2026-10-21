(() => {
  const commands = globalThis.BRKTRKCommands;
  const fields = globalThis.BRKTRKFieldSchema;
  const entryState = commands?.stores?.navigation?.entryState;
  if (!commands?.installed || !fields || !entryState) throw new Error("P3.3 field editor requires dispatcher, field schema and NavigationStore entry state");

  const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
  const schemaEnv = { state, model, chain, phrase, firstUnused, noteName, fxName, hex, clamp, EMPTY, NOTE_OFF };
  let activeDescriptor = null;
  let activeSpecialKey = null;
  let draftValue = null;
  let draftOnly = false;
  let repeatDelay = 0;
  let repeatTimer = 0;
  let mixDrag = null;

  function stopRepeat() {
    window.clearTimeout(repeatDelay);
    window.clearInterval(repeatTimer);
    repeatDelay = 0;
    repeatTimer = 0;
  }

  function repeatAction(button, action) {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.setPointerCapture?.(event.pointerId);
      stopRepeat();
      action();
      repeatDelay = window.setTimeout(() => {
        repeatTimer = window.setInterval(action, 75);
      }, 340);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, stopRepeat);
  }

  function isSpecial() {
    return Boolean(activeSpecialKey);
  }

  function descriptorAtFocus() {
    return fields.resolve(state.focus.pane, state.focus.col);
  }

  function cursorAtFocus() {
    return { pane: state.focus.pane, row: state.focus.row, col: state.focus.col };
  }

  function sameCursor(left, right) {
    return Boolean(left && right
      && left.pane === right.pane
      && left.row === right.row
      && left.col === right.col);
  }

  function currentValue() {
    return activeDescriptor ? fields.read(schemaEnv, activeDescriptor) : null;
  }

  function specialGroupEntries() {
    const group = activeDescriptor?.specialGroup;
    if (!group) return [];
    return Object.entries(fields.specialDescriptors)
      .filter(([, descriptor]) => descriptor?.specialGroup === group)
      .sort((left, right) => Number(left[1].specialOrder ?? 0) - Number(right[1].specialOrder ?? 0));
  }

  function refreshSpecialTabs() {
    const nav = $("#p32SpecialTabs");
    if (!nav) return;
    const entries = isSpecial() ? specialGroupEntries() : [];
    nav.hidden = entries.length < 2;
    nav.replaceChildren();
    for (const [key, descriptor] of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.specialKey = key;
      button.textContent = descriptor.specialTabLabel ?? descriptor.label ?? key;
      button.setAttribute("aria-pressed", String(key === activeSpecialKey));
      button.addEventListener("click", () => switchSpecial(key));
      nav.append(button);
    }
  }

  function inputText(value) {
    if (!activeDescriptor) return "";
    if (Number(value) < 0 && Object.hasOwn(activeDescriptor, "emptyValue")) return "--";
    if (activeDescriptor.radix === 16) return Math.max(0, Number(value) || 0).toString(16).toUpperCase().padStart(2, "0");
    return String(value);
  }

  function fieldLabel(descriptor) {
    if (descriptor.label) return descriptor.label;
    const labels = {
      "song.chainRef": "CHAIN REFERENCE",
      "chain.phraseRef": "PHRASE REFERENCE",
      "chain.transpose": "TRANSPOSE",
      "phrase.velocity": "VELOCITY",
      "phrase.instrument": "INSTRUMENT",
      "phrase.fx1": "FX1 COMMAND",
      "phrase.fx2": "FX2 COMMAND",
      "phrase.fx3": "FX3 COMMAND",
    };
    return labels[descriptor.id] ?? descriptor.id.toUpperCase();
  }

  function contextLabel() {
    if (!activeDescriptor) return "";
    if (activeDescriptor.contextLabel) return activeDescriptor.contextLabel;
    if (activeDescriptor.pane === "song") return `SONG ${hex(state.focus.row)} · T${state.focus.col + 1}`;
    if (activeDescriptor.pane === "chain") return `CHAIN ${hex(state.chain)} · ROW ${hex(state.focus.row)}`;
    return `PHRASE ${hex(state.phrase)} · ROW ${hex(state.focus.row)}`;
  }

  function refreshRelatedUi() {
    globalThis.BRKTRKNoteEntry?.refresh?.();
    globalThis.BRKTRKCommandBindings?.refreshNoteDock?.();
  }

  function refresh() {
    const dock = $("#p32ValueDock");
    if (!dock || !activeDescriptor) return;
    const cursorBound = !isSpecial() || activeDescriptor?.cursorBound === true;
    if (cursorBound && !sameCursor(entryState.getValueReturn().originCursor, cursorAtFocus())) {
      close({ restore: false });
      return;
    }
    const value = isSpecial() || draftOnly || activeDescriptor.type === "reference" ? draftValue : currentValue();
    const dockMode = $("#p32ValueDock");
    if (dockMode) {
      dockMode.dataset.specialGroup = activeDescriptor.specialGroup ?? "";
      dockMode.dataset.desktopSpecial = String(!isPhone() && activeDescriptor.desktopSpecial === true);
    }
    refreshSpecialTabs();
    $("#p32ValueTitle").textContent = fieldLabel(activeDescriptor);
    $("#p32ValueContext").textContent = contextLabel();
    const input = $("#p32ValueInput");
    if (document.activeElement !== input) input.value = inputText(value);
    input.inputMode = activeDescriptor.radix === 16 ? "text" : "decimal";
    input.placeholder = Object.hasOwn(activeDescriptor, "emptyValue")
      ? `${activeDescriptor.radix === 16 ? "00–FF" : `${activeDescriptor.min}–${activeDescriptor.max}`} / --`
      : activeDescriptor.radix === 16 ? "00–FF" : `${activeDescriptor.min}–${activeDescriptor.max}`;
    input.setAttribute("aria-label", `${fieldLabel(activeDescriptor)} exact value`);
    $("#p32FineDown").textContent = `−${activeDescriptor.fineStep}`;
    $("#p32FineUp").textContent = `+${activeDescriptor.fineStep}`;
    $("#p32CoarseDown").textContent = `−${activeDescriptor.coarseStep}`;
    $("#p32CoarseUp").textContent = `+${activeDescriptor.coarseStep}`;
    $("#p32ValueReset").textContent = activeDescriptor.resetLabel ?? "CLEAR / RESET";
    const apply = $("#p32ValueApply");
    const parsed = fields.parse(activeDescriptor, input.value) ?? draftValue;
    if (isSpecial()) {
      apply.textContent = `${activeDescriptor.actionLabel ?? "SET"} ${inputText(parsed)}`;
    } else if (activeDescriptor.type === "reference") {
      const exists = fields.referenceExists(schemaEnv, activeDescriptor, parsed);
      apply.textContent = `${exists || activeDescriptor.referenceKind === "instrument" ? "LINK" : "CREATE & LINK"} ${inputText(parsed)}`;
    } else {
      apply.textContent = `APPLY ${inputText(value)}`;
    }
  }

  function prepareOpen(descriptor, valueReturn, source, options = {}) {
    activeDescriptor = descriptor;
    draftOnly = Boolean(options.draftOnly);
    const hasInitial = Object.hasOwn(options, "initialValue") && Number.isFinite(Number(options.initialValue));
    draftValue = hasInitial ? Number(options.initialValue) : fields.read(schemaEnv, descriptor);
    entryState.openValueSheet(valueReturn, { source });
    refresh();
    setStatus(`${fieldLabel(descriptor)} · EDIT`);
  }

  function open(options = {}) {
    if (!isPhone()) return false;
    const descriptor = descriptorAtFocus();
    if (!descriptor || descriptor.editorKind === "note") return false;
    const originCursor = cursorAtFocus();
    BRKTRKCommandBindings?.closeTouchController?.();
    activeSpecialKey = null;
    prepareOpen(descriptor, {
      originCursor,
      returnSheet: options.returnSheet ?? null,
      returnCursor: options.returnCursor ?? null,
    }, options.source ?? "value-dock-open", options);
    if (draftValue < 0 && descriptor.type === "reference" && !Object.hasOwn(options, "initialValue")) {
      draftValue = Number(descriptor.insertSeed?.(schemaEnv) ?? descriptor.defaultValue ?? 0);
      refresh();
    }
    return true;
  }

  function openSpecial(key, options = {}) {
    const descriptor = fields.specialDescriptors[key];
    if (!descriptor) return false;
    if (!isPhone() && descriptor.desktopSpecial !== true && options.desktop !== true) return false;
    const previousSheet = entryState.getActiveSheet();
    BRKTRKCommandBindings?.closeTouchController?.();
    activeSpecialKey = key;
    prepareOpen(descriptor, {
      originCursor: descriptor.cursorBound === true ? cursorAtFocus() : null,
      returnSheet: options.returnSheet ?? (previousSheet === "note" ? "note" : null),
      returnCursor: options.returnCursor ?? null,
    }, options.source ?? "value-dock-special-open", { ...options, draftOnly: false });
    return true;
  }

  function switchSpecial(key) {
    const descriptor = fields.specialDescriptors[key];
    if (!descriptor || !activeDescriptor?.specialGroup || descriptor.specialGroup !== activeDescriptor.specialGroup) return false;
    activeSpecialKey = key;
    activeDescriptor = descriptor;
    draftValue = fields.read(schemaEnv, descriptor);
    draftOnly = false;
    refresh();
    return true;
  }

  async function reopenReturnTarget(target) {
    if (target?.returnCursor) {
      await commands.dispatch({
        type: "cursor.select",
        pane: target.returnCursor.pane,
        row: target.returnCursor.row,
        col: target.returnCursor.col,
        focus: false,
        transient: true,
        source: "value-dock-note-return",
      });
    }
    if (target?.returnSheet === "note" && state.focus.pane === "phrase" && state.focus.col === 0) {
      BRKTRKCommandBindings?.openNoteDock?.();
    }
  }

  function close(options = {}) {
    const shouldRestore = options.restore !== false;
    const result = entryState.closeValueSheet({ source: options.source ?? "value-dock-close" });
    const target = result.returnTarget;
    activeDescriptor = null;
    activeSpecialKey = null;
    draftValue = null;
    draftOnly = false;
    const dockMode = $("#p32ValueDock");
    if (dockMode) {
      dockMode.dataset.specialGroup = "";
      dockMode.dataset.desktopSpecial = "false";
    }
    $("#p32SpecialTabs")?.replaceChildren?.();
    stopRepeat();
    if (shouldRestore && target?.returnSheet) return reopenReturnTarget(target);
    return Promise.resolve(result);
  }

  function releaseInput() {
    stopRepeat();
  }

  function renderNavigationState(activeSheet = entryState.getActiveSheet()) {
    if (activeSheet === "value") {
      refresh();
      return;
    }
    activeDescriptor = null;
    activeSpecialKey = null;
    draftValue = null;
    draftOnly = false;
    releaseInput();
  }

  function writeSpecial(value) {
    const mutation = fields.write(schemaEnv, activeDescriptor, value);
    draftValue = mutation.after;
    refreshRelatedUi();
    setStatus(`${fieldLabel(activeDescriptor)} · ${fields.format(schemaEnv, activeDescriptor, mutation.after)}`);
    return mutation;
  }

  function adjustDraft(direction) {
    if (!activeDescriptor) return;
    const edit = fields.intent(direction);
    if (!edit) return;
    const step = edit.magnitude === "coarse" ? activeDescriptor.coarseStep : activeDescriptor.fineStep;
    if (isSpecial()) {
      let base = Number.isFinite(Number(draftValue)) ? Number(draftValue) : currentValue();
      if (activeDescriptor.type === "reference" && base < 0) base = Number(activeDescriptor.insertSeed?.(schemaEnv) ?? activeDescriptor.defaultValue ?? 0);
      writeSpecial(clamp(base + edit.delta * step, activeDescriptor.min, activeDescriptor.max));
      refresh();
      return;
    }
    if (draftOnly) {
      const base = Number.isFinite(Number(draftValue)) ? Number(draftValue) : Number(currentValue());
      const min = Object.hasOwn(activeDescriptor, "emptyValue") ? activeDescriptor.emptyValue : activeDescriptor.min;
      draftValue = clamp(base + edit.delta * step, min, activeDescriptor.max);
      refresh();
      return;
    }
    if (activeDescriptor.type !== "reference") {
      commands.dispatch({ type: "field.adjust", direction, source: "value-dock" }).then(refresh);
      return;
    }
    let base = Number(draftValue);
    if (base < 0) base = Number(activeDescriptor.insertSeed?.(schemaEnv) ?? activeDescriptor.defaultValue ?? 0);
    draftValue = clamp(base + edit.delta * step, activeDescriptor.min, activeDescriptor.max);
    refresh();
  }

  async function applyExact() {
    if (!activeDescriptor) return;
    const input = $("#p32ValueInput");
    const value = fields.parse(activeDescriptor, input.value);
    if (!Number.isFinite(value)) {
      setStatus("INVALID VALUE", "danger");
      input.focus();
      return;
    }
    draftValue = value;
    if (isSpecial()) {
      writeSpecial(value);
      if (activeDescriptor.specialGroup) {
        refresh();
        return;
      }
      await close();
      return;
    }
    const result = await commands.dispatch({
      type: "field.setExact",
      value,
      createMissing: activeDescriptor.type === "reference",
      source: "value-dock-exact",
    });
    if (result?.ok !== false) {
      if (entryState.getValueReturn().returnSheet === "note") await close();
      else refresh();
    }
  }

  async function resetValue() {
    if (!activeDescriptor) return;
    if (isSpecial()) {
      const mutation = fields.reset(schemaEnv, activeDescriptor);
      draftValue = mutation.after;
      refreshRelatedUi();
      refresh();
      return;
    }
    if (draftOnly) {
      draftValue = Object.hasOwn(activeDescriptor, "emptyValue") ? activeDescriptor.emptyValue : activeDescriptor.defaultValue;
      refresh();
      return;
    }
    await commands.dispatch({ type: "field.reset", source: "value-dock-reset" });
    if (activeDescriptor.type === "reference") {
      const value = fields.read(schemaEnv, activeDescriptor);
      draftValue = value < 0 ? Number(activeDescriptor.insertSeed?.(schemaEnv) ?? activeDescriptor.defaultValue ?? 0) : value;
    }
    refresh();
  }

  function channelIndex(slider) {
    const channel = slider.closest("#mixer .channel:not(.master)");
    return channel ? $$("#mixer .channel:not(.master)").indexOf(channel) : -1;
  }

  function updateMixerVisual(slider) {
    const channel = slider.closest(".channel");
    const meter = channel?.querySelector(".channel-meter i");
    if (meter) meter.style.width = `${Math.round(Number(slider.value) * 0.55)}%`;
    $$("#mixer .channel:not(.master)").forEach((item, index) => item.classList.toggle("active", index === state.track));
  }

  function beginMixDrag(event, slider) {
    event.stopImmediatePropagation();
    const index = channelIndex(slider);
    if (index < 0) return;
    mixDrag = { slider, index, pointerId: event.pointerId };
    commands.dispatch({ type: "mix.selectTrack", index, transient: true, source: "mixer-drag" });
    updateMixerVisual(slider);
  }

  function moveMixDrag(event, slider) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const index = channelIndex(slider);
    if (index < 0) return;
    if (state.track !== index) commands.dispatch({ type: "mix.selectTrack", index, transient: true, source: "mixer-drag" });
    commands.dispatch({ type: "mix.setVolume", value: Number(slider.value), displayUnits: true, transient: true, source: "mixer-drag" });
    updateMixerVisual(slider);
  }

  function endMixDrag(event, slider = mixDrag?.slider) {
    if (!slider || (!mixDrag && event?.type === "change")) return;
    event?.stopImmediatePropagation?.();
    const index = channelIndex(slider);
    if (index >= 0) {
      commands.dispatch({ type: "mix.selectTrack", index, transient: true, source: "mixer-drag-end" });
      commands.dispatch({ type: "mix.setVolume", value: Number(slider.value), displayUnits: true, source: "mixer-drag-end" });
    }
    mixDrag = null;
  }

  function inject() {
    if ($("#p32ValueDock")) return;
    const dock = document.createElement("section");
    dock.id = "p32ValueDock";
    dock.className = "p32-value-dock";
    dock.setAttribute("aria-hidden", "true");
    dock.innerHTML = `
      <header class="p32-value-header">
        <div><span id="p32ValueTitle">VALUE</span><strong id="p32ValueContext"></strong></div>
        <button id="p32ValueClose" type="button" aria-label="Close value editor">×</button>
      </header>
      <nav id="p32SpecialTabs" class="p32-special-tabs" aria-label="Value editor fields" hidden></nav>
      <div class="p32-value-controls">
        <button id="p32CoarseDown" type="button">−LARGE</button>
        <button id="p32FineDown" type="button">−1</button>
        <input id="p32ValueInput" autocomplete="off" autocapitalize="characters" spellcheck="false">
        <button id="p32FineUp" type="button">+1</button>
        <button id="p32CoarseUp" type="button">+LARGE</button>
      </div>
      <footer class="p32-value-actions">
        <button id="p32ValueReset" type="button">CLEAR / RESET</button>
        <button id="p32ValueApply" class="primary" type="button">APPLY</button>
      </footer>`;
    $("#appShell")?.append(dock);

    const editButton = document.createElement("button");
    editButton.id = "p32EditValueButton";
    editButton.className = "phone-edit-button p32-edit-value-button";
    editButton.type = "button";
    editButton.textContent = "EDIT VALUE";
    editButton.hidden = true;
    $(".command-bar")?.append(editButton);

    repeatAction($("#p32CoarseDown"), () => adjustDraft("ArrowDown"));
    repeatAction($("#p32FineDown"), () => adjustDraft("ArrowLeft"));
    repeatAction($("#p32FineUp"), () => adjustDraft("ArrowRight"));
    repeatAction($("#p32CoarseUp"), () => adjustDraft("ArrowUp"));
    $("#p32ValueClose").addEventListener("click", () => close());
    $("#p32ValueReset").addEventListener("click", resetValue);
    $("#p32ValueApply").addEventListener("click", applyExact);
    $("#p32ValueInput").addEventListener("input", refresh);
    $("#p32ValueInput").addEventListener("keydown", (event) => {
      if (event.code === "Enter") { event.preventDefault(); applyExact(); }
      if (event.code === "Escape") { event.preventDefault(); close(); }
    });
    editButton.addEventListener("click", () => open());
  }

  document.addEventListener("click", (event) => {
    const cell = event.target.closest("[data-pane][data-row][data-col]");
    if (!cell || !isPhone()) return;
    const descriptor = fields.resolve(cell.dataset.pane, Number(cell.dataset.col));
    if (!descriptor || descriptor.editorKind === "note") return;
    const same = state.focus.pane === cell.dataset.pane
      && state.focus.row === Number(cell.dataset.row)
      && state.focus.col === Number(cell.dataset.col);
    if (!same) {
      close({ restore: false });
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    open();
  }, true);

  document.addEventListener("pointerdown", (event) => {
    const slider = event.target.closest("#mixer .channel:not(.master) input[type=range]");
    if (slider) beginMixDrag(event, slider);
  }, true);
  document.addEventListener("input", (event) => {
    const slider = event.target.closest("#mixer .channel:not(.master) input[type=range]");
    if (slider) moveMixDrag(event, slider);
  }, true);
  document.addEventListener("change", (event) => {
    const slider = event.target.closest("#mixer .channel:not(.master) input[type=range]");
    if (slider) endMixDrag(event, slider);
  }, true);
  document.addEventListener("pointerup", (event) => {
    if (mixDrag && event.pointerId === mixDrag.pointerId) endMixDrag(event);
  }, true);
  document.addEventListener("pointercancel", (event) => {
    if (mixDrag && event.pointerId === mixDrag.pointerId) endMixDrag(event);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.code === "Escape" && entryState.getActiveSheet() === "value") close();
  }, true);

  commands.subscribe(() => {
    const descriptor = descriptorAtFocus();
    const button = $("#p32EditValueButton");
    if (button) button.hidden = !isPhone() || !descriptor || descriptor.editorKind === "note";
    if (activeDescriptor) refresh();
  });

  window.addEventListener("resize", () => { if (!isPhone()) close({ restore: false }); });

  inject();
  renderNavigationState();
  globalThis.BRKTRKValueDock = Object.freeze({
    open,
    openSpecial,
    switchSpecial,
    close,
    refresh,
    releaseInput,
    renderNavigationState,
  });
})();
