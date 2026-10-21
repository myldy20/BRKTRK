(() => {
  const commands = globalThis.BRKTRKCommands;
  const fields = globalThis.BRKTRKFieldSchema;
  const policy = globalThis.BRKTRKTouchActionPolicy;
  if (!commands?.installed || !fields || !policy || !globalThis.BRKTRKValueDock || !globalThis.BRKTRKCommandBindings) {
    throw new Error("P3.4 touch actions require commands, field schema, policy, Value Dock and command bindings");
  }

  const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
  const navigationStore = globalThis.BRKTRKStores?.navigation;
  const navigationSelectors = globalThis.BRKTRKStoreTypes?.selectors;
  const schemaEnv = { state, model, chain, phrase, firstUnused, noteName, fxName, hex, clamp, EMPTY, NOTE_OFF };
  let armedCell = "";
  let armedTimer = 0;
  let valueOpenPromise = Promise.resolve();

  function cellKey() {
    return `${state.focus.pane}:${state.focus.row}:${state.focus.col}`;
  }

  function resetArm() {
    window.clearTimeout(armedTimer);
    armedTimer = 0;
    armedCell = "";
  }

  function descriptorAtFocus() {
    return fields.resolve(state.focus.pane, state.focus.col);
  }

  function isStructuralReference(descriptor) {
    return descriptor?.referenceKind === "chain" || descriptor?.referenceKind === "phrase";
  }

  function referenceLabel(kind, value) {
    return `${String(kind ?? "reference").toUpperCase()} ${hex(value)}`;
  }

  // UX0-03 (#373). The graph is the only thing that knows how many places
  // reach an object; the policy must not guess, so it is told.
  function sharedCountFor(descriptor, value) {
    if (!isStructuralReference(descriptor) || !Number.isInteger(value) || value < 0) return 0;
    const graph = globalThis.BRKTRKStructuralReferenceGraph;
    if (!graph?.referenceCount) return 0;
    return graph.referenceCount(model, descriptor.referenceKind, value);
  }

  function selectionState() {
    const workspace = state.p3?.activeWorkspace ?? state.view;
    if (workspace === "sound" || workspace === "mix") {
      const canReturn = workspace === "mix"
        ? Boolean(navigationStore?.select(navigationSelectors?.mixReturnContext))
        : Array.isArray(state.p3?.parents) && state.p3.parents.length > 0;
      return policy.describe({ workspace, pane: state.focus.pane, canReturn });
    }
    const descriptor = descriptorAtFocus();
    if (!descriptor) return policy.describe({ workspace, pane: state.focus.pane });
    const value = fields.read(schemaEnv, descriptor);
    const childValue = isStructuralReference(descriptor) ? value : EMPTY;
    const childKind = isStructuralReference(descriptor) ? descriptor.referenceKind : null;
    const childExists = childKind ? fields.referenceExists(schemaEnv, descriptor, childValue) : false;
    return policy.describe({
      workspace,
      pane: state.focus.pane,
      descriptor,
      value,
      childValue,
      childKind,
      childExists,
      sharedCount: sharedCountFor(descriptor, value),
    });
  }

  function setButtonLabel(button, label) {
    const text = String(label ?? "—");
    const words = text.trim().split(/\s+/).filter(Boolean);
    const multiline = words.length > 1 && words[0] !== "‹";
    button.setAttribute("aria-label", text);
    button.dataset.labelLines = multiline ? "2" : "1";
    if (!multiline) {
      button.textContent = text;
      return;
    }

    const first = document.createElement("span");
    first.className = "p34-action-line";
    first.textContent = words[0];
    const second = document.createElement("span");
    second.className = "p34-action-line";
    second.textContent = ` ${words.slice(1).join(" ")}`;
    button.replaceChildren(first, second);
  }

  function setButton(button, action, tone = "") {
    if (!button) return;
    button.hidden = action?.visible === false;
    button.disabled = !action?.enabled;
    setButtonLabel(button, action?.label ?? "—");
    if (tone) button.dataset.tone = tone;
    else delete button.dataset.tone;
  }

  function refreshValueOpen() {
    const button = $("#p34ValueOpen");
    const footer = button?.closest(".p32-value-actions");
    if (!button || !footer) return;
    const descriptor = descriptorAtFocus();
    const visible = isPhone()
      && document.body.classList.contains("p32-value-open")
      && isStructuralReference(descriptor);
    button.hidden = !visible;
    footer.classList.toggle("p34-has-open", visible);
    if (!visible) return;

    const value = fields.parse(descriptor, $("#p32ValueInput")?.value);
    if (!Number.isFinite(value)) {
      button.disabled = true;
      button.textContent = "INVALID ID";
      return;
    }
    if (value < 0) {
      button.disabled = true;
      button.textContent = "CHOOSE ID";
      return;
    }
    const exists = fields.referenceExists(schemaEnv, descriptor, value);
    button.disabled = false;
    button.textContent = `${exists ? "LINK & OPEN" : "CREATE & OPEN"} ${hex(value)}`;
  }

  function refresh() {
    refreshValueOpen();
    const bar = $("#p34TouchActions");
    if (!bar) return;
    // The strip is phone-only, and describing a cell now asks the reference
    // graph, which walks the arrangement. On desktop that answer is discarded,
    // so the question is not asked at all.
    if (!isPhone()) {
      bar.hidden = true;
      resetArm();
      return;
    }
    const view = selectionState();
    if (!view.visible) {
      bar.hidden = true;
      resetArm();
      return;
    }
    bar.hidden = false;

    setButton($("#p34Back"), view.back);
    setButton($("#p34Open"), view.open, view.open.mode === "fresh" || view.open.mode === "repair" ? "cyan" : "");
    setButton($("#p34Edit"), view.edit, "pink");
    setButton($("#p34Unique"), view.unique, view.unique.tone);
    const clear = armedCell === cellKey() && view.clear.confirm
      ? { ...view.clear, enabled: true, label: "CONFIRM" }
      : view.clear;
    setButton($("#p34Clear"), clear, clear.tone);
    bar.dataset.pane = view.pane;
    bar.dataset.openMode = view.open.mode;
    bar.dataset.sharedCount = String(view.sharedCount ?? 0);
    // The strip has never had a fixed slot count - Song hides BACK - and the
    // new action adds a fifth on reference cells. Published so the layout
    // evidence can name the case it measured; no stylesheet needs it, because
    // five slots measured 72px wide at 390px and want no sizing of their own.
    bar.dataset.slots = String([view.back, view.open, view.edit, view.unique, view.clear]
      .filter((action) => action?.visible !== false).length);
  }

  async function openSelected() {
    const view = selectionState();
    if (!view.visible || !view.open.enabled) return;
    resetArm();

    if (view.open.mode === "sound" || view.open.mode === "open") {
      await commands.dispatch({ type: "hierarchy.openChild", source: "touch-action-open" });
      return;
    }

    const descriptor = descriptorAtFocus();
    if (!isStructuralReference(descriptor)) return;
    const value = view.open.mode === "fresh"
      ? Number(descriptor.freshId?.(schemaEnv) ?? descriptor.defaultValue ?? 0)
      : view.childValue;
    const result = await commands.dispatch({
      type: "field.setExact",
      value,
      createMissing: true,
      source: view.open.mode === "fresh" ? "touch-action-new" : "touch-action-repair",
    });
    if (result?.ok !== false) await commands.dispatch({ type: "hierarchy.openChild", source: "touch-action-open-created" });
  }

  function editSelected() {
    resetArm();
    const descriptor = descriptorAtFocus();
    if (!descriptor) return;
    if (descriptor.editorKind === "note") globalThis.BRKTRKCommandBindings.openNoteDock();
    else globalThis.BRKTRKValueDock.open();
    requestAnimationFrame(refreshValueOpen);
  }

  async function applyAndOpenExact() {
    const descriptor = descriptorAtFocus();
    if (!isStructuralReference(descriptor)) return { ok: false, reason: "not-structural" };
    const input = $("#p32ValueInput");
    const value = fields.parse(descriptor, input?.value);
    if (!Number.isFinite(value) || value < 0) {
      setStatus("CHOOSE A REFERENCE ID", "danger");
      input?.focus();
      return { ok: false, reason: "invalid-reference" };
    }

    const writeResult = await commands.dispatch({
      type: "field.setExact",
      value,
      createMissing: true,
      source: "value-dock-create-open",
    });
    if (writeResult?.ok === false) return writeResult;

    const written = fields.read(schemaEnv, descriptor) === value
      && fields.referenceExists(schemaEnv, descriptor, value);
    if (!written) return { ok: false, reason: "reference-write-not-applied" };

    await globalThis.BRKTRKValueDock.close({ restore: false });
    return commands.dispatch({ type: "hierarchy.openChild", source: "value-dock-open-created" });
  }

  function queueApplyAndOpenExact(event = null) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const button = $("#p34ValueOpen");
    if (button) button.dataset.busy = "true";
    valueOpenPromise = Promise.resolve(applyAndOpenExact())
      .catch((error) => {
        console.error(error);
        setStatus("REFERENCE OPEN FAILED", "danger");
        return { ok: false, error };
      })
      .finally(() => {
        if (button) delete button.dataset.busy;
        refreshValueOpen();
      });
    return valueOpenPromise;
  }

  function captureValueOpen(event) {
    const button = event.currentTarget?.closest?.("#p34ValueOpen") ?? event.target?.closest?.("#p34ValueOpen");
    if (!button || button.disabled) return;
    queueApplyAndOpenExact(event);
  }

  async function clearSelected() {
    const view = selectionState();
    if (!view.visible || !view.clear.enabled) return;
    const key = cellKey();
    const retainedReference = view.structuralReference && view.selectedValue >= 0
      ? { kind: view.childKind, value: view.selectedValue }
      : null;

    if (view.clear.confirm && armedCell !== key) {
      resetArm();
      armedCell = key;
      const detail = retainedReference
        ? `${referenceLabel(retainedReference.kind, retainedReference.value)} FROM THIS CELL · OBJECT KEPT`
        : view.clear.label;
      // UX0-04 (#373): the label says UNLINK; the confirmation and completion
      // must not hand "DETACH" back at the exact moment the musician is
      // deciding. "DETACH" reads as separating this one from the others,
      // which is MAKE UNIQUE - a different, non-destructive operation.
      setStatus(`UNLINK ${detail} · TAP CONFIRM`, "amber");
      armedTimer = window.setTimeout(() => {
        resetArm();
        refresh();
      }, 2200);
      refresh();
      return;
    }

    resetArm();
    const result = await commands.dispatch({
      type: view.clear.command === "clear" ? "field.clear" : "field.reset",
      source: "touch-action-clear",
    });
    if (result?.ok !== false && retainedReference) {
      setStatus(`${referenceLabel(retainedReference.kind, retainedReference.value)} UNLINKED HERE · OBJECT KEPT`, "amber");
    }
  }

  // UX0-03 (#373). Same semantic command the desktop shortcut sends; the
  // dispatcher owns which cells it accepts and says why when it refuses, so
  // there is no second copy of that rule here.
  async function makeUniqueSelected() {
    const view = selectionState();
    if (!view.visible || !view.unique.enabled) return;
    resetArm();
    return commands.dispatch({ type: "structure.duplicateAndRepoint", source: "touch-action-unique" });
  }

  async function returnParent() {
    resetArm();
    await commands.dispatch({ type: "hierarchy.return", source: "touch-action-back" });
  }

  function inject() {
    if ($("#p34TouchActions")) return;
    const bar = document.createElement("nav");
    bar.id = "p34TouchActions";
    bar.className = "p34-touch-actions";
    bar.hidden = true;
    bar.setAttribute("aria-label", "Selected tracker field actions");
    bar.innerHTML = `
      <button id="p34Back" type="button">‹ BACK</button>
      <button id="p34Open" type="button">OPEN</button>
      <button id="p34Edit" type="button">EDIT</button>
      <button id="p34Unique" type="button" hidden>MAKE UNIQUE</button>
      <button id="p34Clear" type="button">CLEAR</button>`;
    $(".command-bar")?.append(bar);

    const valueOpen = document.createElement("button");
    valueOpen.id = "p34ValueOpen";
    valueOpen.className = "p34-value-open primary";
    valueOpen.type = "button";
    valueOpen.hidden = true;
    valueOpen.textContent = "CREATE & OPEN";
    $(".p32-value-actions")?.insertBefore(valueOpen, $("#p32ValueApply"));

    $("#p34Back")?.addEventListener("click", returnParent);
    $("#p34Open")?.addEventListener("click", openSelected);
    $("#p34Edit")?.addEventListener("click", editSelected);
    $("#p34Unique")?.addEventListener("click", makeUniqueSelected);
    $("#p34Clear")?.addEventListener("click", clearSelected);
    valueOpen.addEventListener("click", captureValueOpen);
    $("#p32ValueInput")?.addEventListener("input", refreshValueOpen, true);
    $("#mobileTabs")?.addEventListener("click", resetArm, true);
    const valueDock = $("#p32ValueDock");
    if (valueDock) new MutationObserver(refreshValueOpen).observe(valueDock, { attributes: true, attributeFilter: ["aria-hidden"] });
    document.body.classList.add("p34-touch-actions-ready");
  }

  commands.subscribe(() => refresh());
  window.addEventListener("resize", refresh);
  inject();
  refresh();

  globalThis.BRKTRKTouchActions = Object.freeze({
    refresh,
    selectionState,
    openSelected,
    editSelected,
    applyAndOpenExact: queueApplyAndOpenExact,
    whenValueOpenIdle: () => valueOpenPromise,
    clearSelected,
    makeUniqueSelected,
    returnParent,
  });
})();