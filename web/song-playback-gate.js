(() => {
  const legacyTogglePlayback = togglePlayback;
  const WAIT_TIMEOUT_MS = 10000;
  const POLL_MS = 16;

  async function waitForProductionSongTransport() {
    const deadline = performance.now() + WAIT_TIMEOUT_MS;
    while (performance.now() < deadline) {
      if (globalThis.BRKTRKTransport && togglePlayback !== guardedTogglePlayback) {
        return togglePlayback;
      }
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
    }
    return null;
  }

  async function guardedTogglePlayback(forceSong = false) {
    const scope = forceSong ? "song" : state.scope;
    if (scope !== "song") return legacyTogglePlayback(forceSong);

    // The legacy linear Song builder pads every Track to the longest Chain in
    // a Song row. User Song playback must wait for the independent Track runtime.
    document.body.dataset.songPlaybackGate = "waiting";
    const productionToggle = await waitForProductionSongTransport();
    if (!productionToggle) {
      document.body.dataset.songPlaybackGate = "failed";
      setStatus("SONG TRANSPORT FAILED TO LOAD · RELOAD", "danger");
      return false;
    }
    document.body.dataset.songPlaybackGate = "ready";
    return productionToggle(forceSong);
  }

  togglePlayback = guardedTogglePlayback;
  document.body.dataset.songPlaybackGate = "idle";

  globalThis.BRKTRKSongPlaybackGate = Object.freeze({
    waitForProductionSongTransport,
    legacySongPlaybackBlocked: true,
  });
})();