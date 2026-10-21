(() => {
  const projectStore = globalThis.BRKTRKStores?.project;
  const domain = globalThis.BRKTRKTrackMix
    ?? (globalThis.BRKTRKTrackMixDomain && projectStore
      ? globalThis.BRKTRKTrackMixDomain.install(projectStore, { trackCount: typeof TRACKS !== "undefined" ? TRACKS : 8 })
      : null);
  const readiness = globalThis.BRKTRKAudioReadiness;
  const audioRuntime = typeof audio !== "undefined" ? audio : null;
  if (!projectStore || !domain || !readiness || !audioRuntime) {
    throw new Error("Track mix runtime requires ProjectStore, Track mix domain, audio readiness and BrowserAudio");
  }
  if (globalThis.BRKTRKTrackMixRuntime?.installed) return;

  const boundPorts = new WeakSet();
  let requestedRevision = 0;
  let appliedRevision = 0;
  let lastSource = "track-mix-install";
  let lastError = null;

  function renderDiagnostics() {
    const mixer = document.querySelector("#mixer");
    if (!mixer) return;
    mixer.dataset.mixRequestedRevision = String(requestedRevision);
    mixer.dataset.mixAppliedRevision = String(appliedRevision);
    mixer.dataset.mixPending = String(requestedRevision > appliedRevision);
    mixer.dataset.mixError = lastError ?? "";
  }

  function handlePortMessage(event) {
    const data = event?.data;
    if (data?.type !== "track-mix-applied") return;
    const revision = Number(data.revision);
    if (Number.isInteger(revision) && revision >= appliedRevision) appliedRevision = revision;
    lastError = null;
    renderDiagnostics();
  }

  function bindPort() {
    const port = audioRuntime.node?.port;
    if (!port || boundPorts.has(port)) return false;
    boundPorts.add(port);
    port.addEventListener?.("message", handlePortMessage);
    port.start?.();
    return true;
  }

  function postCurrentMix(source = "track-mix-runtime") {
    const tracks = domain.snapshot();
    lastSource = source;
    if (!audioRuntime.ready || !audioRuntime.node?.port) {
      renderDiagnostics();
      return Object.freeze({ sent: false, revision: requestedRevision, tracks, source });
    }
    bindPort();
    requestedRevision += 1;
    audioRuntime.node.port.postMessage({
      type: "track-mix",
      tracks,
      revision: requestedRevision,
      source,
    });
    renderDiagnostics();
    return Object.freeze({ sent: true, revision: requestedRevision, tracks, source });
  }

  function snapshot() {
    return Object.freeze({
      requestedRevision,
      appliedRevision,
      pending: requestedRevision > appliedRevision,
      lastSource,
      lastError,
      tracks: domain.snapshot(),
      bound: Boolean(audioRuntime.node?.port && boundPorts.has(audioRuntime.node.port)),
    });
  }

  const unsubscribeProject = projectStore.subscribe("track-mix", (changeSet) => {
    postCurrentMix(changeSet.source ?? `track-${changeSet.transaction?.track ?? "unknown"}-mix`);
  });
  const unsubscribeReadiness = readiness.subscribe((event) => {
    if (event.type !== "ready") return;
    queueMicrotask(() => postCurrentMix(event.source ?? "audio-ready-track-mix"));
  });

  audioRuntime.setTrackMix = function setTrackMixRuntime(source = "explicit-track-mix-sync") {
    return postCurrentMix(source);
  };

  const runtime = Object.freeze({
    installed: true,
    snapshot,
    postCurrentMix,
    bindPort,
    handlePortMessage,
    disconnect() {
      unsubscribeProject();
      unsubscribeReadiness();
    },
  });
  globalThis.BRKTRKTrackMixRuntime = runtime;
  document.body.dataset.trackMixRuntime = "project-track-bus-worklet";
  document.body.dataset.trackMixTransportPolicy = "no-structural-version";

  if (audioRuntime.ready) queueMicrotask(() => postCurrentMix("track-mix-install-ready"));
})();
