(() => {
  function shouldIgnoreKeyDown(code, repeat, heldKeys) {
    return Boolean(repeat && code?.startsWith("Arrow") && heldKeys?.has?.("KeyZ"));
  }

  function installContinuousGestureDurability(projectStore) {
    if (!projectStore?.publish || !projectStore?.emit || !projectStore?.getState) {
      throw new TypeError("continuous gesture durability requires ProjectStore publish/emit/state");
    }
    if (projectStore.__g1GestureDurabilityInstalled) return projectStore;

    const storeTypes = globalThis.BRKTRKStoreTypes
      ?? (typeof require === "function" ? require("./stores.js") : null);
    const sessionStore = globalThis.BRKTRKProjectFileSessionStore
      ?? (typeof require === "function" ? require("./project-file-session-store.js") : null);
    if (!storeTypes?.createProjectChangeSet) throw new Error("ProjectStore change-set types are required for gesture durability");

    const pending = new Map();
    const basePublish = projectStore.publish.bind(projectStore);
    let lastFinalize = null;

    function gestureId(value) {
      const id = value?.transaction?.gestureId ?? value?.gestureId ?? null;
      return typeof id === "string" && id ? id : null;
    }

    function samePath(left, right) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      return left.every((segment, index) => segment === right[index]);
    }

    function sameTarget(left, right) {
      return left?.target === right?.target
        && left?.subtype === right?.subtype
        && samePath(left?.path, right?.path);
    }

    function remember(changeSet) {
      const id = gestureId(changeSet);
      if (!id) return null;
      let record = pending.get(id);
      if (!record) {
        record = {
          gestureId: id,
          first: changeSet,
          last: changeSet,
          stableTarget: true,
          sampleCount: 0,
          affectsPlayback: false,
          structuralPlayback: false,
          renderTargets: new Set(),
        };
        pending.set(id, record);
      } else if (!sameTarget(record.first, changeSet)) {
        record.stableTarget = false;
      }
      record.last = changeSet;
      record.sampleCount += 1;
      record.affectsPlayback ||= changeSet.affectsPlayback === true;
      record.structuralPlayback ||= changeSet.structuralPlayback === true;
      for (const target of changeSet.renderTargets ?? []) record.renderTargets.add(target);
      return record;
    }

    function durableChangeSet(record, finalTransaction = {}) {
      const first = record.first;
      const last = record.last;
      const stableTarget = record.stableTarget === true;
      const transaction = {
        ...(last.transaction && typeof last.transaction === "object" ? last.transaction : {}),
        ...(finalTransaction && typeof finalTransaction === "object" ? finalTransaction : {}),
        gestureId: record.gestureId,
        transient: false,
        gestureDurable: true,
        gestureSampleCount: record.sampleCount,
        gestureStableTarget: stableTarget,
      };
      return storeTypes.createProjectChangeSet({
        kind: stableTarget ? last.kind : "project",
        subtype: stableTarget ? last.subtype : "gesture.commit",
        target: stableTarget ? last.target : "project.gesture.commit",
        path: stableTarget ? last.path : [],
        before: stableTarget ? first.before : null,
        after: stableTarget ? last.after : null,
        affectsPlayback: record.affectsPlayback,
        structuralPlayback: record.structuralPlayback || (!stableTarget && record.affectsPlayback),
        persistsProject: true,
        renderTargets: [...record.renderTargets],
        source: last.source,
        transaction,
      });
    }

    projectStore.publish = function publishWithContinuousDurability(changeSet, channels = []) {
      const requested = Array.isArray(channels) ? channels : [];
      const id = gestureId(changeSet);
      const durable = changeSet?.transaction?.gestureDurable === true;
      if (id && !durable && changeSet?.persistsProject === true && requested.includes("persistence")) {
        remember(changeSet);
        return basePublish(changeSet, requested.filter((channel) => channel !== "persistence"));
      }
      return basePublish(changeSet, requested);
    };

    function publishDurableCommitted(changeSet) {
      if (sessionStore?.publishCommitted) return sessionStore.publishCommitted(projectStore, changeSet, ["persistence"]);
      try {
        basePublish(changeSet, ["persistence"]);
        return Object.freeze([]);
      } catch (error) {
        console.error("BRKTRK continuous gesture post-commit notification failed", error);
        return Object.freeze([{ channel: "persistence", name: String(error?.name ?? "Error"), message: String(error?.message ?? error) }]);
      }
    }

    function finalizeContinuousGesture(transactionOrId) {
      const id = typeof transactionOrId === "string" ? transactionOrId : gestureId(transactionOrId);
      if (!id) return Object.freeze({ attempted: false, committed: false, reason: "missing-gesture-id", notificationErrors: Object.freeze([]) });
      const record = pending.get(id);
      if (!record) return Object.freeze({ attempted: false, committed: false, reason: "no-pending-gesture", gestureId: id, notificationErrors: Object.freeze([]) });
      const finalTransaction = transactionOrId && typeof transactionOrId === "object" ? transactionOrId : { gestureId: id };
      const changeSet = durableChangeSet(record, finalTransaction);

      // The desired Project value is already installed. Consume the pending
      // record before notifying durable subscribers so a post-commit listener
      // failure can never make the same gesture retry into duplicate history or
      // recovery. Notification failures are reported separately from commit.
      pending.delete(id);
      const notificationErrors = publishDurableCommitted(changeSet);
      lastFinalize = Object.freeze({
        gestureId: id,
        sampleCount: record.sampleCount,
        transaction: { ...changeSet.transaction },
        downstreamFailed: notificationErrors.length > 0,
        notificationErrors: Object.freeze(notificationErrors.map((item) => ({ ...item }))),
      });
      return Object.freeze({
        attempted: true,
        committed: true,
        downstreamFailed: notificationErrors.length > 0,
        gestureId: id,
        sampleCount: record.sampleCount,
        changeSet,
        notificationErrors,
      });
    }

    function finalizeAllContinuousGestures(finalTransaction = {}) {
      const results = [];
      const notificationErrors = [];
      for (const id of [...pending.keys()]) {
        const result = finalizeContinuousGesture({
          ...(finalTransaction && typeof finalTransaction === "object" ? finalTransaction : {}),
          gestureId: id,
        });
        results.push(result);
        notificationErrors.push(...(result.notificationErrors ?? []));
      }
      return Object.freeze({
        ok: notificationErrors.length === 0,
        attemptedCount: results.filter((item) => item.attempted).length,
        committedCount: results.filter((item) => item.committed).length,
        notificationErrors: Object.freeze(notificationErrors),
        results: Object.freeze(results),
      });
    }

    function durabilitySnapshot() {
      return Object.freeze({
        pendingCount: pending.size,
        pendingGestureIds: Object.freeze([...pending.keys()]),
        lastFinalize: lastFinalize ? {
          ...lastFinalize,
          transaction: { ...lastFinalize.transaction },
          notificationErrors: Object.freeze((lastFinalize.notificationErrors ?? []).map((item) => ({ ...item }))),
        } : null,
      });
    }

    Object.defineProperty(projectStore, "finalizeContinuousGesture", {
      value: finalizeContinuousGesture,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(projectStore, "finalizeAllContinuousGestures", {
      value: finalizeAllContinuousGestures,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(projectStore, "continuousGestureDurabilitySnapshot", {
      value: durabilitySnapshot,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(projectStore, "__g1GestureDurabilityInstalled", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    return projectStore;
  }

  function createContinuousGestureController() {
    let serial = 0;
    let current = null;
    let currentToken = 0;
    let lastLifecycle = null;
    const ranges = new WeakMap();
    const pendingRanges = new WeakMap();
    const rangeTargets = new Set();
    const pendingRangeTargets = new Set();
    const pointers = new Map();
    const keys = new Map();

    function createGesture(prefix, family, kind, metadata = {}) {
      return Object.freeze({
        gestureId: `${prefix}:${++serial}`,
        gestureFamily: family,
        gestureKind: kind,
        ...(metadata && typeof metadata === "object" ? metadata : {}),
      });
    }

    function phase(gesture, gesturePhase, gestureEndReason = null) {
      if (!gesture) return null;
      const transaction = Object.freeze({
        ...gesture,
        gesturePhase,
        ...(gestureEndReason ? { gestureEndReason } : {}),
      });
      lastLifecycle = transaction;
      return transaction;
    }

    function beginRange(target, family, pointerId = null) {
      if (!target || !family) return null;
      const gesture = createGesture(`${family}-range`, family, "pointer-range");
      ranges.set(target, { gesture, pointerId });
      rangeTargets.add(target);
      pendingRanges.delete(target);
      pendingRangeTargets.delete(target);
      return phase(gesture, "begin", "pointerdown");
    }

    function sampleRange(target, family) {
      if (!target || !family) return null;
      let record = ranges.get(target) ?? pendingRanges.get(target) ?? null;
      if (!record) {
        record = { gesture: createGesture(`${family}-range`, family, "native-range"), pointerId: null };
        ranges.set(target, record);
        rangeTargets.add(target);
      }
      return phase(record.gesture, "update", "input");
    }

    function endRangePointer(target, pointerId = null) {
      const record = target ? ranges.get(target) : null;
      if (!record || (record.pointerId != null && pointerId != null && record.pointerId !== pointerId)) return null;
      ranges.delete(target);
      rangeTargets.delete(target);
      pendingRanges.set(target, record);
      pendingRangeTargets.add(target);
      return phase(record.gesture, "end", "pointerup");
    }

    function changeRange(target, family) {
      if (!target || !family) return null;
      const record = ranges.get(target) ?? pendingRanges.get(target)
        ?? { gesture: createGesture(`${family}-range`, family, "native-range"), pointerId: null };
      ranges.delete(target);
      pendingRanges.delete(target);
      rangeTargets.delete(target);
      pendingRangeTargets.delete(target);
      return phase(record.gesture, "end", "change");
    }

    function cancelRange(target, pointerId = null) {
      const record = target ? ranges.get(target) ?? pendingRanges.get(target) : null;
      if (!record || (record.pointerId != null && pointerId != null && record.pointerId !== pointerId)) return null;
      ranges.delete(target);
      pendingRanges.delete(target);
      rangeTargets.delete(target);
      pendingRangeTargets.delete(target);
      return phase(record.gesture, "cancel", "pointercancel");
    }

    function blurRange(target) {
      const record = target ? ranges.get(target) ?? pendingRanges.get(target) : null;
      if (!record) return null;
      ranges.delete(target);
      pendingRanges.delete(target);
      rangeTargets.delete(target);
      pendingRangeTargets.delete(target);
      return phase(record.gesture, "end", "blur");
    }

    function beginPointer(pointerId, family, target = null) {
      if (pointerId == null || !family) return null;
      const gesture = createGesture(`${family}-drag`, family, "pointer-drag");
      pointers.set(pointerId, { gesture, target });
      return phase(gesture, "begin", "pointerdown");
    }

    function samplePointer(pointerId) {
      return phase(pointers.get(pointerId)?.gesture ?? null, "update", "pointermove");
    }

    function endPointer(pointerId, cancelled = false) {
      const record = pointers.get(pointerId) ?? null;
      if (!record) return null;
      pointers.delete(pointerId);
      return phase(record.gesture, cancelled ? "cancel" : "end", cancelled ? "pointercancel" : "pointerup");
    }

    function sampleKey(code, family, repeat = false) {
      if (!code || !family) return null;
      let record = keys.get(code) ?? null;
      if (!record || !repeat || record.family !== family) {
        record = {
          family,
          gesture: createGesture(`${family}-key`, family, "keyboard-repeat", { inputSource: "keyboard" }),
        };
        keys.set(code, record);
      }
      return phase(record.gesture, repeat ? "update" : "begin", repeat ? "repeat" : "keydown");
    }

    function endKey(code, reason = "keyup") {
      const record = keys.get(code) ?? null;
      if (!record) return null;
      keys.delete(code);
      return phase(record.gesture, "end", reason);
    }

    function clearKeys(reason = "blur") {
      const ended = [...keys.values()].map((record) => phase(record.gesture, "end", reason));
      keys.clear();
      return Object.freeze(ended);
    }

    function endAll(reason = "boundary") {
      const ended = [];
      const seen = new Set();
      const append = (gesture) => {
        if (!gesture?.gestureId || seen.has(gesture.gestureId)) return;
        seen.add(gesture.gestureId);
        ended.push(phase(gesture, "end", reason));
      };
      for (const target of [...rangeTargets]) {
        const record = ranges.get(target);
        append(record?.gesture);
        ranges.delete(target);
      }
      for (const target of [...pendingRangeTargets]) {
        const record = pendingRanges.get(target);
        append(record?.gesture);
        pendingRanges.delete(target);
      }
      rangeTargets.clear();
      pendingRangeTargets.clear();
      for (const record of pointers.values()) append(record.gesture);
      pointers.clear();
      for (const record of keys.values()) append(record.gesture);
      keys.clear();
      current = null;
      currentToken += 1;
      return Object.freeze(ended);
    }

    function currentContinuousTransaction(family = null) {
      if (!current) return null;
      if (family && current.gestureFamily !== family) return null;
      return current;
    }

    function withContinuousTransaction(transaction, callback) {
      if (typeof callback !== "function") throw new TypeError("continuous gesture callback must be a function");
      const before = current;
      current = transaction ?? null;
      currentToken += 1;
      try {
        return callback();
      } finally {
        current = before;
        currentToken += 1;
      }
    }

    function exposeForCurrentEvent(transaction) {
      current = transaction ?? null;
      const token = ++currentToken;
      if (typeof queueMicrotask === "function") {
        queueMicrotask(() => {
          if (currentToken === token) current = null;
        });
      }
      return transaction;
    }

    function snapshot() {
      return Object.freeze({
        serial,
        activeRangeCount: rangeTargets.size,
        pendingRangeCount: pendingRangeTargets.size,
        activeKeyCount: keys.size,
        activePointerCount: pointers.size,
        current: current ? { ...current } : null,
        lastLifecycle: lastLifecycle ? { ...lastLifecycle } : null,
      });
    }

    return Object.freeze({
      beginRange,
      sampleRange,
      endRangePointer,
      changeRange,
      cancelRange,
      blurRange,
      beginPointer,
      samplePointer,
      endPointer,
      sampleKey,
      endKey,
      clearKeys,
      endAll,
      currentContinuousTransaction,
      withContinuousTransaction,
      exposeForCurrentEvent,
      snapshot,
    });
  }

  function decorateProjectStore(projectStore, controller) {
    if (!projectStore || !controller) return projectStore;
    installContinuousGestureDurability(projectStore);
    if (projectStore.__g1GestureAttributionInstalled) return projectStore;

    const baseSetProductionInstrumentParameter = projectStore.setProductionInstrumentParameter?.bind(projectStore);
    if (baseSetProductionInstrumentParameter) {
      projectStore.setProductionInstrumentParameter = (instrumentId, parameterKey, value, metadata = {}) => {
        const transaction = metadata.transaction ?? controller.currentContinuousTransaction("sound");
        return baseSetProductionInstrumentParameter(
          instrumentId,
          parameterKey,
          value,
          transaction ? { ...metadata, transaction } : metadata,
        );
      };
    }

    Object.defineProperty(projectStore, "__g1GestureAttributionInstalled", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    return projectStore;
  }

  function install(root) {
    const commands = root.BRKTRKCommands;
    const bindings = root.BRKTRKCommandBindings;
    if (!root.document || !commands?.installed || !bindings || root.BRKTRKInputSafety?.installed) return null;

    const sharedHeldKeys = typeof heldKeys !== "undefined" ? heldKeys : root.heldKeys;
    const controller = createContinuousGestureController();
    const projectStore = root.BRKTRKStores?.project;
    decorateProjectStore(projectStore, controller);

    function finalizeProjectGesture(transaction) {
      if (!transaction) return null;
      return projectStore?.finalizeContinuousGesture?.(transaction) ?? null;
    }

    function finalizeAllContinuousGestures(reason = "boundary") {
      controller.endAll(reason);
      const result = projectStore?.finalizeAllContinuousGestures?.({
        gesturePhase: "end",
        gestureEndReason: reason,
      }) ?? Object.freeze({ ok: true, attemptedCount: 0, committedCount: 0, notificationErrors: Object.freeze([]), results: Object.freeze([]) });
      if (result.ok === false) root.setStatus?.(`DURABILITY FAILED · ${String(reason).toUpperCase()}`, "danger");
      return result;
    }

    function finalizeAfterCurrentEvent(transaction) {
      if (!transaction) return null;
      if (typeof queueMicrotask === "function") {
        queueMicrotask(() => { finalizeProjectGesture(transaction); });
        return transaction;
      }
      finalizeProjectGesture(transaction);
      return transaction;
    }

    function structuralTrackerWorkspace() {
      return ["song", "chain", "phrase"].includes(commands.runtime?.activeWorkspace);
    }

    function keyboardFamily(code) {
      if (!code?.startsWith("Arrow") || !sharedHeldKeys?.has?.("KeyS")) return null;
      const workspace = commands.runtime?.activeWorkspace;
      if (workspace === "sound") return "sound";
      if (workspace === "mix") return "mixer";
      if (["song", "chain", "phrase"].includes(workspace)) return "tracker";
      return null;
    }

    function keyboardBoundary(code) {
      const workspace = commands.runtime?.activeWorkspace;
      if (workspace === "sound"
          && sharedHeldKeys?.has?.("KeyA")
          && (code === "ArrowLeft" || code === "ArrowRight")) {
        return "instrument-switch";
      }
      return null;
    }

    const baseKeyDown = commands.keyDown.bind(commands);
    const baseKeyUp = commands.keyUp.bind(commands);
    function keyDown(code, repeat = false) {
      if (shouldIgnoreKeyDown(code, repeat, sharedHeldKeys)) return null;
      if (code === "KeyS" && !repeat && structuralTrackerWorkspace()) {
        const transaction = controller.sampleKey(code, "tracker", false);
        return controller.withContinuousTransaction(transaction, () => baseKeyDown(code, repeat));
      }
      const boundaryReason = keyboardBoundary(code);
      if (boundaryReason) {
        const boundary = finalizeAllContinuousGestures(boundaryReason);
        if (boundary.ok === false) return null;
      }
      const family = keyboardFamily(code);
      if (!family) return baseKeyDown(code, repeat);
      const transaction = controller.sampleKey(code, family, repeat);
      return controller.withContinuousTransaction(transaction, () => baseKeyDown(code, repeat));
    }

    function keyUp(code) {
      const transaction = controller.endKey(code, "keyup");
      if (!transaction) return baseKeyUp(code);
      const result = controller.withContinuousTransaction(transaction, () => baseKeyUp(code));
      finalizeProjectGesture(transaction);
      return result;
    }

    function releaseHeldKeys() {
      for (const code of [...(sharedHeldKeys ?? [])]) {
        const press = commands.runtime?.modifierPresses?.get(code);
        if (press) press.used = true;
        commands.keyUp(code);
      }
      commands.runtime?.modifierPresses?.clear?.();
      sharedHeldKeys?.clear?.();
    }

    const rangeTarget = (target) => {
      const sound = target?.closest?.("#instrumentInspector .a4a-param input[type=range]");
      if (sound) return { target: sound, family: "sound" };
      const mixer = target?.closest?.("#mixer .track-bus-controls input[type=range]");
      if (mixer) return { target: mixer, family: "mixer" };
      return null;
    };

    const structuralBoundaryTarget = (target) => {
      if (target?.closest?.("#instrumentInspector .a4a-sound-toolbar select[aria-label='Production Instrument slot']")) return "instrument-switch";
      if (target?.closest?.("#instrumentInspector .a4b-preset-panel select[data-preset-load-action='true']")) return "preset-load";
      if (target?.closest?.("#instrumentInspector .a4b-preset-panel button[data-preset-load-action='true']")) return "preset-load";
      if (target?.closest?.("#instrumentInspector .a4b-preset-panel button[data-preset-library-action]")) return "preset-library";
      return null;
    };

    function finalizeStructuralBoundary(event, reason) {
      const result = finalizeAllContinuousGestures(reason);
      if (result.ok !== false) return result;
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      if (reason === "instrument-switch" && event?.target) {
        const selected = root.BRKTRKStores?.navigation?.captureContext?.()?.instrument;
        if (Number.isInteger(selected)) event.target.value = String(selected);
      }
      if (reason === "preset-load" && event?.target?.tagName === "SELECT") {
        const panel = event.target.closest?.("#instrumentInspector .a4b-preset-panel");
        const loaded = panel?.dataset?.presetLoadedSelectorValue ?? panel?.dataset?.presetLoadedId;
        event.target.value = loaded || "";
      }
      return result;
    }

    root.document.addEventListener("pointerdown", (event) => {
      const range = rangeTarget(event.target);
      if (range) {
        controller.exposeForCurrentEvent(controller.beginRange(range.target, range.family, event.pointerId));
        return;
      }
      if (event.target?.closest?.("#mixer .track-pan-trigger")) {
        controller.exposeForCurrentEvent(controller.beginPointer(event.pointerId, "mixer", event.target));
      }
    }, true);

    root.document.addEventListener("input", (event) => {
      const range = rangeTarget(event.target);
      if (range) controller.exposeForCurrentEvent(controller.sampleRange(range.target, range.family));
    }, true);

    root.document.addEventListener("change", (event) => {
      const range = rangeTarget(event.target);
      if (range) {
        const transaction = controller.changeRange(range.target, range.family);
        controller.exposeForCurrentEvent(transaction);
        finalizeAfterCurrentEvent(transaction);
        return;
      }
      const boundaryReason = structuralBoundaryTarget(event.target);
      if (boundaryReason) finalizeStructuralBoundary(event, boundaryReason);
    }, true);

    root.document.addEventListener("click", (event) => {
      const boundaryReason = structuralBoundaryTarget(event.target);
      if (boundaryReason === "preset-load" || boundaryReason === "preset-library") {
        finalizeStructuralBoundary(event, boundaryReason);
      }
    }, true);

    root.document.addEventListener("pointermove", (event) => {
      const transaction = controller.samplePointer(event.pointerId);
      if (transaction) controller.exposeForCurrentEvent(transaction);
    }, true);

    root.document.addEventListener("pointerup", (event) => {
      const pointerTransaction = controller.endPointer(event.pointerId, false);
      if (pointerTransaction) {
        controller.exposeForCurrentEvent(pointerTransaction);
        finalizeAfterCurrentEvent(pointerTransaction);
      }
      const range = rangeTarget(event.target);
      if (range) {
        const transaction = controller.endRangePointer(range.target, event.pointerId);
        controller.exposeForCurrentEvent(transaction);
        finalizeAfterCurrentEvent(transaction);
      }
    }, true);

    root.document.addEventListener("pointercancel", (event) => {
      const pointerTransaction = controller.endPointer(event.pointerId, true);
      if (pointerTransaction) {
        controller.exposeForCurrentEvent(pointerTransaction);
        finalizeAfterCurrentEvent(pointerTransaction);
      }
      const range = rangeTarget(event.target);
      if (range) {
        const transaction = controller.cancelRange(range.target, event.pointerId);
        controller.exposeForCurrentEvent(transaction);
        finalizeAfterCurrentEvent(transaction);
      }
    }, true);

    root.document.addEventListener("blur", (event) => {
      const range = rangeTarget(event.target);
      if (!range) return;
      const transaction = controller.blurRange(range.target);
      controller.exposeForCurrentEvent(transaction);
      finalizeAfterCurrentEvent(transaction);
    }, true);

    root.addEventListener?.("blur", () => { finalizeAllContinuousGestures("blur"); });
    root.addEventListener?.("pagehide", () => { finalizeAllContinuousGestures("pagehide"); });
    root.document.addEventListener?.("visibilitychange", () => {
      if (root.document.visibilityState === "hidden") finalizeAllContinuousGestures("visibility-hidden");
    });

    commands.keyDown = keyDown;
    commands.keyUp = keyUp;
    root.keyDown = keyDown;
    root.keyUp = keyUp;
    root.BRKTRKCommandBindings = Object.freeze({
      ...bindings,
      releaseHeldKeys,
    });

    const api = Object.freeze({
      installed: true,
      shouldIgnoreKeyDown,
      releaseHeldKeys,
      finalizeAllContinuousGestures,
      controller,
      currentContinuousTransaction: controller.currentContinuousTransaction,
      snapshotContinuousGestures: controller.snapshot,
      snapshotContinuousDurability: () => projectStore?.continuousGestureDurabilitySnapshot?.() ?? null,
    });
    root.BRKTRKInputSafety = api;
    return api;
  }

  const exported = {
    shouldIgnoreKeyDown,
    installContinuousGestureDurability,
    createContinuousGestureController,
    decorateProjectStore,
    install,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (globalThis.document) install(globalThis);
})();
