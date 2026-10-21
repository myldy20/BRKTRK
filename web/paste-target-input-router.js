(() => {
  if (globalThis.BRKTRKPasteTargetInputRouter?.installed) return;

  const SUPPORTED_PANES = new Set(["song", "chain", "phrase"]);
  const KEYBOARD_NAVIGATION_SOURCES = new Set(["keyboard"]);
  const commands = globalThis.BRKTRKCommands;

  function isPhone() {
    return Boolean(globalThis.matchMedia?.("(max-width: 760px)")?.matches);
  }

  function controllerState() {
    const controller = globalThis.BRKTRKSelectionClipboard;
    if (!controller?.snapshot || !controller?.getClipboardMetadata || !controller?.retargetPasteTarget || !controller?.cancelSelection) return null;
    const snapshot = controller.snapshot();
    const clipboard = controller.getClipboardMetadata();
    if (!snapshot?.pasteTarget?.armed || snapshot.pasteTarget.movePending || !clipboard?.available) return null;
    return { controller, snapshot, clipboard };
  }

  function cellTarget(event) {
    if (!event || event.defaultPrevented || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null;
    const cell = event.target?.closest?.("[data-pane][data-row][data-col]");
    if (!cell) return null;
    const pane = String(cell.dataset.pane || "");
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!SUPPORTED_PANES.has(pane) || !Number.isInteger(row) || !Number.isInteger(col)) return null;
    return { pane, row, col };
  }

  function handleClick(event) {
    const state = controllerState();
    if (!state) return;

    const target = cellTarget(event);
    if (!target || state.clipboard.pane !== target.pane) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void state.controller.retargetPasteTarget(target, "pointer-cell-precommand-router");
  }

  function keyboardTarget(record) {
    const command = record?.command;
    if (!command || record.ok === false || command.type !== "cursor.move") return null;
    if (!KEYBOARD_NAVIGATION_SOURCES.has(String(command.source || ""))) return null;
    if (isPhone()) return null;
    const state = controllerState();
    if (!state) return null;
    const cursor = commands?.runtime?.trackerCursor;
    const pane = String(cursor?.pane || "");
    const row = Number(cursor?.row);
    const col = Number(cursor?.col);
    if (!SUPPORTED_PANES.has(pane) || state.clipboard.pane !== pane || !Number.isInteger(row) || !Number.isInteger(col)) return null;
    return { state, target: { pane, row, col } };
  }

  function handleCommand(record) {
    const resolved = keyboardTarget(record);
    if (!resolved) return;

    // The semantic cursor.move command has already installed the destination.
    // Do not redispatch cursor.select: doing so can trigger secondary editors
    // (notably the phone Phrase Note dock) and can reintroduce ordering races.
    // Clearing the stale source rectangle makes the canonical trackerCursor the
    // sole desktop keyboard Paste destination. Paste itself then performs the
    // normal semantic-field compatibility check against that cursor.
    resolved.state.controller.cancelSelection("keyboard-paste-target-cursor-moved");
  }

  document.addEventListener("click", handleClick, true);
  const unsubscribeCommands = commands?.subscribe?.(handleCommand) ?? (() => {});

  globalThis.BRKTRKPasteTargetInputRouter = Object.freeze({
    installed: true,
    snapshot() {
      return Object.freeze({
        installed: true,
        order: "document-capture-before-command-bindings",
        keyboardRoute: "desktop-post-command-cursor-as-destination",
        phoneKeyboardRoute: "not-intercepted-use-touch-target",
      });
    },
    dispose() {
      unsubscribeCommands?.();
      document.removeEventListener?.("click", handleClick, true);
    },
  });
})();
