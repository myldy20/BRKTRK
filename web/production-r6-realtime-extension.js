(() => {
  "use strict";

  const baseDomain = globalThis.BRKTRKProductionAudioRuntime;
  const gatewayDomain = globalThis.BRKTRKSynthGatewayDomain;
  if (!baseDomain?.createProductionAudioRuntime || !gatewayDomain?.getGatewayCreatedAfter) {
    throw new Error("R6 production runtime extension requires ProductionAudioRuntime + R6 SynthGateway");
  }

  const MAX_PENDING_PARAMETERS = baseDomain.MAX_PENDING_PARAMETERS ?? 4096;
  const DEFAULT_TRACK_COUNT = baseDomain.DEFAULT_TRACK_COUNT ?? 8;
  const isProductionInstrument = (instrument) => Boolean(instrument?.engineRef?.moduleId && instrument?.engineRef?.engineId);
  const engineIdentity = (instrument) => {
    const ref = instrument?.engineRef ?? {};
    return [
      ref.moduleId,
      ref.engineId,
      ref.resolvedVersion ?? ref.requestedVersion,
      ref.resolvedPackageSha256 ?? ref.packageSha256,
    ].map((value) => String(value ?? "").trim().toLowerCase()).join("\u0000");
  };
  const sameEngineIdentity = (left, right) => isProductionInstrument(left)
    && isProductionInstrument(right)
    && engineIdentity(left) === engineIdentity(right);

  function createProductionAudioRuntime(options = {}) {
    const postMessage = typeof options.postMessage === "function" ? options.postMessage : () => {};
    const tracks = Math.max(1, Math.round(Number(options.trackCount ?? DEFAULT_TRACK_COUNT)));
    const serialBefore = Number(gatewayDomain.getGatewayCreationSerial?.() ?? 0);
    const runtime = baseDomain.createProductionAudioRuntime(options);
    let gateway = gatewayDomain.getGatewayCreatedAfter(serialBefore);
    if (!gateway?.applyPreparedParameter || !gateway?.resolveParameterHandle) {
      throw new Error("R6 production runtime could not capture the primitive SynthGateway");
    }

    const slotByKey = new Map();
    const slotInstrument = new Uint16Array(MAX_PENDING_PARAMETERS);
    const slotParameterId = new Array(MAX_PENDING_PARAMETERS).fill(null);
    const slotValue = new Float64Array(MAX_PENDING_PARAMETERS);
    const slotRamp = new Uint32Array(MAX_PENDING_PARAMETERS);
    const slotDirty = new Uint8Array(MAX_PENDING_PARAMETERS);
    const pendingOrder = new Uint16Array(MAX_PENDING_PARAMETERS);
    const promotedActiveInstrument = new Uint8Array(256);
    const handlesByTrack = Array.from({ length: tracks }, () => {
      const values = new Int32Array(MAX_PENDING_PARAMETERS);
      values.fill(-1);
      return values;
    });
    let slotCount = 0;
    let pendingCount = 0;
    let activeSnapshot = null;
    let deferredSnapshot = null;
    let liveParameterUpdates = 0;
    let liveParameterCoalescedUpdates = 0;
    let liveParameterDeliveries = 0;
    let slotRebuilds = 0;
    let handleResolutions = 0;
    let promotedActiveSnapshotAdditions = 0;
    let lastLiveParameter = null;

    function refreshGateway() {
      const latest = gatewayDomain.getGatewayCreatedAfter(0);
      if (latest) gateway = latest;
      return gateway;
    }

    function keyFor(instrumentId, parameterId) {
      return `${instrumentId}\u0000${parameterId}`;
    }

    function ensureSlot(instrumentId, parameterId) {
      const key = keyFor(instrumentId, parameterId);
      const existing = slotByKey.get(key);
      if (existing !== undefined) return existing;
      if (slotCount >= MAX_PENDING_PARAMETERS) throw new RangeError(`production live parameter slots exceeded ${MAX_PENDING_PARAMETERS}`);
      const index = slotCount;
      slotCount += 1;
      slotByKey.set(key, index);
      slotInstrument[index] = instrumentId;
      slotParameterId[index] = parameterId;
      for (let track = 0; track < tracks; track += 1) handlesByTrack[track][index] = -1;
      return index;
    }

    function installInstrumentSlots(instrumentId, instrument) {
      if (!isProductionInstrument(instrument)) return 0;
      let installed = 0;
      for (const [parameterIdRaw, valueRaw] of Object.entries(instrument.parameterSnapshot ?? {})) {
        const parameterId = String(parameterIdRaw).trim();
        if (!parameterId) continue;
        const key = keyFor(instrumentId, parameterId);
        const existed = slotByKey.has(key);
        const index = ensureSlot(instrumentId, parameterId);
        const numeric = Number(valueRaw);
        slotValue[index] = Number.isFinite(numeric) ? numeric : 0;
        if (!existed) installed += 1;
      }
      return installed;
    }

    function markDirty(index) {
      if (slotDirty[index]) {
        liveParameterCoalescedUpdates += 1;
        return false;
      }
      if (pendingCount >= MAX_PENDING_PARAMETERS) throw new RangeError(`production live parameter pending order exceeded ${MAX_PENDING_PARAMETERS}`);
      slotDirty[index] = 1;
      pendingOrder[pendingCount] = index;
      pendingCount += 1;
      return true;
    }

    function clearPending() {
      for (let order = 0; order < pendingCount; order += 1) slotDirty[pendingOrder[order]] = 0;
      pendingCount = 0;
    }

    function resetSlotsFromSnapshot(snapshot) {
      slotByKey.clear();
      slotParameterId.fill(null);
      slotValue.fill(0);
      slotRamp.fill(0);
      slotDirty.fill(0);
      promotedActiveInstrument.fill(0);
      pendingCount = 0;
      slotCount = 0;
      for (let track = 0; track < tracks; track += 1) handlesByTrack[track].fill(-1);
      for (const [idText, instrument] of Object.entries(snapshot && typeof snapshot === "object" ? snapshot : {})) {
        const instrumentId = Number(idText);
        if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255 || !isProductionInstrument(instrument)) continue;
        installInstrumentSlots(instrumentId, instrument);
      }
      slotRebuilds += 1;
    }

    function promoteAddressableAdditions(snapshot) {
      const current = activeSnapshot && typeof activeSnapshot === "object" ? activeSnapshot : {};
      let next = null;
      let promoted = 0;
      for (const [idText, instrument] of Object.entries(snapshot && typeof snapshot === "object" ? snapshot : {})) {
        const instrumentId = Number(idText);
        if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255 || !isProductionInstrument(instrument)) continue;
        const currentInstrument = current[instrumentId];
        if (isProductionInstrument(currentInstrument)) {
          if (!sameEngineIdentity(currentInstrument, instrument)) promotedActiveInstrument[instrumentId] = 0;
          continue;
        }
        if (!runtime.hasInstrument?.(instrumentId)) continue;
        next ??= { ...current };
        next[instrumentId] = instrument;
        promotedActiveInstrument[instrumentId] = 1;
        installInstrumentSlots(instrumentId, instrument);
        promoted += 1;
      }
      if (next) activeSnapshot = next;
      promotedActiveSnapshotAdditions += promoted;
      return promoted;
    }

    function mutateSnapshotParameter(snapshot, instrumentId, parameterId, value) {
      const instrument = snapshot?.[instrumentId];
      if (!isProductionInstrument(instrument)) return false;
      instrument.parameterSnapshot ??= {};
      instrument.parameterSnapshot[parameterId] = value;
      return true;
    }

    function configureInstruments(snapshot) {
      const applied = runtime.configureInstruments(snapshot);
      if (applied) {
        activeSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
        deferredSnapshot = null;
        resetSlotsFromSnapshot(activeSnapshot);
        refreshGateway();
      } else {
        deferredSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
        // The primitive runtime may safely promote additions whose exact engine
        // already exists in the transport-owned registry. Mirror only those
        // now-addressable Instruments into the realtime parameter view; a
        // genuinely new engine stays exclusively in deferredSnapshot until STOP.
        promoteAddressableAdditions(deferredSnapshot);
      }
      return applied;
    }

    function resolveSlotHandles(index) {
      const instrumentId = slotInstrument[index];
      const parameterId = slotParameterId[index];
      for (let track = 0; track < tracks; track += 1) {
        const handle = Number(gateway.resolveParameterHandle(track, instrumentId, parameterId));
        handlesByTrack[track][index] = Number.isSafeInteger(handle) && handle >= 0 ? handle : -1;
        if (handle >= 0) handleResolutions += 1;
      }
    }

    function queueParameter(input = {}) {
      const instrumentId = Number(input.instrumentId);
      const parameterId = String(input.parameterId ?? "").trim();
      const rampFrames = Math.max(0, Math.round(Number(input.rampFrames) || 0));
      if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255) throw new RangeError("production parameter instrumentId must be 00–FF");
      if (!parameterId) throw new TypeError("production parameter requires a stable parameterId");
      const activeInstrument = activeSnapshot?.[instrumentId];
      const deferredInstrument = deferredSnapshot?.[instrumentId];
      if (!isProductionInstrument(activeInstrument) && !isProductionInstrument(deferredInstrument)) return false;
      const numeric = Number(input.value);
      const value = Number.isFinite(numeric) ? numeric : 0;
      mutateSnapshotParameter(activeSnapshot, instrumentId, parameterId, value);
      mutateSnapshotParameter(deferredSnapshot, instrumentId, parameterId, value);
      const key = keyFor(instrumentId, parameterId);
      const existed = slotByKey.has(key);
      const index = ensureSlot(instrumentId, parameterId);
      // A promoted Instrument can receive its first edit after the safe program
      // reprepare even when that parameter was not persisted in the snapshot.
      // Resolve only for IDs proven promoted into the active registry; a normal
      // deferred replacement must never gain a handle against the old performer.
      if (!existed && promotedActiveInstrument[instrumentId]) {
        refreshGateway();
        resolveSlotHandles(index);
      }
      slotValue[index] = value;
      slotRamp[index] = rampFrames;
      markDirty(index);
      liveParameterUpdates += 1;
      lastLiveParameter = Object.freeze({ instrumentId, parameterId, value, rampFrames });
      return true;
    }

    function instrumentParameterValue(instrumentId, parameterId) {
      const id = Number(instrumentId);
      const key = String(parameterId ?? "").trim();
      if (Number.isInteger(id) && key) {
        const index = slotByKey.get(keyFor(id, key));
        if (index !== undefined) return slotValue[index];
      }
      return runtime.instrumentParameterValue(instrumentId, parameterId);
    }

    function resolveHandles() {
      refreshGateway();
      for (let track = 0; track < tracks; track += 1) handlesByTrack[track].fill(-1);
      for (let index = 0; index < slotCount; index += 1) resolveSlotHandles(index);
    }

    function markAllPreparedDirty() {
      for (let index = 0; index < slotCount; index += 1) {
        let prepared = false;
        for (let track = 0; track < tracks; track += 1) {
          if (handlesByTrack[track][index] >= 0) { prepared = true; break; }
        }
        if (prepared) markDirty(index);
      }
    }

    function prepareProgram(program) {
      const result = runtime.prepareProgram(program);
      resolveHandles();
      markAllPreparedDirty();
      return result;
    }

    function queueAudition(input = {}) {
      const result = runtime.queueAudition(input);
      resolveHandles();
      markAllPreparedDirty();
      return result;
    }

    function flushPendingParameters() {
      if (pendingCount === 0) return 0;
      let deliveries = 0;
      const count = pendingCount;
      for (let order = 0; order < count; order += 1) {
        const index = pendingOrder[order];
        const instrumentId = slotInstrument[index];
        const value = slotValue[index];
        const rampFrames = slotRamp[index];
        for (let track = 0; track < tracks; track += 1) {
          const handle = handlesByTrack[track][index];
          if (handle < 0) continue;
          if (gateway.applyPreparedParameter(track, instrumentId, handle, value, 0, rampFrames)) deliveries += 1;
        }
        slotDirty[index] = 0;
      }
      pendingCount = 0;
      liveParameterDeliveries += deliveries;
      return deliveries;
    }

    function beginBlock(startFrame, frameCount) {
      const result = runtime.beginBlock(startFrame, frameCount);
      flushPendingParameters();
      return result;
    }

    function stop() {
      const pendingStructural = deferredSnapshot;
      const result = runtime.stop();
      clearPending();
      for (let track = 0; track < tracks; track += 1) handlesByTrack[track].fill(-1);
      if (pendingStructural) {
        activeSnapshot = pendingStructural;
        deferredSnapshot = null;
        resetSlotsFromSnapshot(activeSnapshot);
      }
      refreshGateway();
      return result;
    }

    function diagnostics() {
      const base = runtime.diagnostics();
      return Object.freeze({
        ...base,
        pendingLiveParameters: pendingCount,
        liveParameterUpdates,
        liveParameterCoalescedUpdates,
        liveParameterDeliveries,
        traffic: Object.freeze({
          ...(base.traffic ?? {}),
          liveParameterUpdates,
          liveParameterCoalescedUpdates,
          liveParameterDeliveries,
          lastLiveParameter,
        }),
        r6Realtime: Object.freeze({
          fixedParameterSlots: true,
          slotCapacity: MAX_PENDING_PARAMETERS,
          slotCount,
          pendingCount,
          slotRebuilds,
          handleResolutions,
          promotedActiveSnapshotAdditions,
        }),
      });
    }

    function postDiagnostics() {
      postMessage({ type: "production-diagnostics", snapshot: diagnostics() });
    }

    function handleMessage(data) {
      if (data?.type === "production-instruments") {
        configureInstruments(data.instruments);
        postDiagnostics();
        return true;
      }
      if (data?.type === "production-parameter") {
        try { queueParameter(data); }
        catch (error) {
          postMessage({ type: "production-engine-error", code: error?.code ?? "production-parameter-error", message: String(error?.message ?? error) });
        }
        return true;
      }
      if (data?.type === "production-audition") {
        try { queueAudition(data); postDiagnostics(); }
        catch (error) {
          postMessage({ type: "production-engine-error", code: error?.code ?? "production-audition-error", message: String(error?.message ?? error) });
        }
        return true;
      }
      if (data?.type === "production-diagnostics-request") {
        postDiagnostics();
        return true;
      }
      return runtime.handleMessage(data);
    }

    return Object.freeze({
      ...runtime,
      configureInstruments,
      queueParameter,
      instrumentParameterValue,
      prepareProgram,
      queueAudition,
      flushPendingParameters,
      beginBlock,
      stop,
      diagnostics,
      postDiagnostics,
      handleMessage,
    });
  }

  const api = Object.freeze({ ...baseDomain, createProductionAudioRuntime, R6_REALTIME_VERSION: 1 });
  globalThis.BRKTRKProductionAudioRuntime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();