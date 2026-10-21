(() => {
  const types = globalThis.BRKTRKCommandState
    ?? (typeof require === "function" ? require("./command-state.js") : null);
  const contract = globalThis.BRKTRKP3
    ?? (typeof require === "function" ? require("./p3-contract.js") : null);
  const fields = globalThis.BRKTRKFieldSchema
    ?? (typeof require === "function" ? require("./field-schema.js") : null);
  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  if (!types || !contract || !fields || !storeTypes) throw new Error("M4.0A command dependencies are not loaded");

  function resolveInputCommand({ code, repeat = false, modifiers = {}, workspace = "phrase" }) {
    const option = Boolean(modifiers.option);
    const edit = Boolean(modifiers.edit);
    const shift = Boolean(modifiers.shift);
    if (code.startsWith("Arrow")) {
      if (workspace === "mix") {
        if (shift && (code === "ArrowUp" || code === "ArrowLeft")) return { type: "hierarchy.return", source: "input" };
        if (edit) return { type: "mix.adjustGain", direction: code, source: "input" };
        if (code === "ArrowLeft" || code === "ArrowRight") return { type: "mix.selectTrack", direction: code, source: "input" };
        return { type: "invalid", message: "MIX · ←/→ SELECT TRACK · S+ARROWS GAIN" };
      }
      if (workspace === "sound") {
        if (shift && code === "ArrowLeft") return { type: "hierarchy.return", source: "input" };
        if (shift && code === "ArrowDown") return { type: "workspace.openMix", source: "input" };
        if (option && (code === "ArrowLeft" || code === "ArrowRight")) return { type: "sound.selectInstrument", direction: code, source: "input" };
        if (edit) return { type: "sound.adjustParam", direction: code, source: "input" };
        if (code === "ArrowLeft" || code === "ArrowRight") return { type: "sound.selectParam", direction: code, source: "input" };
        return { type: "invalid", message: "SOUND · ←/→ SELECT PARAMETER · S+ARROWS EDIT" };
      }
      if (shift) {
        if (code === "ArrowRight") return { type: "hierarchy.openChild", source: "input" };
        if (shift && code === "ArrowLeft") return { type: "hierarchy.return", source: "input" };
        if (shift && code === "ArrowDown") return { type: "workspace.openMix", source: "input" };
        return { type: "invalid", message: "NO HIERARCHY TARGET" };
      }
      if (edit) return { type: "field.adjust", direction: code, source: "input" };
      if (option) return { type: "context.navigate", direction: code, source: "input" };
      return { type: "cursor.move", direction: code, source: "input" };
    }
    if (code === "KeyX" && !repeat) return { type: "transport.toggle", forceSong: shift, source: "input" };
    return null;
  }

  function install(root, env) {
    if (!root.document || root.BRKTRKCommands?.installed || !env) return root.BRKTRKCommands;
    const legacy = Object.freeze({
      keyDown: root.keyDown,
      keyUp: root.keyUp,
      setFocus: root.setFocus,
      focusSelectedCell: root.focusSelectedCell,
      currentValue: root.currentValue,
      clearCurrentCell: root.clearCurrentCell,
      insertCurrentCell: root.insertCurrentCell,
      optionNavigate: root.optionNavigate,
      editCurrentCell: root.editCurrentCell,
      persist: root.persist,
      renderAll: root.renderAll,
      renderTrackerCursor: root.renderTrackerCursor,
      renderTransport: root.renderTransport,
      togglePlayback: root.togglePlayback,
      stopPlayback: root.stopPlayback,
    });
    const hierarchyRenderer = root.BRKTRKHierarchyRenderer;
    const mixContextRenderer = root.BRKTRKMixContextRenderer;
    const occurrenceContextRenderer = root.BRKTRKOccurrenceContextRenderer;
    const workspaceContextRenderer = root.BRKTRKWorkspaceContextRenderer;
    const soundEditRenderer = root.BRKTRKSoundEditRenderer;
    const projectStore = env.projectStore ?? root.BRKTRKStores?.project;
    const navigationStore = env.navigationStore ?? root.BRKTRKStores?.navigation;
    if (!projectStore || !navigationStore) throw new Error("ProjectStore and NavigationStore are required before command installation");
    if (!hierarchyRenderer?.render) throw new Error("G4 targeted hierarchy renderer is required before command installation");
    if (!mixContextRenderer?.render) throw new Error("G5 targeted Mix renderer is required before command installation");
    if (!occurrenceContextRenderer?.render) throw new Error("G6 targeted occurrence renderer is required before command installation");
    if (!workspaceContextRenderer?.render) throw new Error("G7 targeted workspace renderer is required before command installation");
    if (!soundEditRenderer?.renderSelection || !soundEditRenderer?.renderFieldCompletion) throw new Error("G8 Sound/Edit renderer is required before command installation");
    if (!projectStore.phraseSteps) throw new Error("ProjectStore Phrase-step domain is required before command installation");
    env.projectStore = projectStore;
    env.navigationStore = navigationStore;
    env.soundEditRenderer = soundEditRenderer;
    const entryState = navigationStore.entryState;
    if (!entryState) throw new Error("NavigationStore entry state is required before command installation");

    const runtime = {
      activeWorkspace: types.normalizeWorkspace(env.state.p3?.activeWorkspace ?? env.state.view ?? env.state.focus.pane),
      trackerCursor: types.createTrackerCursor(env.state.focus),
      returnStack: [],
      mixReturn: null,
      history: new types.CommandHistory(128),
      listeners: new Set(),
      modifierPresses: new Map(),
      lastInsertCell: "",
      lastInsertAt: 0,
      ephemeralSerial: 0,
      installedAt: Date.now(),
    };

    env.state.p3 ??= {};
    env.state.p3.parents ??= [];

    function normalizeContext(value) {
      if (!value) return null;
      return storeTypes.normalizeNavigationContext(value, env.state);
    }

    function syncRuntime() {
      runtime.activeWorkspace = types.normalizeWorkspace(env.state.p3.activeWorkspace ?? env.state.view ?? env.state.focus.pane, runtime.activeWorkspace);
      runtime.trackerCursor = types.createTrackerCursor(env.state.focus);
      runtime.returnStack = (Array.isArray(env.state.p3.parents) ? env.state.p3.parents : []).map(normalizeContext).filter(Boolean);
      runtime.mixReturn = navigationStore.select(storeTypes.selectors.mixReturnContext);
    }
    syncRuntime();

    function captureContext() {
      syncRuntime();
      return navigationStore.captureContext();
    }

    function snapshot() {
      const context = captureContext();
      return types.createWorkspaceSnapshot({
        activeWorkspace: context.activeWorkspace,
        view: context.view,
        dock: context.dock,
        focus: context.focus,
        songRow: context.songRow,
        track: context.track,
        chain: context.chain,
        chainRow: context.chainRow,
        phrase: context.phrase,
        phraseRow: context.phraseRow,
        instrument: context.instrument,
        soundParam: context.soundParam,
      });
    }

    function descriptorChange(command, descriptor) {
      return types.createChangeSet({
        kind: descriptor?.changeKind ?? "ui",
        target: command.target ?? descriptor?.id ?? command.type,
        affectsPlayback: Boolean(descriptor?.affectsPlayback),
        persistsProject: Boolean(descriptor?.persistsProject),
      });
    }

    function changeFor(command, beforeValue, afterValue, result = {}) {
      if (result.projectChangeSet) return result.projectChangeSet;
      if (result.navigationChangeSet) return result.navigationChangeSet;
      if (result.descriptor) {
        const base = descriptorChange(command, result.descriptor);
        return types.createChangeSet({ ...base, before: beforeValue, after: afterValue });
      }
      const type = command.type;
      let kind = "ui";
      let affectsPlayback = false;
      let persistsProject = false;
      if (type.startsWith("cursor.") || type.startsWith("hierarchy.") || type.startsWith("workspace.") || type === "context.navigate") kind = "cursor";
      if (type.startsWith("note.")) { kind = "note"; affectsPlayback = persistsProject = true; }
      if (type.startsWith("sound.")) { kind = "parameter"; affectsPlayback = persistsProject = !type.startsWith("sound.select"); }
      if (type.startsWith("mix.")) {
        kind = "mix";
        affectsPlayback = false;
        persistsProject = !type.startsWith("mix.select");
      }
      if (type.startsWith("transport.") || type === "scope.set") kind = "transport";
      if (type === "tempo.set" || type === "project.rename") { kind = "project"; persistsProject = true; affectsPlayback = type === "tempo.set"; }
      return types.createChangeSet({
        kind, target: command.target ?? type, before: beforeValue, after: afterValue, affectsPlayback, persistsProject,
      });
    }

    function emit(record) {
      runtime.listeners.forEach((listener) => {
        try { listener(record); } catch (error) { console.error(error); }
      });
    }

    function commit(command, beforeSnapshot, beforeValue, afterValue, result = { ok: true }) {
      const afterSnapshot = snapshot();
      const changeSet = changeFor(command, beforeValue, afterValue, result);
      if (command.transient) {
        const record = Object.freeze({
          id: `t${++runtime.ephemeralSerial}`,
          command: { ...command }, before: beforeSnapshot, after: afterSnapshot,
          changeSet, ok: result.ok !== false, transient: true, timestamp: Date.now(),
        });
        emit(record);
        return { ...result, record, changeSet };
      }
      const record = runtime.history.push(command, beforeSnapshot, afterSnapshot, changeSet, result);
      emit(record);
      return { ...result, record, changeSet };
    }

    function fail(command, message, tone = "amber") {
      env.setStatus(message, tone);
      return { ok: false, message, changeSet: types.createChangeSet({ kind: "ui", target: command.type }) };
    }

    function auditionProductionNote(note, instrumentId = env.state.instrument, velocity = null) {
      if (!env.audio?.ready || !Number.isFinite(Number(note)) || Number(note) < 0) return false;
      const id = env.clamp(Math.round(Number(instrumentId) || 0), 0, 255);
      const instrument = projectStore.getState().instrumentPool?.[id];
      if (!instrument?.engineRef) return false;
      const row = env.phrase(env.state.phrase, false)?.[env.state.phraseRow];
      const resolvedVelocity = env.clamp(Math.round(Number(velocity ?? row?.velocity ?? 100) || 100), 1, 127);
      return root.BRKTRKProductionEngineBootstrap?.audition?.({
        track: env.clamp(Math.round(Number(env.state.track) || 0), 0, env.TRACKS - 1),
        instrumentId: id,
        note: env.clamp(Math.round(Number(note)), 0, 127),
        velocity: resolvedVelocity,
        durationMs: 240,
      }) ?? false;
    }

    function closeTransientUi(source = "navigation-context-change") {
      return entryState.closeAll({ source });
    }

    function renderNavigationContext(target, message = "NAVIGATE") {
      closeTransientUi();
      legacy.renderAll();
      syncRuntime();
      if (types.isStructuralWorkspace(target.activeWorkspace)) legacy.focusSelectedCell?.();
      else root.BRKTRKCommandBindings?.focusUtility?.();
      env.setStatus(`${message} ${target.activeWorkspace.toUpperCase()}`);
    }

    function restoreContext(context, message = "RETURN", metadata = {}) {
      const target = normalizeContext(context);
      if (!target) return false;
      const mutation = navigationStore.restoreContext(target, {
        source: metadata.source ?? message.toLowerCase().replaceAll(" ", "-"),
        target: metadata.target ?? "navigation.context.restore",
        path: metadata.path ?? ["structuralContext"],
      });
      if (!mutation.mutated) return false;
      renderNavigationContext(mutation.after, message);
      return mutation;
    }

    function renderHierarchyMutation(mutation, message = "NAVIGATE") {
      closeTransientUi("hierarchy-context-change");
      hierarchyRenderer.render(mutation);
      syncRuntime();
      const target = mutation.contextAfter ?? mutation.after?.context ?? mutation.after ?? mutation.value;
      if (types.isStructuralWorkspace(target?.activeWorkspace)) legacy.focusSelectedCell?.();
      else root.BRKTRKCommandBindings?.focusUtility?.();
      env.setStatus(message);
    }

    function restoreHierarchyContext(context, message = "RETURN", metadata = {}) {
      const target = normalizeContext(context);
      if (!target) return false;
      const mutation = navigationStore.restoreContext(target, {
        source: metadata.source ?? "hierarchy.return.fallback",
        target: metadata.target ?? "navigation.hierarchy.return",
        path: metadata.path ?? ["structuralContext"],
      });
      if (!mutation.mutated) return false;
      renderHierarchyMutation(mutation, message);
      return mutation;
    }

    function renderMixMutation(mutation, message = "MIX") {
      closeTransientUi("mix-context-change");
      mixContextRenderer.render(mutation);
      syncRuntime();
      const target = mutation.contextAfter ?? mutation.after?.context ?? mutation.after ?? mutation.value;
      if (types.isStructuralWorkspace(target?.activeWorkspace)) legacy.focusSelectedCell?.();
      else root.BRKTRKCommandBindings?.focusUtility?.();
      env.setStatus(message);
    }

    function renderOccurrenceMutation(mutation, message = "OCCURRENCE") {
      closeTransientUi("occurrence-context-change");
      occurrenceContextRenderer.render(mutation);
      syncRuntime();
      legacy.focusSelectedCell?.();
      env.setStatus(message);
    }

    function renderWorkspaceMutation(mutation, message = "WORKSPACE") {
      closeTransientUi("workspace-context-change");
      workspaceContextRenderer.render(mutation);
      syncRuntime();
      const target = mutation.contextAfter ?? mutation.after?.context ?? mutation.after ?? mutation.value;
      if (types.isStructuralWorkspace(target?.activeWorkspace)) legacy.focusSelectedCell?.();
      else root.BRKTRKCommandBindings?.focusUtility?.();
      env.setStatus(message);
    }

    function firstPopulatedChainRow(chainId) {
      const source = env.chain(chainId, false) ?? [];
      const index = source.findIndex((entry) => entry.phrase >= 0);
      return index >= 0 ? index : 0;
    }

    function contextForCursor(cursor) {
      const next = { ...captureContext(), focus: { ...cursor } };
      if (cursor.pane === "song") {
        next.songRow = cursor.row;
        next.track = cursor.col;
        const chainId = env.model.song[cursor.row]?.[cursor.col] ?? env.EMPTY;
        if (chainId >= 0 && Object.hasOwn(env.model.chains, chainId)) {
          next.chain = chainId;
          next.lastChain = chainId;
          next.chainRow = firstPopulatedChainRow(chainId);
          const phraseId = env.chain(chainId, false)?.[next.chainRow]?.phrase ?? env.EMPTY;
          if (phraseId >= 0 && Object.hasOwn(env.model.phrases, phraseId)) {
            next.phrase = phraseId;
            next.lastPhrase = phraseId;
          }
        }
      } else if (cursor.pane === "chain") {
        next.chainRow = cursor.row;
        const phraseId = env.chain(next.chain, false)?.[cursor.row]?.phrase ?? env.EMPTY;
        if (phraseId >= 0 && Object.hasOwn(env.model.phrases, phraseId)) {
          next.phrase = phraseId;
          next.lastPhrase = phraseId;
        }
      } else {
        next.phraseRow = cursor.row;
        const step = env.phrase(next.phrase, false)?.[cursor.row];
        if (step?.instrument >= 0) next.instrument = step.instrument;
      }
      return next;
    }

    function applyCursor(command, cursor, shouldFocus) {
      const before = snapshot();
      const limits = env.focusLimits(cursor.pane);
      const normalized = {
        pane: cursor.pane,
        row: env.clamp(cursor.row, 0, limits.rows - 1),
        col: env.clamp(cursor.col, 0, limits.cols - 1),
      };
      const old = { ...env.state.focus };
      const mutation = navigationStore.selectTrackerCursor(normalized, contextForCursor(normalized), {
        source: command.source ?? command.type,
        target: "navigation.trackerCursor",
      });
      if (mutation.mutated) {
        if (typeof legacy.renderTrackerCursor !== "function") throw new Error("Targeted Tracker cursor renderer is required");
        legacy.renderTrackerCursor(mutation);
        syncRuntime();
        if (shouldFocus) legacy.focusSelectedCell?.();
      } else {
        syncRuntime();
      }
      if (!mutation.mutated
          && old.pane === normalized.pane && old.row === normalized.row && old.col === normalized.col
          && shouldFocus === false && normalized.pane === "phrase" && normalized.col === 0) {
        root.BRKTRKCommandBindings?.openNoteDock?.();
      }
      return commit({ ...command, target: "navigation.trackerCursor" }, before, mutation.before, mutation.after, mutation);
    }

    function selectCursor(command) {
      const pane = storeTypes.STRUCTURAL_WORKSPACES.includes(command.pane) ? command.pane : env.state.focus.pane;
      return applyCursor(command, {
        pane,
        row: Number(command.row),
        col: Number(command.col),
      }, command.focus !== false);
    }

    function moveCursor(command) {
      if (!types.isStructuralWorkspace(runtime.activeWorkspace)) return fail(command, `${runtime.activeWorkspace.toUpperCase()} OWNS INPUT`);
      const old = { ...env.state.focus };
      const next = contract.moveWithin(old.pane, old.row, old.col, command.direction, env.focusLimits(old.pane));
      return applyCursor(command, next, true);
    }

    function enterHierarchy(command, before, parent, next, status, utility = false) {
      const mutation = navigationStore.enterContext(next, {
        parent,
        source: command.source ?? "hierarchy.openChild",
        target: "navigation.hierarchy.enter",
      });
      renderHierarchyMutation(mutation, status);
      return commit({ ...command, target: "navigation.hierarchy.enter" }, before, mutation.before, mutation.after, mutation);
    }

    function openChild(command) {
      if (!types.isStructuralWorkspace(runtime.activeWorkspace)) return fail(command, "NO STRUCTURAL CHILD");
      const pane = env.state.focus.pane;
      const row = env.state.focus.row;
      const col = env.state.focus.col;
      const before = snapshot();
      const parent = captureContext();

      if (pane === "song") {
        const chainId = env.model.song[row][col];
        if (chainId < 0) return fail(command, "EMPTY · TAP EDIT VALUE OR S TO INSERT", "amber");
        if (!Object.hasOwn(env.model.chains, chainId)) return fail(command, `CHAIN ${env.hex(chainId)} IS NOT CREATED`, "amber");
        const chainRow = firstPopulatedChainRow(chainId);
        const phraseId = env.chain(chainId, false)?.[chainRow]?.phrase ?? env.EMPTY;
        const next = {
          ...parent,
          view: "chain",
          activeWorkspace: "chain",
          focus: { pane: "chain", row: chainRow, col: 0 },
          songRow: row,
          track: col,
          chain: chainId,
          lastChain: chainId,
          chainRow,
          phrase: phraseId >= 0 ? phraseId : parent.phrase,
          lastPhrase: phraseId >= 0 ? phraseId : parent.lastPhrase,
        };
        return enterHierarchy(command, before, parent, next, `OPEN CHAIN ${env.hex(chainId)}`);
      }

      if (pane === "chain") {
        const entry = env.chain(env.state.chain, false)?.[row];
        if (!entry || entry.phrase < 0) return fail(command, "EMPTY · TAP EDIT VALUE OR S TO INSERT", "amber");
        if (!Object.hasOwn(env.model.phrases, entry.phrase)) return fail(command, `PHRASE ${env.hex(entry.phrase)} IS NOT CREATED`, "amber");
        const next = {
          ...parent,
          view: "phrase",
          activeWorkspace: "phrase",
          focus: { pane: "phrase", row: 0, col: 0 },
          chainRow: row,
          phrase: entry.phrase,
          lastPhrase: entry.phrase,
          phraseRow: 0,
        };
        return enterHierarchy(command, before, parent, next, `OPEN PHRASE ${env.hex(entry.phrase)}`);
      }

      if (pane === "phrase") {
        const step = env.phrase(env.state.phrase, false)?.[row];
        const fallback = !step || step.instrument < 0;
        const instrumentId = fallback ? env.state.instrument : step.instrument;
        const next = {
          ...parent,
          view: "sound",
          dock: "sound",
          activeWorkspace: "sound",
          phraseRow: row,
          instrument: env.clamp(instrumentId, 0, 255),
        };
        return enterHierarchy(
          command,
          before,
          parent,
          next,
          `SOUND INST ${env.hex(next.instrument)}${fallback ? " · CURRENT FALLBACK" : ""}`,
          true,
        );
      }

      return fail(command, "NO CHILD WORKSPACE", "muted");
    }

    function returnHierarchy(command) {
      const before = snapshot();
      if (runtime.activeWorkspace === "mix") {
        const mutation = navigationStore.returnFromMix({
          source: command.source ?? "hierarchy.return.mix",
          target: "navigation.mix.return",
        });
        if (!mutation.mutated) return fail(command, "NO MIX RETURN TARGET", "muted");
        renderMixMutation(mutation, "RETURN FROM MIX");
        return commit({ ...command, target: "navigation.mix.return" }, before, mutation.before, mutation.after, mutation);
      }

      const mutation = navigationStore.returnToParent({
        source: command.source ?? "hierarchy.return",
        target: "navigation.hierarchy.return",
      });
      if (mutation.mutated) {
        renderHierarchyMutation(mutation, "RETURN");
        return commit({ ...command, target: "navigation.hierarchy.return" }, before, mutation.before, mutation.after, mutation);
      }

      const current = captureContext();
      if (env.state.focus.pane === "phrase") {
        const fallback = restoreHierarchyContext({
          ...current,
          view: "chain",
          activeWorkspace: "chain",
          focus: { pane: "chain", row: env.state.chainRow, col: 0 },
        }, "RETURN", {
          source: command.source ?? "hierarchy.return.fallback",
          target: "navigation.hierarchy.return",
        });
        if (!fallback) return fail(command, "TOP LEVEL", "muted");
        return commit({ ...command, target: "navigation.hierarchy.return" }, before, fallback.before, fallback.after, fallback);
      }
      if (env.state.focus.pane === "chain") {
        const fallback = restoreHierarchyContext({
          ...current,
          view: "song",
          activeWorkspace: "song",
          focus: { pane: "song", row: env.state.songRow, col: env.state.track },
        }, "RETURN", {
          source: command.source ?? "hierarchy.return.fallback",
          target: "navigation.hierarchy.return",
        });
        if (!fallback) return fail(command, "TOP LEVEL", "muted");
        return commit({ ...command, target: "navigation.hierarchy.return" }, before, fallback.before, fallback.after, fallback);
      }
      return fail(command, "TOP LEVEL", "muted");
    }

    function openMix(command) {
      if (runtime.activeWorkspace === "mix") return fail(command, "MIX ALREADY OPEN", "muted");
      const before = snapshot();
      const mutation = navigationStore.openMix({
        source: command.source ?? "workspace.openMix",
        target: "navigation.mix.open",
      });
      if (!mutation.mutated) return fail(command, "MIX ALREADY OPEN", "muted");
      renderMixMutation(mutation, `MIX · T${env.state.track + 1}`);
      return commit({ ...command, target: "navigation.mix.open" }, before, mutation.before, mutation.after, mutation);
    }

    // UX0-03 (#373). Reusable identity is the feature; this is the way to say
    // "this occurrence only". It copies the object and moves the cursor's own
    // reference onto the copy, leaving every other occurrence on the original.
    // The domain refuses in place and says why; nothing here invents a reason.
    function duplicateAndRepoint(command) {
      const structure = projectStore?.structure;
      if (!structure?.duplicateAndRepoint) return fail(command, "STRUCTURE DOMAIN UNAVAILABLE", "danger");

      const cursor = fieldCursor(command);
      const kind = cursor.pane === "song" ? "chain" : cursor.pane === "chain" ? "phrase" : null;
      if (!kind) return fail(command, "SELECT A SONG OR CHAIN CELL FIRST");
      // In a Chain the Phrase reference is column 0; the transpose beside it is
      // not a reference and has nothing to duplicate.
      if (kind === "phrase" && cursor.col !== 0) return fail(command, "SELECT THE PHRASE COLUMN FIRST");

      // Whether this occurrence is worth separating is this command's rule,
      // not a surface's. Both the phone action and Ctrl/Cmd+Shift+D reach
      // here, and a copy of an object nothing else points at would burn an
      // identity and leave the original unreferenced.
      const graph = globalThis.BRKTRKStructuralReferenceGraph;
      const sourceId = kind === "chain"
        ? structure.readSongCell(cursor.row, cursor.col)
        : structure.readChainCell(env.state.chain, cursor.row, 0).value;
      if (graph?.referenceCount && Number.isInteger(sourceId) && sourceId >= 0
        && graph.referenceCount(env.model, kind, sourceId) <= 1) {
        return fail(command, `${kind.toUpperCase()} ${env.hex(sourceId)} IS NOT SHARED`, "muted");
      }

      const before = snapshot();
      const request = kind === "chain"
        ? { kind, songRow: cursor.row, track: cursor.col }
        : { kind, chainId: env.state.chain, chainRow: cursor.row };
      const result = structure.duplicateAndRepoint(request, { source: command.source ?? "structure.duplicateAndRepoint" });

      if (!result.mutated) {
        if (result.reason === "pool-full") return fail(command, `${kind.toUpperCase()} POOL FULL`);
        if (result.reason === "empty-occurrence") return fail(command, "NOTHING TO DUPLICATE HERE", "muted");
        return fail(command, `${kind.toUpperCase()} ${String(result.sourceId).toUpperCase()} IS MISSING`, "danger");
      }

      // The structural renderer redraws the repointed cell and the editors
      // linked to it from the published change set; no broad render here.
      env.setStatus(`${kind.toUpperCase()} ${env.hex(result.freshId)} \u00b7 THIS OCCURRENCE ONLY`);
      return commit(
        { ...command, target: `structure.${kind}.duplicate-repoint` },
        before,
        result.sourceId,
        result.freshId,
        // changeFor() reads projectChangeSet. Handing it the raw domain result
        // records a durable, playback-affecting structural edit as an `ui`
        // change with persistsProject and affectsPlayback both false, which is
        // what command history and the debug snapshot would then report.
        { ...result, projectChangeSet: result.changeSet },
      );
    }

    function fieldCursor(command = null) {
      const candidate = command?.cursor;
      if (!candidate || typeof candidate !== "object") return env.state.focus;
      const pane = storeTypes.STRUCTURAL_WORKSPACES.includes(candidate.pane)
        ? candidate.pane
        : env.state.focus.pane;
      const limits = env.focusLimits(pane);
      return {
        pane,
        row: env.clamp(Number(candidate.row) || 0, 0, limits.rows - 1),
        col: env.clamp(Number(candidate.col) || 0, 0, limits.cols - 1),
      };
    }

    function fieldDescriptor(cursor = env.state.focus) {
      return fields.resolve(cursor.pane, cursor.col);
    }

    function finishFieldMutation(command, mutation, beforeSnapshot) {
      if (!mutation?.descriptor) return fail(command, "FIELD IS NOT EDITABLE", "muted");
      if (mutation.allocationFailed) {
        const kind = mutation.referenceKind === "phrase" ? "PHRASE" : "CHAIN";
        return { ...mutation, ...fail(command, `${kind} POOL FULL`) };
      }
      if (mutation.openChild) return openChild({ ...command, type: "hierarchy.openChild", source: command.source ?? "field-insert" });
      if (mutation.preview && mutation.after >= 0) auditionProductionNote(mutation.after, env.state.instrument);
      let navigationMutation = null;
      if (mutation.mutated && mutation.descriptor.id === "phrase.instrument" && mutation.after >= 0) {
        const current = captureContext();
        navigationMutation = navigationStore.restoreContext({ ...current, instrument: mutation.after }, {
          source: command.source ?? "field.instrument-selection",
          subtype: "sound.instrument",
          target: "navigation.sound.instrument",
          path: ["instrument"],
          renderTargets: ["navigation.sound-selection", "navigation.context"],
        });
        if (navigationMutation.mutated) soundEditRenderer.renderSelection(navigationMutation, { focus: false });
      }
      if (mutation.mutated && !mutation.projectChangeSet && !mutation.navigationChangeSet) legacy.persist();
      if (mutation.mutated) soundEditRenderer.renderFieldCompletion(mutation, { cursor: fieldCursor(command), focus: true });
      if (navigationMutation) mutation.navigationMutation = navigationMutation;
      const display = fields.format(env, mutation.descriptor, mutation.after);
      env.setStatus(`${mutation.descriptor.id.toUpperCase()} · ${display}`);
      return commit({ ...command, target: mutation.descriptor.id }, beforeSnapshot, mutation.before, mutation.after, mutation);
    }

    function mutateField(command, operation) {
      const cursor = fieldCursor(command);
      const descriptor = fieldDescriptor(cursor);
      if (!descriptor) return fail(command, "FIELD IS NOT EDITABLE", "muted");
      const before = snapshot();
      return finishFieldMutation(command, operation(descriptor, cursor), before);
    }

    function insertField(command) {
      const cell = `${env.state.focus.pane}:${env.state.focus.row}:${env.state.focus.col}`;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const fresh = command.fresh ?? (runtime.lastInsertCell === cell && now - runtime.lastInsertAt < 320);
      runtime.lastInsertCell = cell;
      runtime.lastInsertAt = now;
      return mutateField(command, (descriptor, cursor) => fields.insert(env, descriptor, { fresh }, cursor));
    }

    function applyOccurrence(command, before, target, status) {
      const mutation = navigationStore.restoreContext(target, {
        source: command.source ?? "context.navigate",
        target: "navigation.occurrence",
        path: ["occurrenceContext"],
      });
      if (mutation.mutated) renderOccurrenceMutation(mutation, status);
      else {
        syncRuntime();
        env.setStatus(status);
      }
      return commit({ ...command, target: "navigation.occurrence" }, before, mutation.before, mutation.after, mutation);
    }

    function occurrenceNavigate(command) {
      if (!types.isStructuralWorkspace(runtime.activeWorkspace)) return fail(command, "CONTEXT NAVIGATION UNAVAILABLE");
      const before = snapshot();
      const current = captureContext();
      const direction = command.direction;
      const delta = direction === "ArrowRight" || direction === "ArrowDown" ? 1 : -1;
      const pane = current.focus.pane;

      if (direction === "ArrowLeft" || direction === "ArrowRight") {
        const track = env.clamp(current.track + delta, 0, env.TRACKS - 1);
        const target = {
          ...current,
          track,
          focus: pane === "song" ? { ...current.focus, col: track } : current.focus,
        };
        const chainId = env.model.song[current.songRow]?.[track] ?? env.EMPTY;
        if (chainId >= 0 && Object.hasOwn(env.model.chains, chainId)) {
          target.chain = chainId;
          target.lastChain = chainId;
          target.chainRow = firstPopulatedChainRow(chainId);
          const phraseId = env.chain(chainId, false)?.[target.chainRow]?.phrase ?? env.EMPTY;
          if (phraseId >= 0 && Object.hasOwn(env.model.phrases, phraseId)) {
            target.phrase = phraseId;
            target.lastPhrase = phraseId;
          }
        }
        return applyOccurrence(command, before, target, `TRACK ${track + 1}`);
      }

      if (pane === "song") {
        const row = env.clamp(current.focus.row + 16 * delta, 0, env.model.song.length - 1);
        const target = contextForCursor({ pane: "song", row, col: current.focus.col });
        return applyOccurrence(command, before, target, `SONG PAGE · ROW ${env.hex(row)}`);
      }

      if (pane === "chain") {
        const occurrences = [];
        env.model.song.forEach((songRow, rowIndex) => songRow.forEach((chainId, track) => {
          if (chainId >= 0) occurrences.push({ songRow: rowIndex, track, chainId });
        }));
        if (!occurrences.length) return fail(command, "NO CHAIN OCCURRENCES", "muted");
        let index = occurrences.findIndex((item) => item.songRow === current.songRow && item.track === current.track && item.chainId === current.chain);
        if (index < 0) index = occurrences.findIndex((item) => item.chainId === current.chain);
        index = env.clamp((index < 0 ? 0 : index) + delta, 0, occurrences.length - 1);
        const occurrence = occurrences[index];
        const chainRow = firstPopulatedChainRow(occurrence.chainId);
        const target = {
          ...current,
          songRow: occurrence.songRow,
          track: occurrence.track,
          chain: occurrence.chainId,
          lastChain: occurrence.chainId,
          chainRow,
          focus: { pane: "chain", row: chainRow, col: current.focus.col },
        };
        const phraseId = env.chain(occurrence.chainId, false)?.[chainRow]?.phrase ?? env.EMPTY;
        if (phraseId >= 0 && Object.hasOwn(env.model.phrases, phraseId)) {
          target.phrase = phraseId;
          target.lastPhrase = phraseId;
        }
        return applyOccurrence(
          command,
          before,
          target,
          `CHAIN OCCURRENCE · SONG ${env.hex(occurrence.songRow)} · T${occurrence.track + 1}`,
        );
      }

      const source = env.chain(current.chain, false) ?? [];
      const rows = source.map((entry, row) => ({ row, phrase: entry.phrase })).filter((item) => item.phrase >= 0);
      if (!rows.length) return fail(command, "NO PHRASE OCCURRENCES", "muted");
      let index = rows.findIndex((item) => item.row === current.chainRow && item.phrase === current.phrase);
      if (index < 0) index = rows.findIndex((item) => item.phrase === current.phrase);
      index = env.clamp((index < 0 ? 0 : index) + delta, 0, rows.length - 1);
      const occurrence = rows[index];
      const target = {
        ...current,
        chainRow: occurrence.row,
        phrase: occurrence.phrase,
        lastPhrase: occurrence.phrase,
        focus: { pane: "phrase", row: current.phraseRow, col: current.focus.col },
      };
      return applyOccurrence(command, before, target, `PHRASE OCCURRENCE · CHAIN ROW ${env.hex(occurrence.row)}`);
    }

    function workspaceTargetContext(workspace) {
      const current = captureContext();
      if (workspace === "sound") {
        return { ...current, view: "sound", activeWorkspace: "sound", dock: "sound" };
      }
      if (!types.isStructuralWorkspace(workspace)) return current;
      const limits = env.focusLimits(workspace);
      const cursor = {
        pane: workspace,
        row: env.clamp(current.focus.row, 0, limits.rows - 1),
        col: env.clamp(current.focus.col, 0, limits.cols - 1),
      };
      return {
        ...contextForCursor(cursor),
        view: workspace,
        activeWorkspace: workspace,
        focus: cursor,
      };
    }

    function existingContextTarget(kind, id) {
      const current = captureContext();
      if (kind === "chain") {
        const source = env.chain(id, false);
        if (!source) return null;
        const row = env.clamp(current.chainRow, 0, Math.max(0, source.length - 1));
        const target = {
          ...current,
          view: "chain",
          activeWorkspace: "chain",
          chain: id,
          lastChain: id,
          chainRow: row,
          focus: { pane: "chain", row, col: 0 },
        };
        const phraseId = source[row]?.phrase ?? env.EMPTY;
        if (phraseId >= 0 && Object.hasOwn(env.model.phrases, phraseId)) {
          target.phrase = phraseId;
          target.lastPhrase = phraseId;
        }
        return target;
      }
      if (kind === "phrase") {
        const source = env.phrase(id, false);
        if (!source) return null;
        const row = env.clamp(current.phraseRow, 0, Math.max(0, source.length - 1));
        return {
          ...current,
          view: "phrase",
          activeWorkspace: "phrase",
          phrase: id,
          lastPhrase: id,
          phraseRow: row,
          focus: { pane: "phrase", row, col: 0 },
        };
      }
      return null;
    }

    function openExistingContext(command) {
      const kind = String(command.kind ?? "").toLowerCase();
      if (!["chain", "phrase"].includes(kind)) return fail(command, "UNKNOWN CONTEXT TYPE", "danger");
      const id = env.clamp(Math.round(Number(command.id) || 0), 0, 255);
      const target = existingContextTarget(kind, id);
      if (!target) return fail(command, `${kind.toUpperCase()} ${env.hex(id)} NOT CREATED`, "amber");
      const before = snapshot();
      const mutation = navigationStore.restoreContext(target, {
        source: command.source ?? "context.openExisting",
        subtype: "context.existing",
        target: `navigation.context.${kind}`,
        path: ["poolBrowsing", kind],
        renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"],
      });
      if (mutation.mutated) {
        renderWorkspaceMutation(mutation, `${kind.toUpperCase()} ${env.hex(id)} · OPEN`);
        root.BRKTRKPlaybackContext?.syncAutoScope?.();
      } else {
        closeTransientUi("context-existing-noop");
        syncRuntime();
      }
      return commit({ ...command, id, target: `navigation.context.${kind}` }, before, mutation.before, mutation.after, mutation);
    }

    function requireTrackMix(command) {
      const mixer = root.BRKTRKTrackMixer;
      const domain = root.BRKTRKTrackMix;
      if (!mixer?.applyMix || !domain?.get) {
        env.setStatus("TRACK MIX INITIALIZING", "amber");
        return null;
      }
      return { mixer, domain };
    }

    function setMixTrack(command) {
      const owners = requireTrackMix(command);
      if (!owners) return fail(command, "TRACK MIX INITIALIZING", "amber");
      const before = snapshot();
      const current = navigationStore.captureContext();
      const requested = Number.isInteger(command.index)
        ? env.clamp(command.index, 0, env.TRACKS - 1)
        : env.clamp(current.track + (command.direction === "ArrowRight" ? 1 : -1), 0, env.TRACKS - 1);
      const mutation = navigationStore.restoreContext({ ...current, track: requested }, {
        source: command.source ?? "mix.selectTrack",
        subtype: "track.select",
        target: "navigation.track",
        path: ["track"],
        renderTargets: ["navigation.track-selection"],
      });
      owners.mixer.updateTrackSelection?.(mutation.after.track);
      root.BRKTRKCommandBindings?.focusUtility?.();
      env.setStatus(`MIX TRACK ${mutation.after.track + 1}`);
      return commit({ ...command, target: "navigation.track" }, before, mutation.before, mutation.after, mutation);
    }

    function gainFromCommand(command, current) {
      const currentPercent = Math.round(current * 100);
      if (Number.isFinite(command.value)) {
        const raw = Number(command.value);
        const percent = command.displayUnits || Math.abs(raw) > 1 ? raw : raw * 100;
        return env.clamp(Math.round(percent), 0, 100) / 100;
      }
      const edit = fields.intent(command.direction);
      if (!edit) return current;
      const step = edit.magnitude === "coarse" ? 10 : 1;
      return env.clamp(currentPercent + edit.delta * step, 0, 100) / 100;
    }

    function updateGainControl(track, gain) {
      const channel = root.document.querySelector(`#mixer .track-bus-channel[data-track="${track}"]`);
      const input = channel?.querySelector(".track-gain-range");
      const output = channel?.querySelector(".track-gain-control output");
      const percent = Math.round(gain * 100);
      if (input) input.value = String(percent);
      if (output) output.textContent = `${percent}%`;
    }

    function setMixGain(command) {
      const owners = requireTrackMix(command);
      if (!owners) return fail(command, "TRACK MIX INITIALIZING", "amber");
      const before = snapshot();
      const track = navigationStore.captureContext().track;
      const oldValue = owners.domain.get(track).gain;
      const next = gainFromCommand(command, oldValue);
      const result = owners.mixer.applyMix(
        track,
        { gain: next },
        "gain",
        command.source ?? command.type,
      );
      updateGainControl(track, result.after.gain);
      owners.mixer.renderMixStatus?.(track);
      env.setStatus(`MIX T${track + 1} · GAIN ${Math.round(result.after.gain * 100)}%`);
      return commit(
        { ...command, target: `project.tracks.${track}.mix` },
        before,
        oldValue,
        result.after.gain,
        { ...result, projectChangeSet: result.changeSet },
      );
    }

    function toggleMixMute(command) {
      const owners = requireTrackMix(command);
      if (!owners) return fail(command, "TRACK MIX INITIALIZING", "amber");
      const before = snapshot();
      const track = navigationStore.captureContext().track;
      const oldValue = owners.domain.get(track).mute;
      const result = owners.mixer.applyMix(
        track,
        { mute: !oldValue },
        "mute",
        command.source ?? command.type,
      );
      const mute = root.document.querySelector(`#mixer .track-bus-channel[data-track="${track}"] .track-mute-control`);
      if (mute) owners.mixer.updateMuteControl?.(mute, result.after.mute);
      owners.mixer.renderMixStatus?.(track);
      env.setStatus(`MIX T${track + 1} · MUTE ${result.after.mute ? "ON" : "OFF"}`);
      return commit(
        { ...command, target: `project.tracks.${track}.mix` },
        before,
        oldValue,
        result.after.mute,
        { ...result, projectChangeSet: result.changeSet },
      );
    }

    function applySoundSelection(command, target, message, options = {}) {
      const mutation = navigationStore.restoreContext(target, {
        source: command.source ?? command.type,
        subtype: options.subtype ?? "sound.selection",
        target: options.target ?? "navigation.sound.selection",
        path: options.path ?? ["soundSelection"],
        renderTargets: ["navigation.sound-selection", "navigation.context"],
      });
      if (mutation.mutated) {
        soundEditRenderer.renderSelection(mutation, { focus: options.focus !== false });
        syncRuntime();
      } else if (options.focus !== false) root.BRKTRKCommandBindings?.focusUtility?.();
      if (message) env.setStatus(message);
      return mutation;
    }

    function soundParameterCount(instrumentId = captureContext().instrument) {
      return Math.max(0, Number(soundEditRenderer.parameterCount?.(instrumentId)) || 0);
    }

    function selectSoundParameter(command) {
      const before = snapshot();
      const current = captureContext();
      const count = soundParameterCount(current.instrument);
      if (count <= 0) return fail(command, "NO PRODUCTION PARAMETERS", "muted");
      const oldValue = env.clamp(current.soundParam, 0, count - 1);
      const requested = Number.isInteger(command.index)
        ? env.clamp(command.index, 0, count - 1)
        : env.clamp(oldValue + (command.direction === "ArrowRight" ? 1 : -1), 0, count - 1);
      const context = soundEditRenderer.selectedParameterContext?.(current.instrument, requested);
      const label = context?.parameter?.name ?? context?.parameter?.label ?? context?.parameterId ?? `PARAM ${requested + 1}`;
      const mutation = applySoundSelection(command, { ...current, soundParam: requested }, `SOUND · ${label}`, {
        subtype: "sound.parameter",
        target: "navigation.sound.parameter",
        path: ["soundParam"],
      });
      return commit({ ...command, target: "navigation.sound.parameter" }, before, oldValue, mutation.after.soundParam, mutation);
    }

    function selectSoundInstrument(command) {
      const before = snapshot();
      const current = captureContext();
      const oldValue = current.instrument;
      const requested = Number.isInteger(command.index)
        ? env.clamp(command.index, 0, 255)
        : env.clamp(oldValue + (command.direction === "ArrowRight" ? 1 : -1), 0, 255);
      const mutation = applySoundSelection(command, { ...current, instrument: requested, soundParam: 0 }, `SOUND INST ${env.hex(requested)}`, {
        subtype: "sound.instrument",
        target: "navigation.sound.instrument",
        path: ["instrument"],
      });
      return commit({ ...command, target: "navigation.sound.instrument" }, before, oldValue, mutation.after.instrument, mutation);
    }

    function setSoundParam(command) {
      const before = snapshot();
      let selectionMutation = null;
      if (Number.isInteger(command.index)) {
        const current = captureContext();
        const count = soundParameterCount(current.instrument);
        if (count <= 0) return fail(command, "NO PRODUCTION PARAMETERS", "muted");
        const requested = env.clamp(command.index, 0, count - 1);
        selectionMutation = applySoundSelection(command, { ...current, soundParam: requested }, null, {
          subtype: "sound.parameter",
          target: "navigation.sound.parameter",
          path: ["soundParam"],
          focus: false,
        });
      }
      const current = captureContext();
      const context = soundEditRenderer.selectedParameterContext?.(current.instrument, current.soundParam);
      if (!context) return fail(command, "PRODUCTION PARAMETER UNAVAILABLE", "amber");
      const descriptor = fields.specialDescriptors.soundParam;
      const oldValue = fields.read(env, descriptor);
      let next = command.value;
      if (!Number.isFinite(next)) {
        const edit = fields.intent(command.direction);
        if (!edit) return fail(command, "INVALID SOUND EDIT", "danger");
        const step = soundEditRenderer.parameterStep?.(context, edit.magnitude)
          ?? (edit.magnitude === "coarse" ? descriptor.coarseStep : descriptor.fineStep);
        next = oldValue + edit.delta * step;
      }
      const mutation = fields.write(env, descriptor, next, {
        source: command.source ?? command.type,
        transient: command.transient === true,
      });
      if (!command.transient) root.BRKTRKCommandBindings?.focusUtility?.();
      const display = soundEditRenderer.displayValue?.(context.parameter, mutation.after, {}) ?? `${Math.round(Number(mutation.after) * 100)}%`;
      env.setStatus(`SOUND · ${context.parameterId} · ${display}`);
      const result = mutation.mutated ? mutation : selectionMutation?.mutated ? selectionMutation : mutation;
      return commit({ ...command, target: `project.instrumentPool.${context.instrumentId}.parameterSnapshot.${context.parameterId}` }, before, mutation.before, mutation.after, result);
    }

    function writeNote(command) {
      if (env.state.focus.pane !== "phrase" || env.state.focus.col !== 0) return fail(command, "SELECT A NOTE CELL FIRST");
      const descriptor = fields.resolve("phrase", 0);
      const before = snapshot();
      const transaction = command.transaction?.kind === "prepared-note-entry" ? command.transaction : null;
      let mutation;
      let auditionInstrument = env.state.instrument;
      let auditionVelocity = null;

      if (transaction) {
        const targetStep = env.phrase(transaction.phrase, false)?.[transaction.row];
        if (!targetStep) return fail(command, "PREPARED NOTE TARGET IS MISSING", "danger");
        const domainMutation = projectStore.phraseSteps.writeStep(
          transaction.phrase,
          transaction.row,
          transaction.after,
          { source: command.source ?? "note.write", transaction },
        );
        mutation = { ...domainMutation, projectChangeSet: domainMutation.changeSet };
        if (domainMutation.after.instrument >= 0) {
          env.state.instrument = domainMutation.after.instrument;
          auditionInstrument = domainMutation.after.instrument;
        }
        auditionVelocity = domainMutation.after.velocity;
        if (domainMutation.after.note >= 0) entryState.setPreparedValue("octave", Math.floor(domainMutation.after.note / 12) - 1, { source: command.source ?? "note.write" });
      } else {
        mutation = fields.write(env, descriptor, Number(command.value), { source: command.source ?? "note.write" });
      }

      const writtenNote = transaction ? mutation.after.note : mutation.after;
      if (command.preview && writtenNote >= 0) auditionProductionNote(writtenNote, auditionInstrument, auditionVelocity);
      env.setStatus(writtenNote === env.NOTE_OFF ? "NOTE OFF" : writtenNote === env.EMPTY ? "NOTE EMPTY" : `NOTE ${env.noteName(writtenNote)}`);
      return commit({ ...command, target: transaction?.target ?? descriptor.id }, before, mutation.before, mutation.after, mutation);
    }

    async function dispatch(command) {
      if (!command?.type) return fail({ type: "invalid" }, "INVALID COMMAND", "danger");
      switch (command.type) {
        case "cursor.select": return selectCursor(command);
        case "cursor.move": return moveCursor(command);
        case "field.adjust": return mutateField(command, (descriptor, cursor) => fields.adjust(env, descriptor, command.direction, cursor));
        case "field.insert": return insertField(command);
        case "field.clear": return mutateField(command, (descriptor, cursor) => fields.clear(env, descriptor, cursor));
        case "field.reset": return mutateField(command, (descriptor, cursor) => fields.reset(env, descriptor, cursor));
        case "field.setExact": {
          const cursor = fieldCursor(command);
          const descriptor = fieldDescriptor(cursor);
          if (!descriptor) return fail(command, "FIELD IS NOT EDITABLE", "muted");
          const value = Number.isFinite(command.value) ? Number(command.value) : fields.parse(descriptor, command.raw);
          if (!Number.isFinite(value)) return fail(command, "INVALID VALUE", "danger");
          const before = snapshot();
          return finishFieldMutation(command, fields.write(env, descriptor, value, {
            createMissing: Boolean(command.createMissing),
            source: command.source ?? "field.setExact",
          }, cursor), before);
        }
        case "structure.duplicateAndRepoint": return duplicateAndRepoint(command);
        case "context.navigate": return occurrenceNavigate(command);
        case "context.openExisting": return openExistingContext(command);
        case "hierarchy.openChild": return openChild(command);
        case "hierarchy.return": return returnHierarchy(command);
        case "workspace.openMix": return openMix(command);
        case "workspace.select": {
          const workspace = types.normalizeWorkspace(command.workspace, runtime.activeWorkspace);
          if (workspace === "mix") return openMix({ ...command, type: "workspace.openMix" });
          const before = snapshot();
          const target = workspaceTargetContext(workspace);
          const mutation = navigationStore.restoreContext(target, {
            source: command.source ?? "workspace.select",
            subtype: "workspace",
            target: "navigation.workspace",
            path: ["activeWorkspace"],
            renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"],
          });
          if (mutation.mutated) renderWorkspaceMutation(mutation, `WORKSPACE ${workspace.toUpperCase()}`);
          else {
            closeTransientUi("workspace-context-noop");
            syncRuntime();
            // UX0-08 (#374): openMix has always said MIX ALREADY OPEN for this
            // gesture. Every other workspace said nothing at all.
            env.setStatus(`WORKSPACE ${workspace.toUpperCase()} ALREADY OPEN`, "muted");
          }
          return commit({ ...command, target: "navigation.workspace" }, before, mutation.before, mutation.after, mutation);
        }
        case "mix.selectTrack": return setMixTrack(command);
        case "mix.adjustGain":
        case "mix.setGain":
        case "mix.adjustVolume":
        case "mix.setVolume": return setMixGain(command);
        case "mix.toggleMute": return toggleMixMute(command);
        case "sound.selectParam": return selectSoundParameter(command);
        case "sound.selectInstrument": return selectSoundInstrument(command);
        case "sound.adjustParam":
        case "sound.setParam": return setSoundParam(command);
        case "note.write": return writeNote(command);
        case "note.velocity": {
          if (env.state.focus.pane !== "phrase") return fail(command, "SELECT A PHRASE ROW FIRST");
          const descriptor = fields.resolve("phrase", 1);
          const before = snapshot();
          const current = fields.read(env, descriptor);
          const mutation = fields.write(
            env,
            descriptor,
            Number.isFinite(command.value) ? Number(command.value) : current + Number(command.delta || 0),
            { source: command.source ?? "note.velocity" },
          );
          return commit({ ...command, target: descriptor.id }, before, mutation.before, mutation.after, mutation);
        }
        case "note.octave": {
          const before = snapshot();
          const oldValue = entryState.getPreparedEntry().octave;
          const mutation = entryState.setPreparedValue(
            "octave",
            env.clamp(oldValue + Number(command.delta || 0), -1, 9),
            { source: command.source ?? "note.octave" },
          );
          return commit({ ...command, target: "navigation.preparedEntry" }, before, mutation.before, mutation.after, mutation);
        }
        case "note.editStep": {
          const before = snapshot();
          const steps = [0, 1, 2, 4];
          const oldValue = entryState.getPreparedEntry().editStep;
          const mutation = entryState.setPreparedValue(
            "editStep",
            steps[(steps.indexOf(oldValue) + 1) % steps.length],
            { source: command.source ?? "note.editStep" },
          );
          return commit({ ...command, target: "navigation.preparedEntry" }, before, mutation.before, mutation.after, mutation);
        }
        case "tempo.set": {
          const descriptor = fields.specialDescriptors.tempo;
          const before = snapshot();
          const value = Number(command.value);
          if (!Number.isFinite(value)) return fail(command, "INVALID BPM", "danger");
          const mutation = fields.write(env, descriptor, value, { source: command.source ?? "tempo.set" });
          return commit({ ...command, target: descriptor.id }, before, mutation.before, mutation.after, mutation);
        }
        case "scope.set": {
          // UX0-08 (#374): an unrecognised scope used to fall through this
          // branch, change nothing and still commit, so the command looked
          // like it had worked. It now refuses the way an unknown dock does.
          if (!["song", "chain", "phrase"].includes(command.scope)) {
            return fail(command, `UNKNOWN SCOPE · ${String(command.scope ?? "").toUpperCase() || "NONE"}`, "danger");
          }
          const before = snapshot();
          const oldValue = env.state.scope;
          env.state.scope = command.scope;
          legacy.renderTransport();
          return commit(command, before, oldValue, env.state.scope);
        }
        case "transport.toggle": {
          const before = snapshot();
          const oldValue = env.state.playing;
          await legacy.togglePlayback(Boolean(command.forceSong)); legacy.renderTransport();
          return commit(command, before, oldValue, env.state.playing);
        }
        case "transport.stop": {
          const before = snapshot();
          const oldValue = env.state.playing;
          legacy.stopPlayback(); legacy.renderTransport();
          return commit(command, before, oldValue, env.state.playing);
        }
        case "project.rename": {
          const name = String(command.value ?? "").trim();
          if (!name) return fail(command, "PROJECT NAME UNCHANGED", "muted");
          const descriptor = fields.specialDescriptors.projectName;
          const before = snapshot();
          const mutation = fields.write(env, descriptor, name, { source: command.source ?? "project.rename" });
          return commit({ ...command, target: descriptor.id }, before, mutation.before, mutation.after, mutation);
        }
        case "dock.toggle": {
          const dock = String(command.dock ?? "").toLowerCase();
          if (!["sound", "mix"].includes(dock)) return fail(command, "UNKNOWN PANEL", "danger");
          const before = snapshot();
          let current = captureContext();
          const closing = current.dock === dock;

          // Top-bar panels participate in the same return contracts as keyboard
          // navigation. Switching panels first returns to the retained tracker
          // context so MIX never returns to SOUND (or vice versa).
          if (closing) {
            const mutation = dock === "mix"
              ? navigationStore.returnFromMix({
                source: command.source ?? "dock.toggle.closeMix",
                target: "navigation.mix.return",
              })
              : navigationStore.returnToParent({
                source: command.source ?? "dock.toggle.closeSound",
                target: "navigation.hierarchy.return",
              });
            if (!mutation.mutated) return fail(command, "NO PANEL RETURN TARGET", "muted");
            renderWorkspaceMutation(mutation, "PANEL CLOSED");
            return commit({ ...command, target: "navigation.dock" }, before, mutation.before, mutation.after, mutation);
          }

          if (current.dock === "mix") {
            const returned = navigationStore.returnFromMix({
              source: command.source ?? "dock.toggle.switchFromMix",
              target: "navigation.mix.return",
            });
            if (!returned.mutated) return fail(command, "NO MIX RETURN TARGET", "muted");
            current = captureContext();
          } else if (current.dock === "sound") {
            const returned = navigationStore.returnToParent({
              source: command.source ?? "dock.toggle.switchFromSound",
              target: "navigation.hierarchy.return",
            });
            if (!returned.mutated) return fail(command, "NO INSTRUMENT RETURN TARGET", "muted");
            current = captureContext();
          }

          const mutation = dock === "mix"
            ? navigationStore.openMix({
              source: command.source ?? "dock.toggle.openMix",
              target: "navigation.mix.open",
              returnContext: current,
            })
            : navigationStore.enterContext({
              ...current,
              dock: "sound",
              view: "sound",
              activeWorkspace: "sound",
            }, {
              source: command.source ?? "dock.toggle.openSound",
              target: "navigation.hierarchy.enter",
              parent: current,
            });
          renderWorkspaceMutation(mutation, dock === "sound" ? "INSTRUMENT" : "MIXER");
          return commit({ ...command, target: "navigation.dock" }, before, mutation.before, mutation.after, mutation);
        }
        case "dock.select": {
          const dock = String(command.dock ?? "").toLowerCase();
          if (!["sound", "mod", "fx", "mix"].includes(dock)) return fail(command, "UNKNOWN DOCK", "danger");
          if (command.activateWorkspace && dock === "mix") return openMix({ ...command, type: "workspace.openMix" });
          const before = snapshot();
          const current = captureContext();
          const target = {
            ...current,
            dock,
            ...(command.activateWorkspace && dock === "sound" ? { view: "sound", activeWorkspace: "sound" } : {}),
          };
          const mutation = navigationStore.restoreContext(target, {
            source: command.source ?? "dock.select",
            subtype: "dock",
            target: "navigation.dock",
            path: ["selection", "dock"],
            renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"],
          });
          if (mutation.mutated) renderWorkspaceMutation(mutation, `DOCK ${dock.toUpperCase()}`);
          else {
            closeTransientUi("dock-context-noop");
            syncRuntime();
            env.setStatus(`DOCK ${dock.toUpperCase()} ALREADY OPEN`, "muted");
          }
          return commit({ ...command, target: "navigation.dock" }, before, mutation.before, mutation.after, mutation);
        }
        case "invalid": return fail(command, command.message ?? "COMMAND NOT AVAILABLE", "muted");
        default: return fail(command, `UNKNOWN COMMAND · ${command.type}`, "danger");
      }
    }

    function markModifierUsed() {
      for (const code of ["KeyA", "KeyS", "KeyZ"]) {
        if (env.heldKeys.has(code) && runtime.modifierPresses.has(code)) runtime.modifierPresses.get(code).used = true;
      }
    }

    function keyDown(code, repeat = false) {
      if (["KeyA", "KeyS", "KeyZ"].includes(code)) {
        if (!repeat) {
          env.heldKeys.add(code);
          runtime.modifierPresses.set(code, {
            used: false,
            optionAtPress: code === "KeyS" && env.heldKeys.has("KeyA"),
            pressedAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
          });
        }
        return null;
      }
      if (!repeat) env.heldKeys.add(code);
      if (code.startsWith("Arrow")) markModifierUsed();
      const command = resolveInputCommand({
        code, repeat, workspace: runtime.activeWorkspace,
        modifiers: {
          option: env.heldKeys.has("KeyA"), edit: env.heldKeys.has("KeyS"), shift: env.heldKeys.has("KeyZ"),
        },
      });
      if (command) return dispatch({ ...command, inputCode: code, repeat, source: "keyboard" });
      return null;
    }

    function keyUp(code) {
      const wasHeld = env.heldKeys.has(code);
      env.heldKeys.delete(code);
      const press = runtime.modifierPresses.get(code);
      runtime.modifierPresses.delete(code);
      if (!wasHeld || !press || press.used || code !== "KeyS") return null;
      const clear = press.optionAtPress || env.heldKeys.has("KeyA");
      return dispatch({ type: clear ? "field.clear" : "field.insert", source: "keyboard-tap" });
    }

    const api = {
      installed: true,
      runtime,
      history: runtime.history,
      dispatch,
      keyDown,
      keyUp,
      snapshot,
      captureContext,
      restoreContext,
      resolveInputCommand,
      subscribe(listener) { runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); },
      legacy,
      stores: root.BRKTRKStores,
    };
    root.BRKTRKCommands = api;
    root.keyDown = keyDown;
    root.keyUp = keyUp;
    root.setFocus = (pane, row, col, shouldFocus = true) => dispatch({ type: "cursor.select", pane, row, col, focus: shouldFocus, source: "compatibility-setFocus" });
    root.clearCurrentCell = () => dispatch({ type: "field.clear", source: "compatibility-clear" });
    root.insertCurrentCell = () => dispatch({ type: "field.insert", source: "compatibility-insert" });
    root.focusSelectedCell = legacy.focusSelectedCell;
    env.state.commands = runtime;
    syncRuntime();
    return api;
  }

  const exported = { resolveInputCommand, install };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (globalThis.document) {
    globalThis.BRKTRKCommands = install(globalThis, {
      state, model, EMPTY, NOTE_OFF, TRACKS, PHRASE_ROWS,
      hex, clamp, chain, phrase, currentValue, focusLimits, firstUnused, fxName,
      setStatus, audio, noteName, heldKeys,
      projectStore: globalThis.BRKTRKStores?.project, navigationStore: globalThis.BRKTRKStores?.navigation,
    });
  }
})();
