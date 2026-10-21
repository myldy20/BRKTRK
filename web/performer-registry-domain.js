(() => {
  "use strict";

  const DEFAULT_TRACK_COUNT = 8;
  const INSTRUMENT_COUNT = 256;

  function integer(value, label, min, max) {
    const result = Number(value);
    if (!Number.isInteger(result) || result < min || result > max) throw new RangeError(`${label} must be between ${min} and ${max}`);
    return result;
  }

  function createPerformerRegistry({ engineRegistry, trackCount = DEFAULT_TRACK_COUNT, instrumentProvider, assetProvider = null, sampleRate = 48000 } = {}) {
    if (!engineRegistry?.resolve) throw new TypeError("PerformerRegistry requires EngineRegistry");
    if (typeof instrumentProvider !== "function") throw new TypeError("PerformerRegistry requires instrumentProvider(id)");
    if (assetProvider != null && typeof assetProvider !== "function") throw new TypeError("PerformerRegistry assetProvider must be a function when provided");
    const tracks = integer(trackCount, "trackCount", 1, 64);
    const slots = new Array(tracks * INSTRUMENT_COUNT).fill(null);
    const statuses = new Array(tracks * INSTRUMENT_COUNT).fill(null);
    let preparedCount = 0;
    let activePreparedCount = 0;
    let destroyedCount = 0;
    let unavailableCount = 0;
    let prepareFailureCount = 0;

    const indexFor = (track, instrumentId) => integer(track, "track", 0, tracks - 1) * INSTRUMENT_COUNT
      + integer(instrumentId, "instrumentId", 0, INSTRUMENT_COUNT - 1);

    function engineRecord(instrumentId) {
      const id = integer(instrumentId, "instrumentId", 0, INSTRUMENT_COUNT - 1);
      const instrument = instrumentProvider(id);
      return instrument ? engineRegistry.resolve(instrument.engineRef) : null;
    }

    function prepare(track, instrumentId) {
      const index = indexFor(track, instrumentId);
      if (slots[index]) return slots[index];
      const instrument = instrumentProvider(instrumentId);
      if (!instrument) {
        statuses[index] = Object.freeze({ state: "missing-instrument", track, instrumentId });
        unavailableCount += 1;
        return null;
      }
      const record = engineRecord(instrumentId);
      if (!record) {
        statuses[index] = Object.freeze({ state: "missing-engine", track, instrumentId, engineRef: instrument.engineRef });
        unavailableCount += 1;
        return null;
      }
      try {
        const performer = record.factory(Object.freeze({
          track,
          instrumentId,
          sampleRate,
          patchState: instrument.patchState,
          parameterSnapshot: instrument.parameterSnapshot,
          assetRef: instrument.assetRef ?? null,
          asset: instrument.assetRef && assetProvider ? assetProvider(instrument.assetRef) : null,
          manifest: record.manifest,
        }));
        if (!performer || typeof performer !== "object" || typeof performer.process !== "function" || typeof performer.handleEvent !== "function") {
          throw new TypeError("engine performer must expose handleEvent(action) and process(context)");
        }
        const slot = Object.freeze({ track, instrumentId, performer, engine: record, instrument });
        slots[index] = slot;
        statuses[index] = Object.freeze({ state: "ready", track, instrumentId, engineRef: instrument.engineRef });
        preparedCount += 1;
        activePreparedCount += 1;
        return slot;
      } catch (error) {
        statuses[index] = Object.freeze({
          state: "prepare-failed",
          track,
          instrumentId,
          engineRef: instrument.engineRef,
          code: error?.code ?? "performer-prepare-failed",
          message: String(error?.message ?? error),
          details: error?.details ?? null,
        });
        prepareFailureCount += 1;
        unavailableCount += 1;
        return null;
      }
    }

    function prepared(track, instrumentId) {
      return slots[indexFor(track, instrumentId)];
    }

    function status(track, instrumentId) {
      return statuses[indexFor(track, instrumentId)];
    }

    function destroy(track, instrumentId) {
      const index = indexFor(track, instrumentId);
      const slot = slots[index];
      if (!slot) return false;
      try {
        if (typeof slot.performer.destroy === "function") slot.performer.destroy();
        else if (typeof slot.performer.reset === "function") slot.performer.reset();
      } finally {
        slots[index] = null;
        statuses[index] = Object.freeze({ state: "destroyed", track, instrumentId, engineRef: slot.instrument?.engineRef ?? null });
        activePreparedCount = Math.max(0, activePreparedCount - 1);
        destroyedCount += 1;
      }
      return true;
    }

    function forEachTrack(track, visit) {
      const normalizedTrack = integer(track, "track", 0, tracks - 1);
      const start = normalizedTrack * INSTRUMENT_COUNT;
      for (let instrumentId = 0; instrumentId < INSTRUMENT_COUNT; instrumentId += 1) {
        const slot = slots[start + instrumentId];
        if (slot) visit(slot);
      }
    }

    function applyState(track, instrumentId, instrument) {
      const slot = prepared(track, instrumentId);
      if (!slot) return false;
      if (typeof slot.performer.applyState !== "function") return true;
      slot.performer.applyState(Object.freeze({
        patchState: instrument?.patchState ?? slot.instrument.patchState,
        parameterSnapshot: instrument?.parameterSnapshot ?? slot.instrument.parameterSnapshot,
      }));
      return true;
    }

    function releaseAll() {
      for (const slot of slots) if (slot && typeof slot.performer.reset === "function") slot.performer.reset();
    }

    function diagnostics() {
      const activeSlots = [];
      for (const slot of slots) {
        if (!slot) continue;
        activeSlots.push(Object.freeze({
          track: slot.track,
          instrumentId: slot.instrumentId,
          moduleId: slot.engine.manifest.moduleId,
          engineId: slot.engine.manifest.engineId,
          version: slot.engine.manifest.version,
          performer: slot.performer.diagnostics?.() ?? null,
        }));
      }
      return Object.freeze({
        trackCount: tracks,
        slotCapacity: slots.length,
        preparedCount,
        activePreparedCount,
        destroyedCount,
        unavailableCount,
        prepareFailureCount,
        activeSlots: Object.freeze(activeSlots),
      });
    }

    return Object.freeze({ trackCount: tracks, instrumentCount: INSTRUMENT_COUNT, engineRecord, prepare, prepared, status, destroy, forEachTrack, applyState, releaseAll, diagnostics });
  }

  const api = Object.freeze({ DEFAULT_TRACK_COUNT, INSTRUMENT_COUNT, createPerformerRegistry });
  globalThis.BRKTRKPerformerRegistryDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
