(() => {
  "use strict";

  const baseDomain = globalThis.BRKTRKProductionAudioRuntime
    ?? (typeof module !== "undefined" && module.exports ? require("./production-audio-runtime.js") : null);
  if (!baseDomain?.createProductionAudioRuntime) {
    throw new Error("Track note-owner extension requires ProductionAudioRuntime");
  }

  const MAX_TRACKS = 64;

  function createProductionAudioRuntime(options = {}) {
    const base = baseDomain.createProductionAudioRuntime(options);
    const requestedTracks = Number(options.trackCount ?? baseDomain.DEFAULT_TRACK_COUNT ?? 8);
    const trackCount = Math.max(1, Math.min(MAX_TRACKS, Math.round(requestedTracks)));
    const activeInstrument = new Int16Array(trackCount);
    const activePitch = new Float64Array(trackCount);
    const activeVelocity = new Uint8Array(trackCount);
    activeInstrument.fill(-1);
    activePitch.fill(-1);
    activeVelocity.fill(100);
    let replacements = 0;
    let releases = 0;

    function normalizedTrack(track) {
      const value = Number(track);
      if (!Number.isInteger(value) || value < 0 || value >= trackCount) {
        throw new RangeError(`production Track note owner must be 0..${trackCount - 1}`);
      }
      return value;
    }

    function normalizedVelocity(velocity) {
      return Number.isFinite(Number(velocity))
        ? Math.max(1, Math.min(127, Math.round(Number(velocity))))
        : 100;
    }

    function clearTrack(track) {
      activeInstrument[track] = -1;
      activePitch[track] = -1;
      activeVelocity[track] = 100;
    }

    function clearAll() {
      activeInstrument.fill(-1);
      activePitch.fill(-1);
      activeVelocity.fill(100);
    }

    function releaseActive(frame, track) {
      const instrumentId = activeInstrument[track];
      if (instrumentId < 0) return false;
      const delivered = base.routePreparedLifecycle(
        frame,
        track,
        instrumentId,
        "note-off",
        activePitch[track],
        activeVelocity[track],
      ) === true;
      if (delivered) {
        releases += 1;
        clearTrack(track);
      }
      return delivered;
    }

    function routePreparedLifecycle(frame, track, instrumentId, type, note, velocity = 100) {
      const normalized = normalizedTrack(track);
      if (type === "note-off") return releaseActive(frame, normalized);
      if (type === "retrigger") {
        const owner = activeInstrument[normalized];
        if (owner < 0) return false;
        return base.routePreparedLifecycle(
          frame,
          normalized,
          owner,
          "retrigger",
          activePitch[normalized],
          activeVelocity[normalized],
        ) === true;
      }
      if (type !== "note-on") {
        return base.routePreparedLifecycle(frame, normalized, instrumentId, type, note, velocity);
      }

      const nextInstrument = Number(instrumentId);
      const nextPitch = Number(note);
      const nextVelocity = normalizedVelocity(velocity);
      const previous = activeInstrument[normalized];
      if (previous >= 0) {
        // Replacement is a single bounded transaction above the existing BRK
        // Synth C ABI. SynthGateway reserves both performer capacities/order
        // and both gateway event slots before either lifecycle event commits.
        const delivered = base.routePreparedLifecyclePair(
          frame,
          normalized,
          previous,
          activePitch[normalized],
          activeVelocity[normalized],
          nextInstrument,
          nextPitch,
          nextVelocity,
        ) === true;
        if (!delivered) return false;
        releases += 1;
        replacements += 1;
        activeInstrument[normalized] = nextInstrument;
        activePitch[normalized] = nextPitch;
        activeVelocity[normalized] = nextVelocity;
        return true;
      }

      const delivered = base.routePreparedLifecycle(frame, normalized, nextInstrument, "note-on", nextPitch, nextVelocity) === true;
      if (!delivered) return false;
      activeInstrument[normalized] = nextInstrument;
      activePitch[normalized] = nextPitch;
      activeVelocity[normalized] = nextVelocity;
      return true;
    }

    function routeTracePacket(packet) {
      if (!packet?.events) return new Set();
      const consumed = new Set();
      for (const event of packet.events) {
        const track = Number(event?.track);
        const instrumentId = Number(event?.data?.instrumentId);
        const hasProductionInstrument = Number.isInteger(instrumentId) && base.hasInstrument(instrumentId);
        if (event.kind === "parameter") {
          if (hasProductionInstrument) consumed.add(event.ordinal);
          continue;
        }
        if (event.kind === "note-release") {
          if (Number.isInteger(track) && track >= 0 && track < trackCount && activeInstrument[track] >= 0) {
            routePreparedLifecycle(event.frame, track, activeInstrument[track], "note-off", event?.data?.note, event?.data?.velocity);
            consumed.add(event.ordinal);
          } else if (hasProductionInstrument) {
            consumed.add(event.ordinal);
          }
          continue;
        }
        if (event.kind !== "note-trigger" || !hasProductionInstrument) continue;
        routePreparedLifecycle(
          event.frame,
          track,
          instrumentId,
          event?.data?.retrigger === true ? "retrigger" : "note-on",
          event?.data?.note,
          event?.data?.velocity,
        );
        consumed.add(event.ordinal);
      }
      return consumed;
    }

    function prepareProgram(program) {
      const result = base.prepareProgram(program);
      const slots = base.diagnostics()?.performers?.activeSlots ?? [];
      for (let track = 0; track < trackCount; track += 1) {
        const owner = activeInstrument[track];
        if (owner < 0) continue;
        let stillPrepared = false;
        for (let index = 0; index < slots.length; index += 1) {
          if (slots[index]?.track === track && slots[index]?.instrumentId === owner) {
            stillPrepared = true;
            break;
          }
        }
        if (!stillPrepared) clearTrack(track);
      }
      return result;
    }

    function stop(...args) {
      try { return base.stop(...args); }
      finally { clearAll(); }
    }

    function diagnostics() {
      const snapshot = base.diagnostics();
      const owners = [];
      for (let track = 0; track < trackCount; track += 1) {
        if (activeInstrument[track] < 0) continue;
        owners.push(Object.freeze({
          track,
          instrumentId: activeInstrument[track],
          note: activePitch[track],
          velocity: activeVelocity[track],
        }));
      }
      return Object.freeze({
        ...snapshot,
        trackNoteOwnership: Object.freeze({
          active: Object.freeze(owners),
          replacements,
          releases,
        }),
      });
    }

    return Object.freeze({
      ...base,
      prepareProgram,
      routeTracePacket,
      routePreparedLifecycle,
      stop,
      diagnostics,
    });
  }

  globalThis.BRKTRKProductionAudioRuntime = Object.freeze({
    ...baseDomain,
    createProductionAudioRuntime,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.BRKTRKProductionAudioRuntime;
})();
