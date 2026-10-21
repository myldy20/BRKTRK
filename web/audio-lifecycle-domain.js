(() => {
  const policy = globalThis.BRKTRKAudioLifecyclePolicy
    ?? (typeof require === "function" ? require("./audio-lifecycle-policy.js") : null);
  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  if (!policy || !storeTypes) throw new Error("Audio lifecycle domain requires policy and Store types");

  function createDomain(transportStore, options = {}) {
    if (!transportStore || transportStore.owner !== "transport") {
      throw new TypeError("Audio lifecycle domain requires TransportStore");
    }
    const transportState = transportStore.getState();
    transportState.transportRuntime ??= {};
    let current = policy.initialState({
      ...(transportState.transportRuntime.audioLifecycle ?? {}),
      contextState: options.contextState ?? transportState.transportRuntime.audioLifecycle?.contextState,
      visibility: options.visibility ?? transportState.transportRuntime.audioLifecycle?.visibility,
    });
    transportState.transportRuntime.audioLifecycle = current;

    function snapshot() { return current; }

    function report(event, metadata = {}) {
      const before = current;
      const after = policy.transition(before, event);
      current = after;
      transportState.transportRuntime.audioLifecycle = after;
      const changeSet = storeTypes.createTransportChangeSet({
        subtype: `audio-lifecycle.${String(event?.type ?? "unknown").toLowerCase()}`,
        target: "transport.audioLifecycle",
        path: ["audioLifecycle"],
        before,
        after,
        affectsPlayback: false,
        renderTargets: ["transport.audio-status"],
        source: metadata.source ?? event?.source ?? null,
      });
      for (const channel of ["transport", "status", "render"]) transportStore.emit(channel, changeSet);
      return Object.freeze({ before, after, changeSet });
    }

    return Object.freeze({ snapshot, report });
  }

  function install(transportStore, options = {}) {
    if (transportStore.audioLifecycle) return transportStore.audioLifecycle;
    const domain = createDomain(transportStore, options);
    Object.defineProperty(transportStore, "audioLifecycle", {
      value: domain,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    return domain;
  }

  const api = Object.freeze({ createDomain, install });
  globalThis.BRKTRKAudioLifecycleDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
