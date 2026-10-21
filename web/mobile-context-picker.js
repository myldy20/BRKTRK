(() => {
  const commands = globalThis.BRKTRKCommands;
  const entryState = commands?.stores?.navigation?.entryState;
  if (!commands?.installed || !entryState) throw new Error("P3.2 dispatcher and NavigationStore entry state must load before mobile context picker");

  const HEX_DIGITS = "0123456789ABCDEF".split("");
  let kind = "phrase";
  let buffer = "00";
  let replaceNext = true;

  const isPhone = () => window.matchMedia("(max-width: 760px)").matches;

  function forceMobileWorkspace(workspace) {
    if (!isPhone() || !["song", "chain", "phrase", "sound", "mix"].includes(workspace)) return false;
    const canonical = commands.stores.navigation.captureContext().activeWorkspace;
    if (canonical !== workspace) return false;
    const workspaceElement = $("#workspace");
    if (workspaceElement) workspaceElement.dataset.view = workspace;
    document.body.dataset.mobileWorkspace = workspace;
    $$("#mobileTabs [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === workspace));
    return true;
  }

  const currentId = () => kind === "chain" ? state.chain : state.phrase;
  const normalizeBuffer = (value) => String(value ?? "").toUpperCase().replace(/[^0-9A-F]/g, "").slice(-2).padStart(2, "0");
  const exists = (nextKind, id) => nextKind === "chain" ? Object.hasOwn(model.chains, id) : Object.hasOwn(model.phrases, id);

  function refresh() {
    const picker = $("#p3ContextPicker");
    if (!picker) return;
    const value = normalizeBuffer(buffer);
    $("#p3ContextPickerKind").textContent = `OPEN ${kind.toUpperCase()}`;
    $("#p3ContextPickerValue").textContent = value;
    $("#p3ContextPickerApply").textContent = `${exists(kind, Number.parseInt(value, 16)) ? "OPEN" : "NOT CREATED"} ${value}`;
    picker.dataset.kind = kind;
  }

  function close() {
    return entryState.closeSheet("context", { source: "context-picker-close" });
  }

  function open(nextKind) {
    if (!isPhone() || !["chain", "phrase"].includes(nextKind)) return false;
    kind = nextKind;
    buffer = hex(currentId());
    replaceNext = true;
    entryState.openSheet("context", { source: "context-picker-open" });
    refresh();
    setStatus(`${kind.toUpperCase()} CONTEXT · ENTER EXISTING HEX ID`);
    return true;
  }

  function typeDigit(digit) {
    if (!HEX_DIGITS.includes(digit)) return;
    if (replaceNext) { buffer = digit; replaceNext = false; }
    else buffer = `${buffer}${digit}`.slice(-2);
    refresh();
  }

  function backspace() { buffer = buffer.length > 1 ? buffer.slice(0, -1) : "0"; replaceNext = false; refresh(); }
  function clear() { buffer = "00"; replaceNext = true; refresh(); }

  async function selectContextId(nextKind, value) {
    const id = clamp(Number(value), 0, 255);
    if (!exists(nextKind, id)) {
      setStatus(`${nextKind.toUpperCase()} ${hex(id)} NOT CREATED · EDIT A REFERENCE CELL TO CREATE & LINK`, "amber");
      refresh();
      return false;
    }
    const result = await commands.dispatch({
      type: "context.openExisting",
      kind: nextKind,
      id,
      source: "mobile-context-picker",
    });
    if (!result || result.ok === false) {
      refresh();
      return false;
    }
    forceMobileWorkspace(nextKind);
    return true;
  }

  async function apply() {
    const value = Number.parseInt(normalizeBuffer(buffer), 16);
    if (await selectContextId(kind, value)) close();
  }

  function inject() {
    if ($("#p3ContextPicker")) return;
    const chainButton = document.createElement("button");
    chainButton.id = "p3ChainIdButton";
    chainButton.className = "p3-context-id-button";
    chainButton.type = "button";
    chainButton.setAttribute("aria-label", "Open existing Chain ID");
    $(".chain-subpane .subpane-header")?.prepend(chainButton);

    const phraseButton = document.createElement("button");
    phraseButton.id = "p3PhraseIdButton";
    phraseButton.className = "p3-context-id-button";
    phraseButton.type = "button";
    phraseButton.setAttribute("aria-label", "Open existing Phrase ID");
    $(".phrase-subpane .subpane-header")?.prepend(phraseButton);

    const picker = document.createElement("section");
    picker.id = "p3ContextPicker";
    picker.className = "p3-context-picker";
    picker.setAttribute("aria-hidden", "true");
    picker.setAttribute("aria-label", "Existing Chain or Phrase context picker");
    picker.innerHTML = `
      <header class="p3-context-picker-header">
        <div><span id="p3ContextPickerKind">OPEN PHRASE</span><small>EXISTING HEX ID · 00–FF</small></div>
        <strong id="p3ContextPickerValue">00</strong>
        <button id="p3ContextPickerClose" type="button" aria-label="Close ID picker">×</button>
      </header>
      <div class="p3-context-keypad">
        ${HEX_DIGITS.map((digit) => `<button type="button" data-hex-digit="${digit}">${digit}</button>`).join("")}
      </div>
      <footer class="p3-context-picker-actions">
        <button id="p3ContextPickerBackspace" type="button">⌫</button>
        <button id="p3ContextPickerClear" type="button">CLEAR</button>
        <button id="p3ContextPickerApply" class="primary" type="button">OPEN 00</button>
      </footer>`;
    $("#appShell")?.append(picker);

    document.addEventListener("click", (event) => {
      const target = event.target;
      const digit = target.closest("#p3ContextPicker [data-hex-digit]");
      if (digit) { event.preventDefault(); event.stopImmediatePropagation(); typeDigit(digit.dataset.hexDigit); return; }
      if (target.closest("#p3ContextPickerClose")) { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
      if (target.closest("#p3ContextPickerBackspace")) { event.preventDefault(); event.stopImmediatePropagation(); backspace(); return; }
      if (target.closest("#p3ContextPickerClear")) { event.preventDefault(); event.stopImmediatePropagation(); clear(); return; }
      if (target.closest("#p3ContextPickerApply")) { event.preventDefault(); event.stopImmediatePropagation(); apply(); return; }
      if (target.closest("#p3ChainIdButton")) { event.preventDefault(); event.stopImmediatePropagation(); open("chain"); return; }
      if (target.closest("#p3PhraseIdButton")) { event.preventDefault(); event.stopImmediatePropagation(); open("phrase"); }
    }, true);

    document.addEventListener("keydown", (event) => {
      if (entryState.getActiveSheet() !== "context") return;
      if (event.code === "Escape") close();
      else if (event.code === "Enter") apply();
      else if (event.code === "Backspace") backspace();
      else {
        const digit = event.key.toUpperCase();
        if (HEX_DIGITS.includes(digit)) typeDigit(digit);
      }
    }, true);
  }

  function renderNavigationState(activeSheet = entryState.getActiveSheet()) {
    if (activeSheet === "context") refresh();
  }

  function renderButtons() {
    const chainButton = $("#p3ChainIdButton");
    const phraseButton = $("#p3PhraseIdButton");
    if (chainButton) chainButton.innerHTML = `<span>CHAIN</span><strong>${hex(state.chain)}</strong><small>SONG ${hex(state.songRow)} · T${state.track + 1}</small>`;
    if (phraseButton) phraseButton.innerHTML = `<span>PHRASE</span><strong>${hex(state.phrase)}</strong><small>CHAIN ${hex(state.chain)} · ROW ${hex(state.chainRow)}</small>`;
    if (entryState.getActiveSheet() === "context") refresh();
  }

  inject();
  renderButtons();
  globalThis.BRKTRKStoreRuntime?.navigationSubscribers?.refreshActiveSheet?.();
  commands.subscribe((record) => {
    renderButtons();
    if (record.command?.type === "workspace.select") requestAnimationFrame(() => forceMobileWorkspace(record.command.workspace));
  });

  globalThis.BRKTRKMobileContextPicker = Object.freeze({
    open,
    close,
    refresh: renderButtons,
    renderNavigationState,
    forceMobileWorkspace,
    selectContextId,
  });
})();
