(() => {
  "use strict";

  const baseDomain = globalThis.BRKTRKProductionAudioRuntime
    ?? (typeof module !== "undefined" && module.exports ? require("./production-audio-runtime.js") : null);
  const gatewayDomain = globalThis.BRKTRKSynthGatewayDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./synth-gateway-domain.js") : null);
  if (!baseDomain?.createProductionAudioRuntime
    || typeof gatewayDomain?.getGatewayCreationSerial !== "function"
    || typeof gatewayDomain?.getGatewayCreatedAfter !== "function") {
    throw new Error("Prepared lifecycle pair extension requires ProductionAudioRuntime + SynthGateway capture contract");
  }

  function createProductionAudioRuntime(options = {}) {
    let marker = gatewayDomain.getGatewayCreationSerial();
    const base = baseDomain.createProductionAudioRuntime(options);
    let gateway = gatewayDomain.getGatewayCreatedAfter(marker);

    function captureCreatedGateway(since) {
      const created = gatewayDomain.getGatewayCreatedAfter(since);
      if (created) gateway = created;
    }

    function configureInstruments(snapshot) {
      marker = gatewayDomain.getGatewayCreationSerial();
      const result = base.configureInstruments(snapshot);
      captureCreatedGateway(marker);
      return result;
    }

    function handleMessage(message) {
      marker = gatewayDomain.getGatewayCreationSerial();
      const result = base.handleMessage(message);
      captureCreatedGateway(marker);
      return result;
    }

    function prepareProgram(program) {
      marker = gatewayDomain.getGatewayCreationSerial();
      const result = base.prepareProgram(program);
      captureCreatedGateway(marker);
      return result;
    }

    function beginBlock(startFrame, frameCount) {
      marker = gatewayDomain.getGatewayCreationSerial();
      const result = base.beginBlock(startFrame, frameCount);
      captureCreatedGateway(marker);
      return result;
    }

    function stop(...args) {
      // A deferred Instrument snapshot may rebuild the registry during Stop.
      // Keep the bounded replacement path on the gateway that the next render
      // block will open, not the inactive gateway from the preceding transport.
      marker = gatewayDomain.getGatewayCreationSerial();
      try { return base.stop(...args); }
      finally { captureCreatedGateway(marker); }
    }

    function routePreparedLifecyclePair(
      frame,
      track,
      releaseInstrumentId,
      releasePitch,
      releaseVelocity,
      triggerInstrumentId,
      triggerPitch,
      triggerVelocity = 100,
    ) {
      if (!gateway || typeof gateway.routePreparedLifecyclePair !== "function") {
        throw new Error("production prepared lifecycle pair gateway is unavailable");
      }
      return gateway.routePreparedLifecyclePair(
        frame,
        track,
        releaseInstrumentId,
        releasePitch,
        releaseVelocity,
        triggerInstrumentId,
        triggerPitch,
        triggerVelocity,
      );
    }

    return Object.freeze({
      ...base,
      configureInstruments,
      handleMessage,
      prepareProgram,
      beginBlock,
      stop,
      routePreparedLifecyclePair,
    });
  }

  const api = Object.freeze({ ...baseDomain, createProductionAudioRuntime });
  globalThis.BRKTRKProductionAudioRuntime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
