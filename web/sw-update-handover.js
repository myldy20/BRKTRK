(() => {
  "use strict";

  const UPDATE_MESSAGE = "brktrk-activate-update";
  const UPDATE_RESULT_MESSAGE = "brktrk-activate-update-result";
  const CONTROLLERCHANGE_TIMEOUT_MS = 8000;

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

  function fileSessionSafety(snapshot) {
    const reasons = [];
    if (!snapshot || typeof snapshot !== "object") reasons.push("file-session-unavailable");
    else {
      if (snapshot.dirty !== false) reasons.push("project-dirty");
      if (typeof snapshot.operationInFlight !== "boolean") reasons.push("file-operation-state-unavailable");
      else if (snapshot.operationInFlight) reasons.push("file-operation-in-flight");
      if (snapshot.saveInFlight === true || Number(snapshot.queuedSaveCount ?? 0) > 0) reasons.push("save-in-flight");
    }
    return reasons;
  }

  function gestureSafety(inputSafety) {
    if (!inputSafety?.snapshotContinuousGestures || !inputSafety?.snapshotContinuousDurability) {
      return ["gesture-state-unavailable"];
    }
    const gestures = inputSafety.snapshotContinuousGestures() ?? {};
    const durability = inputSafety.snapshotContinuousDurability() ?? {};
    const active = Number(gestures.activeRangeCount ?? 0)
      + Number(gestures.pendingRangeCount ?? 0)
      + Number(gestures.activeKeyCount ?? 0)
      + Number(gestures.activePointerCount ?? 0);
    const reasons = [];
    if (active > 0 || gestures.current) reasons.push("gesture-active");
    if (Number(durability.pendingCount ?? 0) > 0) reasons.push("gesture-durability-pending");
    return reasons;
  }

  function transportSafety(transportStore) {
    const snapshot = transportStore?.runtime?.snapshot?.() ?? null;
    if (!snapshot) return ["transport-state-unavailable"];
    const fullyStopped = snapshot.phase === "stopped"
      && snapshot.playing === false
      && snapshot.requested == null
      && snapshot.applied == null
      && snapshot.stopRequest == null;
    return fullyStopped ? [] : ["transport-not-stopped"];
  }

  function writerSafety(authority) {
    const snapshot = authority?.snapshot?.() ?? null;
    if (!authority?.canWrite || !snapshot) return ["writer-state-unavailable"];
    return authority.canWrite() === true && snapshot.mode === "writer"
      ? []
      : ["not-browser-writer"];
  }

  function evaluateHandoverSafety(root = globalThis) {
    const fileSession = root.BRKTRKProjectFileSession?.snapshot?.() ?? null;
    const reasons = [
      ...fileSessionSafety(fileSession),
      ...gestureSafety(root.BRKTRKInputSafety),
      ...transportSafety(root.BRKTRKStores?.transport),
      ...writerSafety(root.BRKTRKBrowserWriterAuthority),
    ];
    return Object.freeze({
      safe: reasons.length === 0,
      reasons: Object.freeze([...new Set(reasons)]),
      fileSession: clone(fileSession),
      transport: clone(root.BRKTRKStores?.transport?.runtime?.snapshot?.() ?? null),
      writer: clone(root.BRKTRKBrowserWriterAuthority?.snapshot?.() ?? null),
      gestures: clone(root.BRKTRKInputSafety?.snapshotContinuousGestures?.() ?? null),
      durability: clone(root.BRKTRKInputSafety?.snapshotContinuousDurability?.() ?? null),
    });
  }

  function createController(root = globalThis, registration, options = {}) {
    if (!registration || typeof registration !== "object") throw new TypeError("Service Worker registration is required");
    const controllerChangeTimeoutMs = Number.isFinite(options.controllerChangeTimeoutMs)
      ? Math.max(100, Number(options.controllerChangeTimeoutMs))
      : CONTROLLERCHANGE_TIMEOUT_MS;
    const state = {
      phase: "idle",
      waiting: null,
      error: null,
      blockedReasons: [],
      reloadApproved: false,
      controllerChangeTimer: null,
      refreshTimer: null,
      // The notice is informational while the update is blocked, and the only
      // thing that unblocks it (saving, stopping) happens in the editor the
      // notice covers. It must therefore be dismissible without losing the
      // pending update.
      dismissed: false,
      lastSafe: null,
    };
    let panel = null;
    let message = null;
    let button = null;
    let dismissButton = null;

    function waitingWorker() {
      return state.waiting ?? registration.waiting ?? null;
    }

    function snapshot() {
      const safety = evaluateHandoverSafety(root);
      return Object.freeze({
        version: 1,
        owner: "service-worker-update-handover",
        phase: state.phase,
        updateReady: Boolean(waitingWorker()),
        blockedReasons: Object.freeze([...state.blockedReasons]),
        dismissed: state.dismissed === true,
        error: state.error,
        waitingScriptURL: waitingWorker()?.scriptURL ?? null,
        controllerScriptURL: root.navigator?.serviceWorker?.controller?.scriptURL ?? null,
        safety,
      });
    }

    function ensurePanel() {
      if (!root.document?.body) return null;
      panel = root.document.querySelector?.("#swUpdateStatus") ?? null;
      if (panel) {
        message = panel.querySelector?.("[data-sw-update-message]") ?? null;
        button = panel.querySelector?.("button[data-sw-update-apply]") ?? null;
        dismissButton = panel.querySelector?.("button[data-sw-update-dismiss]") ?? null;
        return panel;
      }
      panel = root.document.createElement("section");
      panel.id = "swUpdateStatus";
      panel.setAttribute("role", "status");
      panel.setAttribute("aria-live", "polite");
      panel.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:760px;margin:0 auto;padding:10px 12px;box-sizing:border-box;border:1px solid currentColor;background:#05080d;color:#dce7f2;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
      message = root.document.createElement("span");
      message.dataset.swUpdateMessage = "1";
      button = root.document.createElement("button");
      button.type = "button";
      button.dataset.swUpdateApply = "1";
      button.textContent = "APPLY UPDATE";
      button.style.cssText = "min-height:44px;padding:8px 12px;font:inherit";
      button.addEventListener("click", () => { void requestHandover(); });
      dismissButton = root.document.createElement("button");
      dismissButton.type = "button";
      dismissButton.dataset.swUpdateDismiss = "1";
      dismissButton.textContent = "\u2715";
      dismissButton.setAttribute("aria-label", "Hide the update notice");
      dismissButton.title = "Hide this notice until the update can be applied";
      dismissButton.style.cssText = "min-width:44px;min-height:44px;padding:8px 10px;font:inherit;background:transparent;color:inherit;border:1px solid currentColor";
      dismissButton.addEventListener("click", () => { state.dismissed = true; render(); });
      panel.append(message, button, dismissButton);
      root.document.body.append(panel);
      return panel;
    }

    function removePanel() {
      panel?.remove?.();
      panel = null;
      message = null;
      button = null;
      dismissButton = null;
    }

    function render() {
      const worker = waitingWorker();
      if (!worker && state.phase !== "failed") {
        removePanel();
        // Nothing is pending, so a later update starts visible again.
        state.dismissed = false;
        state.lastSafe = null;
        return snapshot();
      }
      // Safety is evaluated before the dismissal check so blockedReasons stays
      // truthful in the debug snapshot while the notice is hidden.
      const safety = evaluateHandoverSafety(root);
      state.blockedReasons = safety.reasons;
      // A hidden notice returns only when it becomes actionable (blocked ->
      // safe) or reaches a phase the operator must see.
      const demandsAttention = state.phase === "failed" || state.phase === "activating" || state.phase === "reloading";
      if (state.dismissed && (demandsAttention || (safety.safe && state.lastSafe === false))) state.dismissed = false;
      state.lastSafe = safety.safe;
      if (state.dismissed) {
        removePanel();
        return snapshot();
      }
      ensurePanel();
      if (!panel || !message || !button) return snapshot();
      if (state.phase === "failed") {
        message.textContent = `UPDATE FAILED · ${state.error ?? "RETRY LATER"}`;
        button.hidden = !worker;
        button.disabled = !worker || !safety.safe;
      } else if (state.phase === "activating") {
        message.textContent = "APPLYING UPDATE · EDITOR LOCKED";
        button.hidden = true;
        button.disabled = true;
      } else if (state.phase === "reloading") {
        message.textContent = state.error === "controllerchange-timeout"
          ? "UPDATE ACTIVATION UNCERTAIN · RELOADING"
          : "UPDATE ACTIVATED · RELOADING";
        button.hidden = true;
        button.disabled = true;
      } else if (worker) {
        state.phase = "ready";
        if (safety.safe) message.textContent = "UPDATE READY · SAFE TO RELOAD";
        else message.textContent = `UPDATE READY · BLOCKED: ${safety.reasons.join(", ")}`;
        button.hidden = false;
        button.disabled = !safety.safe;
      }
      // A handover in flight may not be hidden: the editor is locked and the
      // page is about to reload.
      if (dismissButton) dismissButton.hidden = demandsAttention;
      // A disabled APPLY UPDATE is not an action and has no business covering
      // editable mixer/Sound controls. Keep the worker and diagnostics intact,
      // and reappear on the first safe writer/stopped/clean state. Only an
      // actual failed/activating/reloading handover remains visible while unsafe.
      panel.style.display = worker && !safety.safe && state.phase === "ready"
        ? "none" : "flex";
      panel.dataset.deferred = String(worker && !safety.safe && state.phase === "ready");
      panel.dataset.phase = state.phase;
      panel.dataset.blocked = String(!safety.safe);
      return snapshot();
    }

    function stopRefreshTimer() {
      if (state.refreshTimer != null) root.clearInterval?.(state.refreshTimer);
      state.refreshTimer = null;
    }

    function startRefreshTimer() {
      if (state.refreshTimer != null || !root.setInterval) return;
      state.refreshTimer = root.setInterval(() => {
        if (!waitingWorker() || state.phase === "activating" || state.phase === "reloading") return;
        render();
      }, 250);
    }

    function stageWaiting(worker = registration.waiting) {
      if (!worker) return false;
      state.waiting = worker;
      state.phase = "ready";
      state.error = null;
      state.reloadApproved = false;
      render();
      startRefreshTimer();
      // Do not paint a second bottom/top status line when the action is
      // safety-blocked. It is still observable via the diagnostic snapshot.
      if (evaluateHandoverSafety(root).safe) {
        root.setStatus?.("UPDATE READY · SAFE TO APPLY", "amber");
      }
      return true;
    }

    function fail(error) {
      state.phase = "failed";
      state.error = String(error?.message ?? error ?? "Service Worker update failed");
      state.reloadApproved = false;
      if (state.controllerChangeTimer != null) root.clearTimeout?.(state.controllerChangeTimer);
      state.controllerChangeTimer = null;
      root.BRKTRKBootstrapInput?.release?.("sw-update-handover-failed");
      root.setStatus?.("UPDATE FAILED · CURRENT SESSION PRESERVED", "danger");
      render();
      return false;
    }

    function reloadApprovedClient(reason = "controllerchange") {
      if (!state.reloadApproved || state.phase !== "activating") return false;
      state.reloadApproved = false;
      state.phase = "reloading";
      state.error = reason === "controllerchange-timeout" ? "controllerchange-timeout" : null;
      if (state.controllerChangeTimer != null) root.clearTimeout?.(state.controllerChangeTimer);
      state.controllerChangeTimer = null;
      stopRefreshTimer();
      root.setStatus?.(
        reason === "controllerchange-timeout"
          ? "UPDATE ACTIVATION UNCERTAIN · RELOADING"
          : "UPDATE ACTIVATED · RELOADING",
        reason === "controllerchange-timeout" ? "amber" : undefined,
      );
      render();
      root.location?.reload?.();
      return true;
    }

    async function requestHandover() {
      const worker = waitingWorker();
      if (!worker || state.phase === "activating" || state.phase === "reloading") return false;

      const initialSafety = evaluateHandoverSafety(root);
      state.blockedReasons = initialSafety.reasons;
      if (!initialSafety.safe) {
        state.phase = "ready";
        root.setStatus?.(`UPDATE BLOCKED · ${initialSafety.reasons.join(" · ")}`, "amber");
        render();
        return false;
      }

      const finalized = root.BRKTRKInputSafety?.finalizeAllContinuousGestures?.("sw-update-handover") ?? null;
      if (finalized?.ok === false || Number(finalized?.notificationErrors?.length ?? 0) > 0) {
        return fail(new Error("gesture durability finalization failed"));
      }

      const safety = evaluateHandoverSafety(root);
      state.blockedReasons = safety.reasons;
      if (!safety.safe) {
        state.phase = "ready";
        root.setStatus?.(`UPDATE BLOCKED · ${safety.reasons.join(" · ")}`, "amber");
        render();
        return false;
      }

      root.BRKTRKBootstrapInput?.block?.("sw-update-handover");
      const finalSafety = evaluateHandoverSafety(root);
      if (!finalSafety.safe) {
        root.BRKTRKBootstrapInput?.release?.("sw-update-handover-aborted");
        state.blockedReasons = finalSafety.reasons;
        state.phase = "ready";
        render();
        return false;
      }

      state.phase = "activating";
      state.error = null;
      state.reloadApproved = true;
      render();
      try {
        worker.postMessage({ type: UPDATE_MESSAGE });
      } catch (error) {
        return fail(error);
      }
      state.controllerChangeTimer = root.setTimeout?.(() => {
        if (state.phase === "activating") reloadApprovedClient("controllerchange-timeout");
      }, controllerChangeTimeoutMs) ?? null;
      return true;
    }

    function onControllerChange() {
      reloadApprovedClient("controllerchange");
    }

    function watchInstalling(worker) {
      if (!worker?.addEventListener) return;
      const onStateChange = () => {
        if (worker.state === "installed" && root.navigator?.serviceWorker?.controller) {
          stageWaiting(registration.waiting ?? worker);
        }
      };
      worker.addEventListener("statechange", onStateChange);
      onStateChange();
    }

    function onUpdateFound() {
      watchInstalling(registration.installing);
    }

    registration.addEventListener?.("updatefound", onUpdateFound);
    root.navigator?.serviceWorker?.addEventListener?.("controllerchange", onControllerChange);
    watchInstalling(registration.installing);
    if (registration.waiting && root.navigator?.serviceWorker?.controller) stageWaiting(registration.waiting);

    root.BRKTRKProjectFileSession?.subscribe?.(() => {
      if (waitingWorker() && state.phase !== "activating" && state.phase !== "reloading") render();
    });
    root.BRKTRKStores?.transport?.subscribe?.("transport", () => {
      if (waitingWorker() && state.phase !== "activating" && state.phase !== "reloading") render();
    });
    root.BRKTRKDiagnostics?.registerSection?.("serviceWorkerUpdate", snapshot);

    return Object.freeze({
      installed: true,
      snapshot,
      render,
      stageWaiting,
      requestHandover,
      evaluateSafety: () => evaluateHandoverSafety(root),
    });
  }

  function install(root = globalThis, registration) {
    if (root.BRKTRKServiceWorkerUpdateHandover?.installed) return root.BRKTRKServiceWorkerUpdateHandover;
    const controller = createController(root, registration);
    root.BRKTRKServiceWorkerUpdateHandover = controller;
    return controller;
  }

  const exported = Object.freeze({
    UPDATE_MESSAGE,
    UPDATE_RESULT_MESSAGE,
    CONTROLLERCHANGE_TIMEOUT_MS,
    fileSessionSafety,
    gestureSafety,
    transportSafety,
    writerSafety,
    evaluateHandoverSafety,
    createController,
    install,
  });
  globalThis.BRKTRKServiceWorkerUpdateHandoverDomain = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})();
