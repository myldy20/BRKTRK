(() => {
  const surface = globalThis.BRKTRKPhraseFxSurface;
  const fxDomain = globalThis.BRKTRKPhraseFxDomain;
  const baseValueDock = globalThis.BRKTRKValueDock;
  const commands = globalThis.BRKTRKCommands;
  const projectStore = globalThis.BRKTRKStores?.project;
  const phraseSteps = projectStore?.phraseSteps;

  if (!surface || !fxDomain || !baseValueDock || !commands?.installed || !phraseSteps) {
    throw new Error("Grouped phone FX editor requires Phrase FX surface/domain, Value Dock and ProjectStore");
  }

  const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
  const PHONE_PHRASE_COLUMNS = Object.freeze([0, 1, 2, 3, 5, 7]);
  const hexByte = (value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0)))
    .toString(16).toUpperCase().padStart(2, "0");

  const baseCommandDispatch = commands.dispatch.bind(commands);
  const baseCommandKeyDown = typeof commands.keyDown === "function" ? commands.keyDown.bind(commands) : null;
  const baseCommandKeyUp = typeof commands.keyUp === "function" ? commands.keyUp.bind(commands) : null;
  const phoneHeldKeys = new Set();

  function clampPhraseColumn(value) {
    return Math.max(0, Math.min(surface.PHRASE_COLS - 1, Math.round(Number(value) || 0)));
  }

  function normalizePhonePhraseColumn(value, direction = null) {
    const numeric = clampPhraseColumn(value);
    if (PHONE_PHRASE_COLUMNS.includes(numeric)) return numeric;
    if (direction === "ArrowRight") {
      return PHONE_PHRASE_COLUMNS.find((column) => column > numeric) ?? PHONE_PHRASE_COLUMNS.at(-1);
    }
    return [...PHONE_PHRASE_COLUMNS].reverse().find((column) => column < numeric) ?? PHONE_PHRASE_COLUMNS[0];
  }

  function visibleCursorCommand(command = {}) {
    if (!isPhone()) return command;
    if (command.type === "cursor.select" && command.pane === "phrase") {
      return { ...command, col: normalizePhonePhraseColumn(command.col) };
    }
    if (command.type !== "cursor.move" || state.focus.pane !== "phrase") return command;

    const current = normalizePhonePhraseColumn(state.focus.col);
    if (command.direction === "ArrowLeft" || command.direction === "ArrowRight") {
      const index = Math.max(0, PHONE_PHRASE_COLUMNS.indexOf(current));
      const delta = command.direction === "ArrowRight" ? 1 : -1;
      const target = PHONE_PHRASE_COLUMNS[Math.max(0, Math.min(PHONE_PHRASE_COLUMNS.length - 1, index + delta))];
      return {
        type: "cursor.select",
        pane: "phrase",
        row: state.focus.row,
        col: target,
        focus: true,
        source: command.source ?? "phone-visible-phrase-cursor",
      };
    }
    if (command.direction === "ArrowUp" || command.direction === "ArrowDown") {
      return {
        type: "cursor.select",
        pane: "phrase",
        row: state.focus.row + (command.direction === "ArrowDown" ? 1 : -1),
        col: current,
        focus: true,
        source: command.source ?? "phone-visible-phrase-cursor",
      };
    }
    return command;
  }

  commands.dispatch = function phoneVisiblePhraseDispatch(command = {}) {
    return baseCommandDispatch(visibleCursorCommand(command));
  };

  globalThis.setFocus = function phoneVisibleSetFocus(pane, row, col, shouldFocus = true) {
    return commands.dispatch({
      type: "cursor.select",
      pane,
      row,
      col,
      focus: shouldFocus,
      source: "compatibility-setFocus",
    });
  };

  function phoneVisibleKeyDown(code, repeat = false) {
    if (!repeat) phoneHeldKeys.add(code);
    const modified = phoneHeldKeys.has("KeyA") || phoneHeldKeys.has("KeyS") || phoneHeldKeys.has("KeyZ");
    if (isPhone() && state.focus.pane === "phrase" && code.startsWith("Arrow") && !modified) {
      return commands.dispatch({ type: "cursor.move", direction: code, source: "phone-visible-phrase-key" });
    }
    return baseCommandKeyDown?.(code, repeat);
  }

  function phoneVisibleKeyUp(code) {
    phoneHeldKeys.delete(code);
    return baseCommandKeyUp?.(code);
  }

  if (baseCommandKeyDown && baseCommandKeyUp) {
    commands.keyDown = phoneVisibleKeyDown;
    commands.keyUp = phoneVisibleKeyUp;
    globalThis.keyDown = phoneVisibleKeyDown;
    globalThis.keyUp = phoneVisibleKeyUp;
  }

  function normalizeFocusedPhoneCursor(source = "phone-visible-phrase-normalize") {
    if (!isPhone() || state.focus.pane !== "phrase") return false;
    const col = normalizePhonePhraseColumn(state.focus.col);
    if (col === state.focus.col) return false;
    commands.dispatch({
      type: "cursor.select",
      pane: "phrase",
      row: state.focus.row,
      col,
      focus: true,
      source,
    });
    return true;
  }

  let active = null;
  let decorateQueued = false;

  function commandLabel(command) {
    if (command === 0) return "---";
    return fxDomain.commandDescriptor(command)?.label ?? `?${hexByte(command)}`;
  }

  function groupedLabel(slot) {
    const command = Number(slot?.command ?? 0);
    if (command === 0) return "---";
    return `${commandLabel(command)} ${hexByte(slot?.value ?? 0)}`;
  }

  function runtimeHint(slot) {
    return surface.runtimeHint?.(Number(slot?.command ?? 0), Number(slot?.value ?? 0)) ?? "runtime status unavailable";
  }

  function decoratePhrase() {
    decorateQueued = false;
    if (!isPhone()) return;
    const header = document.querySelector("#phraseGrid .grid-header");
    if (header) {
      ["FX1", "FX2", "FX3"].forEach((label, slotIndex) => {
        const commandHeader = header.children[surface.commandColumn(slotIndex) + 1];
        if (commandHeader && commandHeader.textContent !== label) commandHeader.textContent = label;
      });
    }

    document.querySelectorAll('#phraseGrid [data-row-pane="phrase"]').forEach((rowElement) => {
      const row = Number(rowElement.dataset.row);
      const step = model.phrases?.[state.phrase]?.[row];
      if (!step) return;
      for (let slotIndex = 0; slotIndex < surface.FX_SLOTS; slotIndex += 1) {
        const slot = phraseSteps.readFxSlot(state.phrase, row, slotIndex);
        const commandCell = rowElement.querySelector(`[data-pane="phrase"][data-col="${surface.commandColumn(slotIndex)}"]`);
        if (!commandCell) continue;
        const label = groupedLabel(slot);
        if (commandCell.textContent !== label) commandCell.textContent = label;
        commandCell.dataset.phoneFxSlot = String(slotIndex);
        commandCell.title = Number(slot.command) === 0
          ? `FX${slotIndex + 1} · empty`
          : `FX${slotIndex + 1} · ${label} · ${runtimeHint(slot)}`;
      }
    });
  }

  function queueDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(decoratePhrase);
  }

  function focusSlot() {
    if (!isPhone() || state.focus.pane !== "phrase") return null;
    const described = surface.describePhraseColumn(state.focus.col);
    if (!described) return null;
    return { slotIndex: described.slotIndex, component: described.component };
  }

  function readSlot(phraseId, row, slotIndex) {
    const slot = phraseSteps.readFxSlot(phraseId, row, slotIndex);
    return { command: Number(slot.command), value: Number(slot.value) };
  }

  function close() {
    const dock = document.querySelector("#m41bPhoneFxDock");
    if (dock) dock.setAttribute("aria-hidden", "true");
    document.body.classList.remove("m41b-phone-fx-open");
    active = null;
  }

  function setDraftCommand(code) {
    if (!active) return;
    active.command = Number(code);
    if (active.command === 0) active.value = 0;
    refreshDock();
  }

  function setDraftValue(value) {
    if (!active || active.command === 0) return;
    active.value = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
    refreshDock();
  }

  function adjustValue(delta) {
    if (!active || active.command === 0) return;
    setDraftValue(active.value + delta);
  }

  function refreshDock() {
    const dock = document.querySelector("#m41bPhoneFxDock");
    if (!dock || !active) return;
    const title = dock.querySelector("#m41bPhoneFxTitle");
    const context = dock.querySelector("#m41bPhoneFxContext");
    const valueInput = dock.querySelector("#m41bPhoneFxValue");
    const applyButton = dock.querySelector("#m41bPhoneFxApply");
    const known = fxDomain.commandDescriptor(active.command);

    title.textContent = `FX${active.slotIndex + 1}`;
    context.textContent = `PHRASE ${hexByte(active.phraseId)} · ROW ${hexByte(active.row)} · COMMAND + VALUE`;
    valueInput.value = active.command === 0 ? "--" : hexByte(active.value);
    valueInput.disabled = active.command === 0;
    applyButton.textContent = active.command === 0
      ? `APPLY EMPTY FX${active.slotIndex + 1}`
      : `APPLY ${commandLabel(active.command)} ${hexByte(active.value)}`;

    dock.querySelectorAll("[data-fx-command]").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.fxCommand) === active.command);
    });

    const unknown = dock.querySelector("#m41bPhoneFxUnknown");
    if (!known && active.command !== 0) {
      unknown.hidden = false;
      unknown.textContent = `PRESERVED UNKNOWN · ${hexByte(active.command)}`;
    } else {
      unknown.hidden = true;
      unknown.textContent = "";
    }

    dock.querySelectorAll("[data-fx-value-step]").forEach((button) => {
      button.disabled = active.command === 0;
    });
  }

  function open(slotIndex = focusSlot()?.slotIndex) {
    if (!isPhone() || slotIndex == null || state.focus.pane !== "phrase") return false;
    baseValueDock.close?.({ restore: false, source: "grouped-fx-editor-open" });
    const slot = readSlot(state.phrase, state.focus.row, slotIndex);
    active = {
      phraseId: Number(state.phrase),
      row: Number(state.focus.row),
      slotIndex: Number(slotIndex),
      command: slot.command,
      value: slot.value,
    };
    const dock = document.querySelector("#m41bPhoneFxDock");
    dock?.setAttribute("aria-hidden", "false");
    document.body.classList.add("m41b-phone-fx-open");
    refreshDock();
    setStatus(`FX${slotIndex + 1} SLOT · EDIT`);
    return true;
  }

  function apply() {
    if (!active) return null;
    const snapshot = { ...active };
    const result = phraseSteps.setFxSlot(snapshot.phraseId, snapshot.row, snapshot.slotIndex, {
      command: snapshot.command,
      value: snapshot.command === 0 ? 0 : snapshot.value,
    }, {
      source: "phone-grouped-fx-slot-editor",
    });
    globalThis.BRKTRKPhraseStepRenderer?.render?.(snapshot.phraseId, snapshot.row);
    close();
    queueDecorate();
    setStatus(`FX${snapshot.slotIndex + 1} · ${snapshot.command === 0 ? "EMPTY" : `${commandLabel(snapshot.command)} ${hexByte(snapshot.value)}`}`);
    return result;
  }

  function inject() {
    if (document.querySelector("#m41bPhoneFxDock")) return;
    const dock = document.createElement("section");
    dock.id = "m41bPhoneFxDock";
    dock.className = "m41b-phone-fx-dock";
    dock.setAttribute("aria-hidden", "true");

    const commandButtons = fxDomain.registry().map((entry) => (
      `<button type="button" data-fx-command="${entry.code}">${entry.label === "---" ? "NONE" : entry.label}</button>`
    )).join("");

    dock.innerHTML = `
      <header class="m41b-phone-fx-header">
        <div><span id="m41bPhoneFxTitle">FX SLOT</span><strong id="m41bPhoneFxContext"></strong></div>
        <button id="m41bPhoneFxClose" type="button" aria-label="Close FX slot editor">×</button>
      </header>
      <div class="m41b-phone-fx-command-choices" aria-label="FX command">${commandButtons}</div>
      <div id="m41bPhoneFxUnknown" class="m41b-phone-fx-unknown" hidden></div>
      <div class="m41b-phone-fx-value-row">
        <button type="button" data-fx-value-step="-16">−16</button>
        <button type="button" data-fx-value-step="-1">−1</button>
        <input id="m41bPhoneFxValue" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="FX value">
        <button type="button" data-fx-value-step="1">+1</button>
        <button type="button" data-fx-value-step="16">+16</button>
      </div>
      <footer class="m41b-phone-fx-actions">
        <button id="m41bPhoneFxEmpty" type="button">EMPTY SLOT</button>
        <button id="m41bPhoneFxApply" class="primary" type="button">APPLY</button>
      </footer>`;
    document.querySelector("#appShell")?.append(dock);

    dock.querySelector("#m41bPhoneFxClose").addEventListener("click", close);
    dock.querySelector("#m41bPhoneFxEmpty").addEventListener("click", () => setDraftCommand(0));
    dock.querySelector("#m41bPhoneFxApply").addEventListener("click", apply);
    dock.querySelectorAll("[data-fx-command]").forEach((button) => {
      button.addEventListener("click", () => setDraftCommand(Number(button.dataset.fxCommand)));
    });
    dock.querySelectorAll("[data-fx-value-step]").forEach((button) => {
      button.addEventListener("click", () => adjustValue(Number(button.dataset.fxValueStep)));
    });
    dock.querySelector("#m41bPhoneFxValue").addEventListener("change", (event) => {
      const raw = String(event.target.value ?? "").trim();
      if (!/^[0-9a-f]{1,2}$/i.test(raw)) {
        refreshDock();
        setStatus("FX VALUE MUST BE 00–FF", "danger");
        return;
      }
      setDraftValue(Number.parseInt(raw, 16));
    });
  }

  inject();

  const wrappedValueDock = Object.freeze({
    ...baseValueDock,
    open(options = {}) {
      const focused = focusSlot();
      if (focused) return open(focused.slotIndex);
      return baseValueDock.open(options);
    },
    close(options = {}) {
      if (active) close();
      return baseValueDock.close(options);
    },
  });
  globalThis.BRKTRKValueDock = wrappedValueDock;

  const editButton = document.querySelector("#p32EditValueButton");
  editButton?.addEventListener("click", (event) => {
    const focused = focusSlot();
    if (!focused) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open(focused.slotIndex);
  }, true);

  // Value Dock owns a document-capture click handler that is installed before this module.
  // Intercept ready-state phone FX cells at the earlier Window capture phase so a real second
  // tap cannot fall through to the generic raw byte editor. While bootstrap input is blocked,
  // deliberately return so the existing document-capture bootstrap gate remains authoritative.
  window.addEventListener("click", (event) => {
    if (!isPhone()) return;
    const bootstrapInput = globalThis.BRKTRKBootstrapInput;
    if (bootstrapInput?.isBlocked?.() || (bootstrapInput?.commandArchitectureReady && !bootstrapInput.commandArchitectureReady())) return;
    const cell = event.target.closest('[data-pane="phrase"][data-col]');
    if (!cell) return;
    const described = surface.describePhraseColumn(Number(cell.dataset.col));
    if (described?.component !== "command" || !cell.classList.contains("selected")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open(described.slotIndex);
  }, true);

  document.querySelector("#phraseGrid")?.addEventListener("scroll", queueDecorate, { passive: true });
  const observer = new MutationObserver(queueDecorate);
  const phraseGrid = document.querySelector("#phraseGrid");
  if (phraseGrid) observer.observe(phraseGrid, { childList: true, subtree: true, characterData: true });
  commands.subscribe((record) => {
    const target = String(record?.changeSet?.target ?? "");
    if (isPhone() && target.startsWith("phrase.fx.")) {
      decoratePhrase();
      return;
    }
    queueDecorate();
  });
  window.addEventListener("resize", () => {
    if (!isPhone()) close();
    else normalizeFocusedPhoneCursor("phone-visible-phrase-resize");
    queueDecorate();
  });

  normalizeFocusedPhoneCursor("phone-visible-phrase-install");
  queueDecorate();

  globalThis.BRKTRKPhoneFxEditor = Object.freeze({
    open,
    close,
    apply,
    decoratePhrase,
    groupedLabel,
    visiblePhraseColumns: PHONE_PHRASE_COLUMNS,
    normalizePhraseColumn: normalizePhonePhraseColumn,
    normalizeFocusedPhoneCursor,
  });
})();