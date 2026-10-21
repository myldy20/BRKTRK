(() => {
  "use strict";

  // Keep the default engine-facing budget aligned with the accepted K4B
  // per-render-block event budget. A caller may deliberately choose a smaller
  // bound, but the generic gateway must not introduce a hidden lower default.
  const DEFAULT_MAX_EVENTS_PER_BLOCK = 131072;
  const CONTROL_ACTIONS = Object.freeze(new Set(["kill", "all-notes-off", "reset"]));
  const NOTE_ACTIONS = Object.freeze(new Set(["note-on", "note-off"]));
  const PREPARED_LIFECYCLE_ACTIONS = Object.freeze(new Set(["note-on", "note-off", "retrigger"]));
  let gatewayCreationSerial = 0;
  let lastCreatedGateway = null;

  class SynthGatewayError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "SynthGatewayError";
      this.code = String(code || "synth-gateway-error");
      this.details = Object.freeze({ ...details });
    }
  }

  function safeInteger(value, label, min = 0) {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < min) throw new RangeError(`${label} must be a safe integer >= ${min}`);
    return result;
  }

  function instrumentIdFrom(event) {
    const value = Number(event?.data?.instrumentId);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
  }

  function getGatewayCreationSerial() {
    return gatewayCreationSerial;
  }

  function getGatewayCreatedAfter(serial) {
    const marker = safeInteger(serial, "gateway creation serial");
    return gatewayCreationSerial > marker ? lastCreatedGateway : null;
  }

  function createSynthGateway({ performerRegistry, sampleRate = 48000, maxEventsPerBlock = DEFAULT_MAX_EVENTS_PER_BLOCK } = {}) {
    if (!performerRegistry?.prepared || !performerRegistry?.forEachTrack) throw new TypeError("SynthGateway requires PerformerRegistry");
    const rate = Number(sampleRate);
    if (!Number.isFinite(rate) || rate <= 0) throw new RangeError("sampleRate must be positive");
    const eventCapacity = safeInteger(maxEventsPerBlock, "maxEventsPerBlock", 1);
    let blockStartFrame = 0;
    let frameCount = 0;
    let active = false;
    let eventCount = 0;
    let droppedUnavailableEvents = 0;
    let unavailableEventErrors = 0;
    let overrunCount = 0;
    let highWaterEvents = 0;

    function beginBlock(startFrame, actualFrameCount) {
      blockStartFrame = safeInteger(startFrame, "blockStartFrame");
      frameCount = safeInteger(actualFrameCount, "frameCount", 1);
      eventCount = 0;
      active = true;
      return frameCount;
    }

    function sampleOffsetFor(frame) {
      if (!active) throw new Error("SynthGateway block is not active");
      const absolute = safeInteger(frame, "event.frame");
      const offset = absolute - blockStartFrame;
      if (offset < 0 || offset >= frameCount) throw new RangeError(`event frame ${absolute} is outside active SynthGateway block ${blockStartFrame}..${blockStartFrame + frameCount - 1}`);
      return offset;
    }

    function blockOffset(value = 0, label = "sampleOffset") {
      if (!active) throw new Error("SynthGateway block is not active");
      const offset = safeInteger(value, label);
      if (offset >= frameCount) throw new RangeError(`${label} is outside active block`);
      return offset;
    }

    function reserveEvents(count) {
      const demand = safeInteger(count, "eventDemand");
      if (demand === 0) return eventCount;
      const next = eventCount + demand;
      if (next > eventCapacity) {
        overrunCount += 1;
        throw new RangeError(`SynthGateway event demand exceeded ${eventCapacity}`);
      }
      eventCount = next;
      if (eventCount > highWaterEvents) highWaterEvents = eventCount;
      return eventCount;
    }

    function actionForTraceEvent(event, sampleOffset) {
      const data = event?.data ?? {};
      const rawPitch = Number(data.note);
      const base = {
        sampleOffset,
        instrumentId: instrumentIdFrom(event),
        pitch: Number.isFinite(rawPitch) && rawPitch >= 0 ? Math.max(0, Math.min(127, rawPitch)) : null,
        velocity: Number.isFinite(Number(data.velocity)) ? Math.max(1, Math.min(127, Math.round(Number(data.velocity)))) : 100,
        source: event?.source ?? null,
      };
      if (event.kind === "note-release") return Object.freeze({ ...base, type: "note-off", release: true });
      if (event.kind === "note-trigger") return Object.freeze({ ...base, type: data.retrigger === true ? "retrigger" : "note-on", retrigger: data.retrigger === true, resetPhase: data.resetsPhase === true });
      return null;
    }

    function routeTracePacket(packet) {
      if (!active) throw new Error("SynthGateway block is not active");
      if (!packet || !Number.isSafeInteger(packet.frame) || !Array.isArray(packet.events)) throw new TypeError("SynthGateway requires a K4 event-trace packet");

      // Legacy/diagnostic K4 packet path. R2 normal playback uses the primitive
      // prepared lifecycle path below so musical routing does not require these
      // temporary delivery/action objects.
      const deliveries = [];
      let demand = 0;
      for (const event of packet.events) {
        const instrumentId = instrumentIdFrom(event);
        if (instrumentId === null || !["note-release", "note-trigger"].includes(event.kind)) continue;
        demand += 1;
        const action = actionForTraceEvent(event, sampleOffsetFor(event.frame));
        const slot = performerRegistry.prepared(event.track, instrumentId);
        deliveries.push(Object.freeze({ slot, action, track: event.track }));
      }

      const unavailable = deliveries.filter((delivery) => !delivery.slot).map((delivery) => Object.freeze({
        track: delivery.track,
        instrumentId: delivery.action.instrumentId,
        type: delivery.action.type,
      }));
      if (unavailable.length > 0) {
        unavailableEventErrors += unavailable.length;
        throw new SynthGatewayError("performer-unavailable", `SynthGateway refused ${unavailable.length} event(s) for unavailable Track × Instrument performers`, { unavailable: Object.freeze(unavailable) });
      }
      reserveEvents(demand);
      for (const delivery of deliveries) delivery.slot.performer.handleEvent(delivery.action);
      return eventCount;
    }

    function preparedSlot(track, instrumentId, type) {
      const normalizedTrack = safeInteger(track, "prepared lifecycle track");
      const normalizedInstrument = safeInteger(instrumentId, "prepared lifecycle instrumentId");
      if (normalizedInstrument > 255) throw new RangeError("prepared lifecycle instrumentId must be 00–FF");
      const slot = performerRegistry.prepared(normalizedTrack, normalizedInstrument);
      if (!slot) {
        unavailableEventErrors += 1;
        throw new SynthGatewayError("prepared-lifecycle-unavailable", `prepared lifecycle is unavailable for Track ${normalizedTrack} × Instrument ${normalizedInstrument}`, {
          track: normalizedTrack,
          instrumentId: normalizedInstrument,
          type,
        });
      }
      return slot;
    }

    function normalizedPreparedNote(pitch) {
      const note = Number(pitch);
      if (!Number.isFinite(note) || note < -2 || note > 127) throw new RangeError("prepared lifecycle pitch must be -2..127");
      return note;
    }

    function normalizedPreparedVelocity(velocity) {
      const rawVelocity = Number(velocity);
      return Number.isFinite(rawVelocity) ? Math.max(1, Math.min(127, Math.round(rawVelocity))) : 100;
    }

    function routePreparedLifecycle(frame, track, instrumentId, type, pitch, velocity = 100) {
      if (!active) throw new Error("SynthGateway block is not active");
      if (!PREPARED_LIFECYCLE_ACTIONS.has(type)) throw new RangeError(`unknown prepared lifecycle action ${type}`);
      const offset = sampleOffsetFor(frame);
      const slot = preparedSlot(track, instrumentId, type);
      if (typeof slot.performer?.preflightPreparedLifecycle !== "function" || typeof slot.performer?.handlePreparedLifecycle !== "function") {
        unavailableEventErrors += 1;
        throw new SynthGatewayError("prepared-lifecycle-unavailable", `prepared lifecycle performer does not expose primitive preflight/commit`, { track, instrumentId, type });
      }
      const note = normalizedPreparedNote(pitch);
      const normalizedVelocity = normalizedPreparedVelocity(velocity);

      // Performer capacity/ordering validation and gateway block budget both
      // finish before the performer queue mutates.
      slot.performer.preflightPreparedLifecycle(type, offset, note, normalizedVelocity);
      reserveEvents(1);
      slot.performer.handlePreparedLifecycle(type, offset, note, normalizedVelocity);
      return eventCount;
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
      if (!active) throw new Error("SynthGateway block is not active");
      const offset = sampleOffsetFor(frame);
      const releaseSlot = preparedSlot(track, releaseInstrumentId, "note-off");
      const triggerSlot = preparedSlot(track, triggerInstrumentId, "note-on");
      const releasePerformer = releaseSlot.performer;
      const triggerPerformer = triggerSlot.performer;
      if (typeof releasePerformer?.reservePreparedLifecyclePair !== "function"
        || typeof releasePerformer?.cancelPreparedLifecycleReservation !== "function"
        || typeof releasePerformer?.commitPreparedLifecycleReservation !== "function"
        || typeof triggerPerformer?.reservePreparedLifecyclePair !== "function"
        || typeof triggerPerformer?.cancelPreparedLifecycleReservation !== "function"
        || typeof triggerPerformer?.commitPreparedLifecycleReservation !== "function") {
        unavailableEventErrors += 1;
        throw new SynthGatewayError("prepared-lifecycle-pair-unavailable", "prepared lifecycle replacement requires reservation-capable performers", { track, releaseInstrumentId, triggerInstrumentId });
      }

      const releaseNote = normalizedPreparedNote(releasePitch);
      const releaseVelocityNormalized = normalizedPreparedVelocity(releaseVelocity);
      const triggerNote = normalizedPreparedNote(triggerPitch);
      const triggerVelocityNormalized = normalizedPreparedVelocity(triggerVelocity);
      let releaseToken = 0;
      let triggerToken = 0;
      const samePerformer = releasePerformer === triggerPerformer;

      // Phase 1: reserve performer capacity/order for every mutation. No
      // performer queue or Track owner has changed yet.
      if (samePerformer) {
        releaseToken = releasePerformer.reservePreparedLifecyclePair(
          "note-off", offset, releaseNote, releaseVelocityNormalized,
          "note-on", offset, triggerNote, triggerVelocityNormalized,
        );
      } else {
        releaseToken = releasePerformer.reservePreparedLifecyclePair(
          "note-off", offset, releaseNote, releaseVelocityNormalized,
        );
        try {
          triggerToken = triggerPerformer.reservePreparedLifecyclePair(
            "note-on", offset, triggerNote, triggerVelocityNormalized,
          );
        } catch (error) {
          releasePerformer.cancelPreparedLifecycleReservation(releaseToken);
          throw error;
        }
      }

      // Phase 2 starts only after every performer reservation succeeded. The
      // gateway budget is consumed for the pair in one bounded operation. If it
      // fails, all performer reservations are cancelled and nothing commits.
      try {
        reserveEvents(2);
      } catch (error) {
        if (samePerformer) {
          releasePerformer.cancelPreparedLifecycleReservation(releaseToken);
        } else {
          triggerPerformer.cancelPreparedLifecycleReservation(triggerToken);
          releasePerformer.cancelPreparedLifecycleReservation(releaseToken);
        }
        throw error;
      }

      // Successful reservations make these commits capacity/order-infallible.
      // Preserve deterministic musical order: addressable release first, then
      // replacement trigger. The BRK Synth C ABI remains unchanged and can keep
      // rendering the released voice's natural tail.
      if (samePerformer) {
        releasePerformer.commitPreparedLifecycleReservation(releaseToken);
      } else {
        releasePerformer.commitPreparedLifecycleReservation(releaseToken);
        triggerPerformer.commitPreparedLifecycleReservation(triggerToken);
      }
      return true;
    }

    function sendNote(track, instrumentId, type, pitch, velocity = 100, sampleOffset = 0, source = null) {
      if (!NOTE_ACTIONS.has(type)) throw new RangeError(`unknown synth note action ${type}`);
      const offset = blockOffset(sampleOffset);
      const slot = performerRegistry.prepared(track, instrumentId);
      if (!slot) return false;
      const note = Number(pitch);
      if (!Number.isFinite(note) || note < 0 || note > 127) throw new RangeError("pitch must be between 0 and 127");
      const rawVelocity = Number(velocity);
      const normalizedVelocity = Number.isFinite(rawVelocity) ? Math.max(1, Math.min(127, Math.round(rawVelocity))) : 100;
      reserveEvents(1);
      slot.performer.handleEvent(Object.freeze({
        type,
        sampleOffset: offset,
        instrumentId,
        pitch: note,
        velocity: normalizedVelocity,
        source,
      }));
      return true;
    }

    function noteOn(track, instrumentId, pitch, velocity = 100, sampleOffset = 0, source = null) {
      return sendNote(track, instrumentId, "note-on", pitch, velocity, sampleOffset, source);
    }

    function noteOff(track, instrumentId, pitch, sampleOffset = 0, source = null) {
      return sendNote(track, instrumentId, "note-off", pitch, 1, sampleOffset, source);
    }

    function applyParameter(track, instrumentId, parameterId, value, sampleOffset = 0, rampFrames = 0) {
      const offset = blockOffset(sampleOffset);
      const slot = performerRegistry.prepared(track, instrumentId);
      if (!slot) return false;
      const id = String(parameterId ?? "").trim();
      if (!id) throw new TypeError("stable parameter id is required");
      const descriptor = slot.engine.manifest.parameters.find((candidate) => candidate.id === id);
      if (!descriptor) throw new RangeError(`unknown stable parameter id ${id}`);
      const ramp = safeInteger(rampFrames, "rampFrames");
      reserveEvents(1);
      slot.performer.handleEvent(Object.freeze({
        type: "parameter",
        sampleOffset: offset,
        instrumentId,
        parameterId: id,
        value,
        rampFrames: ramp,
      }));
      return true;
    }

    function sendControl(track, instrumentId, type, sampleOffset = 0) {
      if (!CONTROL_ACTIONS.has(type)) throw new RangeError(`unknown synth control action ${type}`);
      const offset = blockOffset(sampleOffset);
      const slot = performerRegistry.prepared(track, instrumentId);
      if (!slot) return false;
      reserveEvents(1);
      slot.performer.handleEvent(Object.freeze({ type, sampleOffset: offset, instrumentId }));
      return true;
    }

    function kill(track, instrumentId, sampleOffset = 0) {
      return sendControl(track, instrumentId, "kill", sampleOffset);
    }

    function deliverTrackControl(track, type, sampleOffset = 0) {
      const offset = blockOffset(sampleOffset);
      const slots = [];
      performerRegistry.forEachTrack(track, (slot) => slots.push(slot));
      reserveEvents(slots.length);
      for (const slot of slots) {
        slot.performer.handleEvent(Object.freeze({ type, sampleOffset: offset, instrumentId: slot.instrumentId }));
      }
      return slots.length;
    }

    function allNotesOff(track, instrumentId = null, sampleOffset = 0) {
      if (instrumentId !== null && instrumentId !== undefined) return sendControl(track, instrumentId, "all-notes-off", sampleOffset);
      return deliverTrackControl(track, "all-notes-off", sampleOffset);
    }

    function reset(track, instrumentId = null, sampleOffset = 0) {
      if (instrumentId !== null && instrumentId !== undefined) return sendControl(track, instrumentId, "reset", sampleOffset);
      return deliverTrackControl(track, "reset", sampleOffset);
    }

    function applyInstrumentState(track, instrumentId, instrument) {
      if (active) throw new Error("patch/state updates must be applied at a safe boundary outside an active render block");
      return performerRegistry.applyState(track, instrumentId, instrument);
    }

    function renderTrack(track, left, right, actualFrameCount = frameCount) {
      if (!active) throw new Error("SynthGateway block is not active");
      const frames = safeInteger(actualFrameCount, "actualFrameCount", 1);
      if (frames !== frameCount) throw new RangeError("renderTrack frame count must match beginBlock frame count");
      if (!left || !right || left.length < frames || right.length < frames) throw new RangeError("dry Track buffers are smaller than the active frame count");
      for (let frame = 0; frame < frames; frame += 1) { left[frame] = 0; right[frame] = 0; }
      performerRegistry.forEachTrack(track, (slot) => {
        slot.performer.process(Object.freeze({ sampleRate: rate, frameCount: frames, left, right, accumulate: true }));
      });
      return true;
    }

    function endBlock() {
      active = false;
      return eventCount;
    }

    function diagnostics() {
      return Object.freeze({
        maxEventsPerBlock: eventCapacity,
        eventCount,
        highWaterEvents,
        droppedUnavailableEvents,
        unavailableEventErrors,
        overrunCount,
        performer: performerRegistry.diagnostics?.() ?? null,
      });
    }

    const gateway = Object.freeze({
      beginBlock,
      routeTracePacket,
      routePreparedLifecycle,
      routePreparedLifecyclePair,
      noteOn,
      noteOff,
      applyParameter,
      kill,
      allNotesOff,
      reset,
      applyInstrumentState,
      renderTrack,
      endBlock,
      diagnostics,
    });
    lastCreatedGateway = gateway;
    gatewayCreationSerial += 1;
    return gateway;
  }

  const api = Object.freeze({
    DEFAULT_MAX_EVENTS_PER_BLOCK,
    CONTROL_ACTIONS,
    NOTE_ACTIONS,
    PREPARED_LIFECYCLE_ACTIONS,
    SynthGatewayError,
    instrumentIdFrom,
    getGatewayCreationSerial,
    getGatewayCreatedAfter,
    createSynthGateway,
  });
  globalThis.BRKTRKSynthGatewayDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
