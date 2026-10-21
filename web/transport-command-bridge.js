(() => {
  if (globalThis.BRKTRKTransportCommandBridge?.installed) return;
  if (typeof togglePlayback !== "function" || typeof stopPlayback !== "function") {
    throw new Error("Transport command bridge requires bootstrap playback functions");
  }

  const bootstrapToggle = togglePlayback;
  const bootstrapStop = stopPlayback;
  let delegatedToggleCount = 0;
  let delegatedStopCount = 0;
  let bootstrapToggleCount = 0;
  let bootstrapStopCount = 0;

  async function semanticTransportToggleBridge(forceSong = false) {
    const current = globalThis.togglePlayback;
    if (typeof current === "function" && current !== semanticTransportToggleBridge) {
      delegatedToggleCount += 1;
      return current(Boolean(forceSong));
    }
    bootstrapToggleCount += 1;
    return bootstrapToggle(Boolean(forceSong));
  }

  function semanticTransportStopBridge() {
    const current = globalThis.stopPlayback;
    if (typeof current === "function" && current !== semanticTransportStopBridge) {
      delegatedStopCount += 1;
      return current();
    }
    bootstrapStopCount += 1;
    return bootstrapStop();
  }

  function ownerName(value) {
    return typeof value === "function" ? (value.name || "anonymous") : null;
  }

  const api = Object.freeze({
    installed: true,
    toggle: semanticTransportToggleBridge,
    stop: semanticTransportStopBridge,
    snapshot() {
      const currentToggle = globalThis.togglePlayback;
      const currentStop = globalThis.stopPlayback;
      return Object.freeze({
        version: 1,
        owner: "semantic-transport-command-bridge",
        capturedByCommands: globalThis.BRKTRKCommands?.legacy?.togglePlayback === semanticTransportToggleBridge
          && globalThis.BRKTRKCommands?.legacy?.stopPlayback === semanticTransportStopBridge,
        finalToggleOwner: currentToggle === semanticTransportToggleBridge ? "bootstrap-pending" : ownerName(currentToggle),
        finalStopOwner: currentStop === semanticTransportStopBridge ? "bootstrap-pending" : ownerName(currentStop),
        delegatedToggleCount,
        delegatedStopCount,
        bootstrapToggleCount,
        bootstrapStopCount,
      });
    },
  });

  togglePlayback = semanticTransportToggleBridge;
  stopPlayback = semanticTransportStopBridge;
  globalThis.BRKTRKTransportCommandBridge = api;
  globalThis.BRKTRKDiagnostics?.registerSection?.("transportCommandBridge", api.snapshot);
  document.body.dataset.transportCommandBridge = "semantic-to-final-owner";
})();
