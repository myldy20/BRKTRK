(() => {
  const STATUSES = Object.freeze([
    "disabled",
    "initializing",
    "ready",
    "suspended",
    "resuming",
    "error",
  ]);

  const normalizeContextState = (value) => {
    const state = String(value ?? "none").toLowerCase();
    return ["none", "suspended", "running", "closed", "interrupted"].includes(state) ? state : "unknown";
  };

  function initialState(overrides = {}) {
    return Object.freeze({
      status: STATUSES.includes(overrides.status) ? overrides.status : "disabled",
      contextState: normalizeContextState(overrides.contextState),
      visibility: overrides.visibility === "hidden" ? "hidden" : "visible",
      pageHidden: overrides.pageHidden === true,
      restored: overrides.restored === true,
      persistedRestore: overrides.persistedRestore === true,
      initGeneration: Number.isInteger(overrides.initGeneration) ? Math.max(0, overrides.initGeneration) : 0,
      requiresGesture: overrides.requiresGesture === true,
      error: typeof overrides.error === "string" && overrides.error ? overrides.error : null,
      lastEvent: typeof overrides.lastEvent === "string" ? overrides.lastEvent : "INITIAL",
    });
  }

  function nextStatus(state, event) {
    switch (event.type) {
      case "INIT_REQUEST": return "initializing";
      case "RESUME_REQUEST": return "resuming";
      case "INIT_FAILED":
      case "RESUME_FAILED": return "error";
      case "CONTEXT_STATE": {
        const contextState = normalizeContextState(event.contextState);
        if (contextState === "running") return "ready";
        if (contextState === "suspended" || contextState === "interrupted") return "suspended";
        if (contextState === "closed") return "disabled";
        return state.status;
      }
      case "INIT_READY": return normalizeContextState(event.contextState) === "running" ? "ready" : "suspended";
      default: return state.status;
    }
  }

  function transition(previous, event = {}) {
    const state = initialState(previous);
    const type = String(event.type ?? "UNKNOWN");
    const contextState = event.contextState == null
      ? state.contextState
      : normalizeContextState(event.contextState);
    const status = nextStatus(state, { ...event, type, contextState });
    const failed = type === "INIT_FAILED" || type === "RESUME_FAILED";
    const ready = type === "INIT_READY" || (type === "CONTEXT_STATE" && contextState === "running");
    const suspended = type === "CONTEXT_STATE" && (contextState === "suspended" || contextState === "interrupted");
    return Object.freeze({
      status,
      contextState,
      visibility: type === "VISIBILITY_HIDDEN" ? "hidden" : type === "VISIBILITY_VISIBLE" ? "visible" : state.visibility,
      pageHidden: type === "PAGE_HIDE" ? true : type === "PAGE_SHOW" ? false : state.pageHidden,
      restored: type === "PAGE_SHOW" ? true : state.restored,
      persistedRestore: type === "PAGE_SHOW" ? event.persisted === true : state.persistedRestore,
      initGeneration: type === "INIT_REQUEST" ? state.initGeneration + 1 : state.initGeneration,
      requiresGesture: failed || suspended || status === "suspended"
        ? true
        : ready || status === "ready" ? false : state.requiresGesture,
      error: failed ? String(event.error || "Audio lifecycle failure") : ready ? null : state.error,
      lastEvent: type,
    });
  }

  const api = Object.freeze({ STATUSES, initialState, transition, normalizeContextState });
  globalThis.BRKTRKAudioLifecyclePolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
