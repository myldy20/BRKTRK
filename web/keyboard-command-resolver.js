(() => {
  const RESERVED_SHORTCUTS = Object.freeze({
    duplicate: Object.freeze({ key: "d", modifier: "primary", shift: false }),
    // UX0-03 (#373). Same letter because it is the same idea one level down:
    // Ctrl/Cmd+D copies the row, Ctrl/Cmd+Shift+D copies the object the row
    // points at and moves only this cell onto the copy.
    makeUnique: Object.freeze({ key: "d", modifier: "primary", shift: true }),
  });
  const TRACKER_PANES = Object.freeze(["song", "chain", "phrase"]);

  function runtimeState(root = globalThis) {
    return root.state ?? (typeof state !== "undefined" ? state : null);
  }

  function isEditableTarget(target) {
    return Boolean(target?.matches?.("input, textarea, select, [contenteditable='true']"));
  }

  function activeWorkspace(root = globalThis) {
    const current = runtimeState(root);
    return current?.p3?.activeWorkspace ?? current?.focus?.pane ?? current?.view ?? null;
  }

  function activeSheet(root = globalThis) {
    const current = runtimeState(root);
    return root.BRKTRKStores?.navigation?.entryState?.getActiveSheet?.()
      ?? current?.p3?.activeSheet
      ?? null;
  }

  function selectionTargetPane(root = globalThis) {
    const current = runtimeState(root);
    const selection = root.BRKTRKSelectionClipboard?.getSelection?.() ?? null;
    if (!selection?.active || !TRACKER_PANES.includes(selection.pane)) return null;
    if (selection.pane === "chain" && Number(selection.contextId) !== Number(current?.chain)) return null;
    if (selection.pane === "phrase" && Number(selection.contextId) !== Number(current?.phrase)) return null;
    return selection.pane;
  }

  function duplicateTargetPane(root = globalThis) {
    const selectedPane = selectionTargetPane(root);
    if (selectedPane) return selectedPane;
    const focusPane = runtimeState(root)?.focus?.pane ?? null;
    return TRACKER_PANES.includes(focusPane) ? focusPane : null;
  }

  function matchingPhraseSelection(root = globalThis) {
    return selectionTargetPane(root) === "phrase";
  }

  function phraseKeyboardTargetAvailable(root = globalThis) {
    return duplicateTargetPane(root) === "phrase" && activeWorkspace(root) === "phrase";
  }

  function blockingDialogOpen(root = globalThis) {
    return Boolean(
      root.document?.querySelector?.("#helpDialog")?.open
      || root.document?.querySelector?.("#settingsDialog")?.open,
    );
  }

  function resolveKeydown(event = {}, root = globalThis) {
    if (event.defaultPrevented || event.altKey) return Object.freeze({ handled: false });
    if (isEditableTarget(event.target) || blockingDialogOpen(root)) return Object.freeze({ handled: false });

    const modifier = Boolean(event.metaKey || event.ctrlKey);
    const key = String(event.key ?? "").toLowerCase();
    const code = String(event.code ?? "");
    if (!modifier || (key !== RESERVED_SHORTCUTS.duplicate.key && code !== "KeyD")) {
      return Object.freeze({ handled: false });
    }

    // Shift is the only distinguishing modifier, so it decides which of the
    // two semantics this is before anything else looks at the surface.
    const shift = Boolean(event.shiftKey);
    const semantic = shift ? "make-unique" : "duplicate";
    const semanticLabel = shift ? "MAKE UNIQUE" : "DUPLICATE";

    const workspace = activeWorkspace(root);
    const sheet = activeSheet(root);
    if (sheet != null) {
      return Object.freeze({
        handled: true,
        semantic,
        workspace,
        reason: "contextual-sheet-active",
        status: `${semanticLabel} BLOCKED · ${String(sheet).toUpperCase()} OWNS INPUT`,
        tone: "amber",
      });
    }

    if (shift) {
      // Sound and Mix borrow the screen while state.focus still names a
      // tracker cell, so routing on focus alone would repoint a cell the
      // musician cannot see. The visible workspace has to be the tracker.
      if (!TRACKER_PANES.includes(workspace)) {
        return Object.freeze({
          handled: true,
          semantic,
          workspace,
          reason: "tracker-workspace-not-active",
          status: `MAKE UNIQUE · TRACKER NOT ACTIVE${workspace ? ` · ${String(workspace).toUpperCase()} ACTIVE` : ""}`,
          tone: "amber",
        });
      }
      const commands = root.BRKTRKCommands;
      if (!commands?.installed || typeof commands.dispatch !== "function") {
        return Object.freeze({ handled: true, semantic, workspace, reason: "commands-unavailable", status: "MAKE UNIQUE INITIALIZING", tone: "amber" });
      }
      // Which cells this accepts, and what to say when it refuses, belongs to
      // the dispatcher; the command carries no cursor so it reads the live
      // one. There is no second copy of that rule here.
      return Object.freeze({
        handled: true,
        semantic,
        workspace,
        pane: workspace,
        reason: "resolved",
        owner: "commands",
        command: Object.freeze({ type: "structure.duplicateAndRepoint", source: "keyboard-command-resolver" }),
      });
    }

    const pane = duplicateTargetPane(root);
    if (!pane) {
      return Object.freeze({
        handled: true,
        semantic: "duplicate",
        workspace,
        reason: "tracker-target-unavailable",
        status: `DUPLICATE · TRACKER TARGET NOT ACTIVE${workspace ? ` · ${String(workspace).toUpperCase()} ACTIVE` : ""}`,
        tone: "amber",
      });
    }

    if (pane === "phrase") {
      const phraseRows = root.BRKTRKPhraseRowOperations;
      if (!phraseRows?.installed || typeof phraseRows.dispatch !== "function") {
        return Object.freeze({ handled: true, semantic: "duplicate", workspace, pane, reason: "phrase-row-operations-unavailable", status: "DUPLICATE INITIALIZING", tone: "amber" });
      }
      if (!phraseKeyboardTargetAvailable(root)) {
        return Object.freeze({ handled: true, semantic: "duplicate", workspace, pane, reason: "phrase-target-unavailable", status: "DUPLICATE · PHRASE TARGET NOT ACTIVE", tone: "amber" });
      }
      return Object.freeze({
        handled: true,
        semantic: "duplicate",
        workspace,
        pane,
        reason: "resolved",
        owner: "phrase-row-operations",
        command: Object.freeze({ type: "phrase.rows.duplicate", source: "keyboard-command-resolver" }),
      });
    }

    const structuralRows = root.BRKTRKStructuralRowOperations;
    if (!structuralRows?.installed || typeof structuralRows.dispatch !== "function") {
      return Object.freeze({ handled: true, semantic: "duplicate", workspace, pane, reason: "structural-row-operations-unavailable", status: "DUPLICATE INITIALIZING", tone: "amber" });
    }

    return Object.freeze({
      handled: true,
      semantic: "duplicate",
      workspace,
      pane,
      reason: "resolved",
      owner: "structural-row-operations",
      command: Object.freeze({ type: "structure.rows.duplicate", pane, source: "keyboard-command-resolver" }),
    });
  }

  function dispatchResolved(decision, root = globalThis) {
    if (!decision?.command) return null;
    if (decision.owner === "phrase-row-operations") return root.BRKTRKPhraseRowOperations?.dispatch?.(decision.command) ?? null;
    if (decision.owner === "structural-row-operations") return root.BRKTRKStructuralRowOperations?.dispatch?.(decision.command) ?? null;
    if (decision.owner === "commands") return root.BRKTRKCommands?.dispatch?.(decision.command) ?? null;
    return null;
  }

  function handleKeydown(event, root = globalThis) {
    const decision = resolveKeydown(event, root);
    if (!decision.handled) return decision;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    if (decision.command) void dispatchResolved(decision, root);
    else if (decision.status) root.setStatus?.(decision.status, decision.tone);
    return decision;
  }

  function install(root = globalThis) {
    if (root.BRKTRKKeyboardCommandResolver?.installed) return root.BRKTRKKeyboardCommandResolver;
    const listener = (event) => handleKeydown(event, root);
    root.document?.addEventListener?.("keydown", listener, true);
    const snapshot = () => Object.freeze({
      installed: true,
      ownsReservedBrowserShortcuts: true,
      shortcuts: Object.freeze({ duplicate: "Ctrl/Cmd+D", makeUnique: "Ctrl/Cmd+Shift+D" }),
      duplicateScope: "tracker-row",
      makeUniqueScope: "referenced-object-at-cursor",
      makeUniqueOwner: "command-dispatcher",
      targetRule: "matching-current-context-selection-else-canonical-focus",
      songChainBehavior: "duplicate-shared-reference-rows",
      phraseBehavior: "duplicate-rows-by-value",
      diagnosticState: "none",
    });
    const api = Object.freeze({
      installed: true,
      resolveKeydown: (event) => resolveKeydown(event, root),
      handleKeydown: (event) => handleKeydown(event, root),
      snapshot,
      dispose() { root.document?.removeEventListener?.("keydown", listener, true); },
    });
    root.BRKTRKDiagnostics?.registerSection?.("keyboardCommandResolver", snapshot);
    root.BRKTRKKeyboardCommandResolver = api;
    return api;
  }

  const exported = Object.freeze({
    RESERVED_SHORTCUTS,
    TRACKER_PANES,
    runtimeState,
    isEditableTarget,
    activeWorkspace,
    activeSheet,
    selectionTargetPane,
    duplicateTargetPane,
    matchingPhraseSelection,
    phraseKeyboardTargetAvailable,
    blockingDialogOpen,
    resolveKeydown,
    dispatchResolved,
    handleKeydown,
    install,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  globalThis.BRKTRKKeyboardCommandResolverDomain = exported;
  if (globalThis.document) install(globalThis);
})();
