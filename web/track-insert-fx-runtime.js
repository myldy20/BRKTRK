(() => {
  "use strict";

  const projectStore = globalThis.BRKTRKStores?.project;
  const domain = globalThis.BRKTRKTrackInsertFxDomain;
  const readiness = globalThis.BRKTRKAudioReadiness;
  const audioRuntime = typeof audio !== "undefined" ? audio : globalThis.audio;
  if (!projectStore || !domain || !readiness || !audioRuntime) {
    throw new Error("Track Insert FX runtime requires ProjectStore, FX domain, audio readiness and BrowserAudio");
  }
  if (globalThis.BRKTRKTrackInsertFxRuntime?.installed) return;

  const boundPorts = new WeakSet();
  let requestedRevision = 0;
  let appliedRevision = 0;
  let lastSource = "track-insert-fx-install";
  let lastError = null;

  function projectSnapshot() {
    const tracks = projectStore.getState()?.tracks ?? [];
    return domain.normalizeTracks(tracks.map((track) => track?.insertFx), tracks.length || 8);
  }

  function handlePortMessage(event) {
    const data = event?.data;
    if (data?.type !== "track-insert-fx-applied") return;
    const revision = Number(data.revision);
    if (Number.isInteger(revision) && revision >= appliedRevision) appliedRevision = revision;
    lastError = null;
  }

  function bindPort() {
    const port = audioRuntime.node?.port;
    if (!port || boundPorts.has(port)) return false;
    boundPorts.add(port);
    port.addEventListener?.("message", handlePortMessage);
    port.start?.();
    return true;
  }

  function postCurrent(source = "track-insert-fx-runtime") {
    const tracks = projectSnapshot();
    lastSource = source;
    if (!audioRuntime.ready || !audioRuntime.node?.port) {
      return Object.freeze({ sent: false, revision: requestedRevision, tracks, source });
    }
    bindPort();
    requestedRevision += 1;
    audioRuntime.node.port.postMessage({
      type: "track-insert-fx",
      tracks,
      revision: requestedRevision,
      source,
    });
    return Object.freeze({ sent: true, revision: requestedRevision, tracks, source });
  }

  const unsubscribeProject = projectStore.subscribe("track-insert-fx", (changeSet) => {
    try { postCurrent(changeSet?.source ?? "project-track-insert-fx"); }
    catch (error) { lastError = String(error?.message ?? error); }
  });
  const unsubscribeReadiness = readiness.subscribe((event) => {
    if (event.type !== "ready") return;
    queueMicrotask(() => {
      try { postCurrent(event.source ?? "audio-ready-track-insert-fx"); }
      catch (error) { lastError = String(error?.message ?? error); }
    });
  });

  audioRuntime.setTrackInsertFx = function setTrackInsertFx(source = "explicit-track-insert-fx-sync") {
    return postCurrent(source);
  };

  const api = Object.freeze({
    installed: true,
    projectSnapshot,
    postCurrent,
    bindPort,
    handlePortMessage,
    snapshot: () => Object.freeze({
      requestedRevision,
      appliedRevision,
      pending: requestedRevision > appliedRevision,
      lastSource,
      lastError,
      tracks: projectSnapshot(),
      bound: Boolean(audioRuntime.node?.port && boundPorts.has(audioRuntime.node.port)),
    }),
    disconnect() {
      unsubscribeProject();
      unsubscribeReadiness();
    },
  });

  globalThis.BRKTRKTrackInsertFxRuntime = api;
  if (audioRuntime.ready) queueMicrotask(() => postCurrent("track-insert-fx-install-ready"));
})();
