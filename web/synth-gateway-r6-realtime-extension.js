(() => {
  "use strict";

  const baseDomain = globalThis.BRKTRKSynthGatewayDomain;
  if (!baseDomain?.createSynthGateway) throw new Error("R6 realtime gateway extension requires SynthGateway");

  const DEFAULT_MAX_EVENTS_PER_BLOCK = baseDomain.DEFAULT_MAX_EVENTS_PER_BLOCK ?? 131072;
  let gatewayCreationSerial = 0;
  let lastCreatedGateway = null;

  const safeInteger = (value, label, min = 0) => {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < min) throw new RangeError(`${label} must be a safe integer >= ${min}`);
    return numeric;
  };

  function createSynthGateway(options = {}) {
    const performerRegistry = options.performerRegistry;
    if (!performerRegistry?.prepared) throw new TypeError("R6 SynthGateway requires PerformerRegistry");
    const gateway = baseDomain.createSynthGateway(options);
    const eventCapacity = safeInteger(options.maxEventsPerBlock ?? DEFAULT_MAX_EVENTS_PER_BLOCK, "maxEventsPerBlock", 1);
    let active = false;
    let frameCount = 0;
    let combinedEventCount = 0;
    let combinedHighWater = 0;
    let preparedParameterEvents = 0;
    let primitiveRenderCalls = 0;

    function ensureCapacity(demand) {
      const count = safeInteger(demand, "eventDemand");
      if (combinedEventCount + count > eventCapacity) throw new RangeError(`SynthGateway event demand exceeded ${eventCapacity}`);
      return count;
    }

    function commitDemand(demand) {
      combinedEventCount += demand;
      if (combinedEventCount > combinedHighWater) combinedHighWater = combinedEventCount;
      return combinedEventCount;
    }

    function beginBlock(startFrame, actualFrameCount) {
      const frames = safeInteger(actualFrameCount, "frameCount", 1);
      const result = gateway.beginBlock(startFrame, frames);
      frameCount = frames;
      combinedEventCount = 0;
      active = true;
      return result;
    }

    function blockOffset(value = 0, label = "sampleOffset") {
      if (!active) throw new Error("SynthGateway block is not active");
      const offset = safeInteger(value, label);
      if (offset >= frameCount) throw new RangeError(`${label} is outside active block`);
      return offset;
    }

    function resolveParameterHandle(track, instrumentId, parameterId) {
      const slot = performerRegistry.prepared(track, instrumentId);
      if (!slot) return -1;
      if (typeof slot.performer?.parameterHandle !== "function") return -1;
      return Number(slot.performer.parameterHandle(parameterId));
    }

    function applyPreparedParameter(track, instrumentId, parameterHandle, value, sampleOffset = 0, rampFrames = 0) {
      const offset = blockOffset(sampleOffset);
      const slot = performerRegistry.prepared(track, instrumentId);
      if (!slot) return false;
      const performer = slot.performer;
      if (typeof performer?.preflightPreparedParameter !== "function" || typeof performer?.handlePreparedParameter !== "function") {
        throw new TypeError("prepared performer does not expose the R6 primitive parameter path");
      }
      performer.preflightPreparedParameter(parameterHandle, offset, rampFrames);
      ensureCapacity(1);
      performer.handlePreparedParameter(parameterHandle, value, offset, rampFrames);
      commitDemand(1);
      preparedParameterEvents += 1;
      return true;
    }

    function applyParameter(track, instrumentId, parameterId, value, sampleOffset = 0, rampFrames = 0) {
      const handle = resolveParameterHandle(track, instrumentId, parameterId);
      if (!Number.isSafeInteger(handle) || handle < 0) {
        const slot = performerRegistry.prepared(track, instrumentId);
        if (!slot) return false;
        throw new RangeError(`unknown stable parameter id ${String(parameterId)}`);
      }
      return applyPreparedParameter(track, instrumentId, handle, value, sampleOffset, rampFrames);
    }

    function routePreparedLifecycle(frame, track, instrumentId, type, pitch, velocity = 100) {
      ensureCapacity(1);
      const result = gateway.routePreparedLifecycle(frame, track, instrumentId, type, pitch, velocity);
      commitDemand(1);
      return result;
    }

    function routePreparedLifecyclePair(frame, track, releaseInstrumentId, releasePitch, releaseVelocity, triggerInstrumentId, triggerPitch, triggerVelocity = 100) {
      ensureCapacity(2);
      const result = gateway.routePreparedLifecyclePair(frame, track, releaseInstrumentId, releasePitch, releaseVelocity, triggerInstrumentId, triggerPitch, triggerVelocity);
      commitDemand(2);
      return result;
    }

    function noteOn(...args) {
      ensureCapacity(1);
      const result = gateway.noteOn(...args);
      if (result) commitDemand(1);
      return result;
    }

    function noteOff(...args) {
      ensureCapacity(1);
      const result = gateway.noteOff(...args);
      if (result) commitDemand(1);
      return result;
    }

    function kill(...args) {
      ensureCapacity(1);
      const result = gateway.kill(...args);
      if (result) commitDemand(1);
      return result;
    }

    function trackPreparedCount(track) {
      let count = 0;
      const capacity = Number(performerRegistry.instrumentCount ?? 256);
      for (let instrumentId = 0; instrumentId < capacity; instrumentId += 1) if (performerRegistry.prepared(track, instrumentId)) count += 1;
      return count;
    }

    function allNotesOff(track, instrumentId = null, sampleOffset = 0) {
      const demand = instrumentId === null || instrumentId === undefined ? trackPreparedCount(track) : performerRegistry.prepared(track, instrumentId) ? 1 : 0;
      ensureCapacity(demand);
      const result = gateway.allNotesOff(track, instrumentId, sampleOffset);
      commitDemand(Number(result) || 0);
      return result;
    }

    function reset(track, instrumentId = null, sampleOffset = 0) {
      const demand = instrumentId === null || instrumentId === undefined ? trackPreparedCount(track) : performerRegistry.prepared(track, instrumentId) ? 1 : 0;
      ensureCapacity(demand);
      const result = gateway.reset(track, instrumentId, sampleOffset);
      commitDemand(Number(result) || 0);
      return result;
    }

    function routeTracePacket(packet) {
      let demand = 0;
      for (const event of Array.isArray(packet?.events) ? packet.events : []) {
        const instrumentId = Number(event?.data?.instrumentId);
        if (Number.isInteger(instrumentId) && instrumentId >= 0 && instrumentId <= 255 && (event.kind === "note-release" || event.kind === "note-trigger")) demand += 1;
      }
      ensureCapacity(demand);
      const result = gateway.routeTracePacket(packet);
      commitDemand(demand);
      return result;
    }

    function renderTrack(track, left, right, actualFrameCount = frameCount) {
      if (!active) throw new Error("SynthGateway block is not active");
      const frames = safeInteger(actualFrameCount, "actualFrameCount", 1);
      if (frames !== frameCount) throw new RangeError("renderTrack frame count must match beginBlock frame count");
      if (!left || !right || left.length < frames || right.length < frames) throw new RangeError("dry Track buffers are smaller than the active frame count");
      for (let frame = 0; frame < frames; frame += 1) { left[frame] = 0; right[frame] = 0; }
      const capacity = Number(performerRegistry.instrumentCount ?? 256);
      for (let instrumentId = 0; instrumentId < capacity; instrumentId += 1) {
        const slot = performerRegistry.prepared(track, instrumentId);
        if (!slot) continue;
        if (typeof slot.performer?.processBlock !== "function") throw new TypeError("prepared performer does not expose the R6 primitive processBlock path");
        slot.performer.processBlock(frames, left, right, true);
        primitiveRenderCalls += 1;
      }
      return true;
    }

    function endBlock() {
      try { return gateway.endBlock(); }
      finally { active = false; frameCount = 0; }
    }

    function diagnostics() {
      return Object.freeze({
        ...(gateway.diagnostics?.() ?? {}),
        eventCount: combinedEventCount,
        highWaterEvents: Math.max(combinedHighWater, Number(gateway.diagnostics?.().highWaterEvents ?? 0)),
        r6Realtime: Object.freeze({
          primitiveParameterPath: true,
          primitiveRenderPath: true,
          preparedParameterEvents,
          primitiveRenderCalls,
          combinedEventCount,
          combinedHighWater,
          eventCapacity,
        }),
      });
    }

    const extended = Object.freeze({
      ...gateway,
      beginBlock,
      resolveParameterHandle,
      applyPreparedParameter,
      applyParameter,
      routePreparedLifecycle,
      routePreparedLifecyclePair,
      noteOn,
      noteOff,
      kill,
      allNotesOff,
      reset,
      routeTracePacket,
      renderTrack,
      endBlock,
      diagnostics,
    });
    lastCreatedGateway = extended;
    gatewayCreationSerial += 1;
    return extended;
  }

  const getGatewayCreationSerial = () => gatewayCreationSerial;
  const getGatewayCreatedAfter = (serial) => gatewayCreationSerial > Number(serial) ? lastCreatedGateway : null;

  const api = Object.freeze({
    ...baseDomain,
    createSynthGateway,
    getGatewayCreationSerial,
    getGatewayCreatedAfter,
    R6_REALTIME_VERSION: 1,
  });
  globalThis.BRKTRKSynthGatewayDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();