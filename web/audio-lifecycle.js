(() => {
  const readiness = globalThis.BRKTRKAudioReadiness;
  const domainApi = globalThis.BRKTRKAudioLifecycleDomain;
  const transportStore = globalThis.BRKTRKStores?.transport;
  const audioRuntime = typeof audio !== "undefined" ? audio : null;
  if (!readiness || !domainApi || !transportStore || !audioRuntime) {
    throw new Error("Audio lifecycle integration requires readiness, domain, TransportStore and BrowserAudio");
  }
  if (globalThis.BRKTRKAudioLifecycle) return;

  const domain = domainApi.install(transportStore, {
    contextState: audioRuntime.context?.state ?? "none",
    visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
  });
  const boundContexts = new WeakSet();

  function report(type, detail = {}, source = null) {
    return domain.report({ type, ...detail }, { source: source ?? detail.source ?? "audio-lifecycle" });
  }

  function reportContextState(context, source) {
    if (!context) return false;
    const contextState = context.state ?? "none";
    if (contextState === "running" && readiness.snapshot().ready !== true) return false;
    report("CONTEXT_STATE", { contextState }, source);
    return true;
  }

  function bindContext(context) {
    if (!context || boundContexts.has(context)) return false;
    boundContexts.add(context);
    context.addEventListener("statechange", () => {
      reportContextState(context, "audio-context-statechange");
    });
    reportContextState(context, "audio-context-bound");
    return true;
  }

  readiness.subscribe((event) => {
    if (event.type === "init-request" || event.type === "existing-request" || event.type === "invalidated") {
      report(
        "INIT_REQUEST",
        {},
        event.source ?? (event.type === "invalidated" ? "audio-readiness-invalidated" : event.type === "existing-request" ? "audio-revalidate" : "audio-init"),
      );
    }
    if (event.type === "resume-request") report("RESUME_REQUEST", {}, event.source ?? "audio-resume");
    if (event.type === "ready") {
      bindContext(audioRuntime.context);
      report("INIT_READY", { contextState: audioRuntime.context?.state ?? "none" }, event.source ?? "audio-ready");
    }
    if (event.type === "init-failed" || event.type === "existing-failed" || event.type === "terminal-failed") {
      report("INIT_FAILED", { error: event.error }, event.source ?? (event.type === "existing-failed" ? "audio-revalidate-failed" : event.type === "terminal-failed" ? "audio-worklet-processorerror" : "audio-init-failed"));
    }
    if (event.type === "resume-failed") report("RESUME_FAILED", { error: event.error }, event.source ?? "audio-resume-failed");
  });

  document.addEventListener("visibilitychange", () => {
    report(document.visibilityState === "hidden" ? "VISIBILITY_HIDDEN" : "VISIBILITY_VISIBLE", {}, "document-visibilitychange");
    if (audioRuntime.context) reportContextState(audioRuntime.context, "visibility-context-snapshot");
  });
  window.addEventListener("pagehide", (event) => {
    report("PAGE_HIDE", { persisted: event.persisted === true }, "window-pagehide");
  });
  window.addEventListener("pageshow", (event) => {
    report("PAGE_SHOW", { persisted: event.persisted === true }, "window-pageshow");
    if (audioRuntime.context) reportContextState(audioRuntime.context, "pageshow-context-snapshot");
  });

  if (audioRuntime.context) {
    bindContext(audioRuntime.context);
    if (audioRuntime.context.state === "running" && readiness.snapshot().ready !== true) {
      report("INIT_REQUEST", {}, "audio-lifecycle-canonical-readiness-pending");
    }
  }
  report(document.visibilityState === "hidden" ? "VISIBILITY_HIDDEN" : "VISIBILITY_VISIBLE", {}, "audio-lifecycle-install");

  globalThis.BRKTRKAudioLifecycle = Object.freeze({
    snapshot: domain.snapshot,
    ensureReady(source = "explicit-user-audio-request") {
      return audioRuntime.init({ source });
    },
    report,
    reportContextState,
    bindContext,
    simulate(event) {
      return report(event.type, event, "audio-lifecycle-fixture");
    },
  });
  document.body.dataset.audioLifecycleOwner = "transport-store";
})();
