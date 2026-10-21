(() => {
  "use strict";

  const engineRegistryDomain = globalThis.BRKTRKEngineRegistryDomain;
  const performerRegistryDomain = globalThis.BRKTRKPerformerRegistryDomain;
  const synthGatewayDomain = globalThis.BRKTRKSynthGatewayDomain;
  const abiRuntime = globalThis.BRKTRKBrkSynthAbiV1Runtime;
  const packageDomain = globalThis.BRKTRKEnginePackageDomain;
  const trackInsertFxDomain = globalThis.BRKTRKTrackInsertFxDomain
    ?? (typeof require !== "undefined" ? require("./track-insert-fx-domain.js") : null);
  if (!engineRegistryDomain || !performerRegistryDomain || !synthGatewayDomain || !abiRuntime || !packageDomain?.moduleInstanceCapability || !trackInsertFxDomain?.createChain) {
    throw new Error("BRKTRK production audio runtime requires A2 package/registries/gateway + BRK Synth ABI-v1 runtime + Track Insert FX domain");
  }

  const DEFAULT_TRACK_COUNT = 8;
  const MAX_BLOCK_FRAMES = abiRuntime.DEFAULT_MAX_BLOCK_FRAMES;
  const MAX_PENDING_PARAMETERS = 4096;
  const MAX_AUDITION_SECONDS = 2;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const isProductionInstrument = (instrument) => instrument?.engineRef?.moduleId && instrument?.engineRef?.engineId;

  class ProductionProgramError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "ProductionProgramError";
      this.code = String(code || "production-program-error");
      this.details = Object.freeze({ ...details });
    }
  }

  function programPairs(program, instruments, trackCount = DEFAULT_TRACK_COUNT) {
    const pairs = new Set();
    const accept = (track, instrumentId) => {
      if (instrumentId === null || instrumentId === undefined) return;
      if (typeof instrumentId === "string" && instrumentId.trim() === "") return;
      const id = Number(instrumentId);
      if (!Number.isInteger(track) || track < 0 || track >= trackCount || !Number.isInteger(id) || id < 0 || id > 255) return;
      if (!isProductionInstrument(instruments[id])) return;
      pairs.add(`${track}:${id}`);
    };
    if (program?.mode === "track-plan" || Array.isArray(program?.tracks)) {
      for (let track = 0; track < trackCount; track += 1) for (const event of Array.isArray(program?.tracks?.[track]?.events) ? program.tracks[track].events : []) accept(track, event?.instrumentId);
    } else {
      const steps = Array.isArray(program?.steps) ? program.steps : Array.isArray(program?.sequence) ? program.sequence : [];
      for (const step of steps) for (let track = 0; track < trackCount; track += 1) accept(track, step?.instrumentIds?.[track]);
    }
    return Object.freeze([...pairs].map((key) => key.split(":").map(Number)));
  }

  function createProductionAudioRuntime({ sampleRate = 48000, trackCount = DEFAULT_TRACK_COUNT, postMessage = () => {} } = {}) {
    const tracks = Math.max(1, Math.round(Number(trackCount)));
    const maxAuditionFrames = Math.max(1, Math.round(Number(sampleRate) * MAX_AUDITION_SECONDS));
    let instruments = {};
    let pendingInstruments = null;
    const assets = new Map();
    let transportActive = false;
    let blockActive = false;
    let blockFrames = 0;
    let blockStart = 0;
    let engineRegistry = null;
    let performerRegistry = null;
    let gateway = null;
    const trackLeft = Array.from({ length: tracks }, () => new Float32Array(MAX_BLOCK_FRAMES));
    const trackRight = Array.from({ length: tracks }, () => new Float32Array(MAX_BLOCK_FRAMES));
    const trackInsertChains = Array.from({ length: tracks }, () => trackInsertFxDomain.createChain(sampleRate));
    let trackInsertFx = trackInsertFxDomain.normalizeTracks([], tracks);
    const pendingParameters = new Map();
    const pendingAuditions = new Map();
    const activeAuditions = Array(tracks).fill(null);
    const auditionOwnedPairs = new Set();
    const programOwnedPairs = new Set();
    const retireAfterBlock = new Set();
    let preparedPairs = 0;
    let runtimeErrors = 0;
    // A render-path failure is caught by the processor, which stops transport
    // and outputs silence. Counting it here keeps the evidence in diagnostics:
    // before, the catch counted nothing and a snapshot taken after the stop
    // read healthy (#496 item 2).
    let renderFailures = 0;
    let lastRenderFailure = null;
    let liveParameterUpdates = 0;
    let liveParameterCoalescedUpdates = 0;
    let liveParameterDeliveries = 0;
    let instrumentSnapshotMessages = 0;
    let assetSnapshotMessages = 0;
    let assetRecordsAccepted = 0;
    let assetSyncRejections = 0;
    let trackInsertFxSnapshots = 0;
    let trackInsertFxUpdates = 0;
    let deferredInstrumentSnapshots = 0;
    let replacedDeferredInstrumentSnapshots = 0;
    let promotedDeferredInstrumentAdditions = 0;
    let lastLiveParameter = null;
    let auditionRequests = 0;
    let auditionStarts = 0;
    let auditionCompletions = 0;
    let auditionRejections = 0;
    let programPrepareFailures = 0;
    let programRetirements = 0;
    let programRetirementFailures = 0;
    let lastProgramPairCount = 0;
    let lastCapacityPlan = Object.freeze([]);
    let lastProgramError = null;
    let registeredRuntimeSignature = "";

    const pairKey = (track, instrumentId) => `${track}:${instrumentId}`;
    const pairFromKey = (key) => key.split(":").map(Number);
    const runtimeSignature = () => abiRuntime.runtimeRecords()
      .map((record) => `${record.key}\u0000${record.entry?.packageSha256 ?? ""}`)
      .sort()
      .join("\n");

    function postAudition(state, details = {}) {
      postMessage({ type: "production-audition", state, ...details });
    }

    function pairInUse(key) {
      const [track, instrumentId] = pairFromKey(key);
      return pendingAuditions.get(track)?.instrumentId === instrumentId || activeAuditions[track]?.instrumentId === instrumentId;
    }

    function destroyAuditionPairNow(key) {
      if (!auditionOwnedPairs.has(key)) return false;
      const [track, instrumentId] = pairFromKey(key);
      let destroyed = false;
      try { destroyed = Boolean(performerRegistry?.destroy?.(track, instrumentId)); }
      catch (error) {
        runtimeErrors += 1;
        postMessage({ type: "production-engine-error", track, message: String(error?.message ?? error), code: error?.code ?? "audition-performer-destroy-failed" });
      }
      auditionOwnedPairs.delete(key);
      retireAfterBlock.delete(key);
      return destroyed;
    }

    function retireAuditionPair(key) {
      if (!auditionOwnedPairs.has(key) || pairInUse(key)) return false;
      if (blockActive) {
        retireAfterBlock.add(key);
        return true;
      }
      return destroyAuditionPairNow(key);
    }

    function flushRetiredPerformers() {
      if (blockActive || retireAfterBlock.size === 0) return 0;
      let destroyed = 0;
      for (const key of [...retireAfterBlock]) {
        retireAfterBlock.delete(key);
        if (!auditionOwnedPairs.has(key) || pairInUse(key)) continue;
        if (destroyAuditionPairNow(key)) destroyed += 1;
      }
      return destroyed;
    }

    function destroyAllAuditionOwned() {
      if (blockActive) throw new Error("audition performers may only be destroyed outside an active render block");
      let destroyed = 0;
      retireAfterBlock.clear();
      for (const key of [...auditionOwnedPairs]) if (destroyAuditionPairNow(key)) destroyed += 1;
      return destroyed;
    }

    function clearAuditions(reason = "cleared") {
      const hadAudition = pendingAuditions.size > 0 || activeAuditions.some(Boolean);
      pendingAuditions.clear();
      for (let track = 0; track < activeAuditions.length; track += 1) activeAuditions[track] = null;
      if (hadAudition) postAudition("stopped", { reason });
      return hadAudition;
    }

    function disposePerformers() {
      if (!performerRegistry) return;
      for (let track = 0; track < tracks; track += 1) performerRegistry.forEachTrack(track, (slot) => { try { slot.performer?.destroy?.(); } catch {} });
      programOwnedPairs.clear();
    }

    function rebuildRegistries() {
      clearAuditions("registry-rebuild");
      disposePerformers();
      auditionOwnedPairs.clear();
      retireAfterBlock.clear();
      engineRegistry = engineRegistryDomain.createEngineRegistry({ abiVersions: ["0x00010000"] });
      for (const record of abiRuntime.runtimeRecords()) engineRegistry.register({ entry: record.entry, manifest: record.manifest }, abiRuntime.createPerformerFactory(record));
      performerRegistry = performerRegistryDomain.createPerformerRegistry({
        engineRegistry,
        trackCount: tracks,
        instrumentProvider: (id) => instruments[id] ?? null,
        assetProvider: (ref) => assets.get(String(ref?.sha256 ?? "").toLowerCase()) ?? null,
        sampleRate,
      });
      gateway = synthGatewayDomain.createSynthGateway({ performerRegistry, sampleRate });
      preparedPairs = 0;
      registeredRuntimeSignature = runtimeSignature();
    }

    function ensureRegistryFresh() {
      const current = runtimeSignature();
      if (gateway && current === registeredRuntimeSignature) return false;
      if (blockActive || transportActive) {
        throw new ProductionProgramError("engine-registry-refresh-boundary", "new verified engine runtimes may only enter the registry while transport is stopped and outside a render block", {
          registeredRuntimeSignature,
          currentRuntimeSignature: current,
        });
      }
      rebuildRegistries();
      return true;
    }

    function capacityPlanFor(pairs) {
      const groups = new Map();
      for (const [track, instrumentId] of pairs) {
        const instrument = instruments[instrumentId];
        const record = engineRegistry.resolve(instrument?.engineRef);
        if (!record) {
          throw new ProductionProgramError("production-engine-unavailable", `cannot prepare Track ${track} × Instrument ${instrumentId}: verified engine runtime is unavailable`, {
            track,
            instrumentId,
            engineRef: instrument?.engineRef ?? null,
          });
        }
        let group = groups.get(record.key);
        if (!group) {
          const capability = packageDomain.moduleInstanceCapability(record.manifest);
          group = { record, capability, pairs: [] };
          groups.set(record.key, group);
        }
        group.pairs.push(Object.freeze({ track, instrumentId }));
      }
      const plan = [...groups.values()].map(({ record, capability, pairs: required }) => Object.freeze({
        moduleId: record.manifest.moduleId,
        engineId: record.manifest.engineId,
        version: record.manifest.version,
        required: required.length,
        capacity: capability.capacity,
        capabilitySource: capability.source,
        capabilityExplicit: capability.explicit,
        pairs: Object.freeze(required),
      }));
      const exhausted = plan.find((group) => group.required > group.capacity);
      if (exhausted) {
        throw new ProductionProgramError("production-program-capacity", `${exhausted.moduleId}/${exhausted.engineId}@${exhausted.version} requires ${exhausted.required} independent performers but publishes capacity ${exhausted.capacity}`, exhausted);
      }
      return Object.freeze(plan);
    }

    function destroyProgramPairNow(key) {
      if (!programOwnedPairs.has(key)) return false;
      const [track, instrumentId] = pairFromKey(key);
      const slot = performerRegistry?.prepared?.(track, instrumentId);
      try { slot?.performer?.reset?.(); } catch {}
      let failed = false;
      try { performerRegistry?.destroy?.(track, instrumentId); }
      catch (error) {
        failed = true;
        runtimeErrors += 1;
        programRetirementFailures += 1;
        postMessage({
          type: "production-engine-error",
          track,
          instrumentId,
          code: error?.code ?? "program-performer-destroy-failed",
          message: String(error?.message ?? error),
          details: error?.details ?? null,
        });
      } finally {
        programOwnedPairs.delete(key);
      }
      const retired = !performerRegistry?.prepared?.(track, instrumentId);
      if (retired) programRetirements += 1;
      return retired && !failed;
    }

    function retireProgramPairsExcept(requiredKeys) {
      if (blockActive) throw new ProductionProgramError("program-retirement-boundary", "program performers may only be retired outside an active render block");
      let destroyed = 0;
      for (const key of [...programOwnedPairs]) if (!requiredKeys.has(key) && destroyProgramPairNow(key)) destroyed += 1;
      return destroyed;
    }

    function destroyAllProgramOwned() {
      return retireProgramPairsExcept(new Set());
    }

    function reportProgramError(error) {
      runtimeErrors += 1;
      programPrepareFailures += 1;
      lastProgramError = Object.freeze({ code: error?.code ?? "production-program-error", message: String(error?.message ?? error), details: error?.details ?? null });
      postMessage({ type: "production-engine-error", ...lastProgramError });
      postDiagnostics();
    }

    function normalizeAssetRecord(record) {
      const ref = record?.ref;
      const sha256 = String(ref?.sha256 ?? "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError("production asset requires lowercase SHA-256 ref");
      if (ref?.schema !== "brktrk-pcm-asset-ref-v1" || ref?.format !== "pcm-s16-interleaved") {
        throw new TypeError("production asset requires canonical PCM16 assetRef");
      }
      const sampleRateHz = Number(ref.sampleRateHz);
      const channelCount = Number(ref.channelCount);
      const frameCount = Number(ref.frameCount);
      const byteSize = Number(ref.byteSize);
      if (!Number.isInteger(sampleRateHz) || sampleRateHz < 1000 || sampleRateHz > 384000) throw new RangeError("production asset sample rate is invalid");
      if (channelCount !== 1 && channelCount !== 2) throw new RangeError("production asset channel count is invalid");
      if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new RangeError("production asset frame count is invalid");
      const raw = record?.pcmBytes;
      const bytes = raw instanceof Uint8Array ? raw
        : raw instanceof ArrayBuffer ? new Uint8Array(raw)
          : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
            : null;
      if (!bytes || byteSize !== frameCount * channelCount * 2 || bytes.byteLength !== byteSize) {
        throw new RangeError("production asset PCM bytes do not match assetRef");
      }
      return Object.freeze({
        ref: Object.freeze({ ...ref, sha256, sampleRateHz, channelCount, frameCount, byteSize }),
        pcmBytes: new Uint8Array(bytes),
      });
    }

    function configureAssets(records) {
      assetSnapshotMessages += 1;
      if (transportActive || blockActive) {
        assetSyncRejections += 1;
        throw new ProductionProgramError("asset-sync-boundary", "sample assets may only synchronize while transport is stopped and outside a render block");
      }
      const next = new Map();
      const input = Array.isArray(records) ? records : [];
      for (const raw of input) {
        const record = normalizeAssetRecord(raw);
        if (next.has(record.ref.sha256)) throw new ProductionProgramError("duplicate-asset", `duplicate sample asset ${record.ref.sha256}`);
        next.set(record.ref.sha256, record);
      }
      assets.clear();
      for (const [sha, record] of next) assets.set(sha, record);
      assetRecordsAccepted += next.size;
      rebuildRegistries();
      return assets.size;
    }

    function applyInstrumentSnapshot(snapshot) {
      instruments = {};
      for (const [idText, instrument] of Object.entries(snapshot && typeof snapshot === "object" ? snapshot : {})) {
        const id = Number(idText);
        if (Number.isInteger(id) && id >= 0 && id <= 255 && isProductionInstrument(instrument)) instruments[id] = clone(instrument);
      }
      rebuildRegistries();
    }

    function promoteCompatibleInstrumentAdditions(snapshot) {
      if (blockActive || !engineRegistry) return 0;
      let promoted = 0;
      for (const [idText, candidate] of Object.entries(snapshot && typeof snapshot === "object" ? snapshot : {})) {
        const id = Number(idText);
        if (!Number.isInteger(id) || id < 0 || id > 255 || !isProductionInstrument(candidate) || isProductionInstrument(instruments[id])) continue;
        if (!engineRegistry.resolve(candidate.engineRef)) continue;
        instruments[id] = clone(candidate);
        promoted += 1;
      }
      return promoted;
    }

    function configureTrackInsertFx(snapshot) {
      if (blockActive) {
        throw new ProductionProgramError("track-insert-fx-boundary", "Track Insert FX snapshots may only synchronize outside an active render block");
      }
      const next = trackInsertFxDomain.normalizeTracks(snapshot, tracks);
      trackInsertFx = next;
      for (let track = 0; track < tracks; track += 1) trackInsertChains[track].sync(next[track]);
      trackInsertFxSnapshots += 1;
      trackInsertFxUpdates += next.reduce((count, chain) => count + chain.filter((slot) => slot.module !== "off" || slot.bypass).length, 0);
      return next;
    }

    function configureInstruments(snapshot) {
      instrumentSnapshotMessages += 1;
      if (transportActive || blockActive) {
        deferredInstrumentSnapshots += 1;
        if (pendingInstruments !== null) replacedDeferredInstrumentSnapshots += 1;
        pendingInstruments = clone(snapshot ?? {});
        promotedDeferredInstrumentAdditions += promoteCompatibleInstrumentAdditions(pendingInstruments);
        return false;
      }
      pendingInstruments = null;
      applyInstrumentSnapshot(snapshot);
      return true;
    }

    function applyPendingInstruments() {
      if (!pendingInstruments || transportActive || blockActive) return false;
      const next = pendingInstruments;
      pendingInstruments = null;
      applyInstrumentSnapshot(next);
      return true;
    }

    function queueParameter(input = {}) {
      const instrumentId = Number(input.instrumentId);
      const parameterId = String(input.parameterId ?? "").trim();
      const rampFrames = Math.max(0, Math.round(Number(input.rampFrames) || 0));
      if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255) throw new RangeError("production parameter instrumentId must be 00–FF");
      if (!parameterId) throw new TypeError("production parameter requires a stable parameterId");
      const instrument = instruments[instrumentId];
      const deferredInstrument = pendingInstruments?.[instrumentId];
      if (!isProductionInstrument(instrument) && !isProductionInstrument(deferredInstrument)) return false;
      if (isProductionInstrument(instrument)) {
        instrument.parameterSnapshot ??= {};
        instrument.parameterSnapshot[parameterId] = clone(input.value);
      }
      // A structural snapshot can be deferred while transport owns the active
      // registries. Mirror accepted live values into the same surviving or
      // newly deferred Instrument, otherwise stop/restart could restore stale state.
      if (isProductionInstrument(deferredInstrument)) {
        deferredInstrument.parameterSnapshot ??= {};
        deferredInstrument.parameterSnapshot[parameterId] = clone(input.value);
      }
      const key = `${instrumentId}\u0000${parameterId}`;
      if (!pendingParameters.has(key) && pendingParameters.size >= MAX_PENDING_PARAMETERS) throw new RangeError(`production live parameter queue exceeded ${MAX_PENDING_PARAMETERS}`);
      if (pendingParameters.has(key)) liveParameterCoalescedUpdates += 1;
      pendingParameters.set(key, Object.freeze({ instrumentId, parameterId, value: clone(input.value), rampFrames }));
      liveParameterUpdates += 1;
      lastLiveParameter = Object.freeze({ instrumentId, parameterId, value: clone(input.value), rampFrames });
      return true;
    }

    // The current effective value the runtime holds for one Instrument
    // parameter, after every accepted prepared-state and live write in
    // MessagePort order. Read-only: it exposes the execution state that
    // queueParameter() already maintains so prepared-state reconciliation does
    // not have to keep a second, competing copy of the same fact.
    function instrumentParameterValue(instrumentId, parameterId) {
      const id = Number(instrumentId);
      const key = String(parameterId ?? "").trim();
      if (!Number.isInteger(id) || !key) return undefined;
      // Parameter values are primitives on this path; only defensively copy a
      // structured value so the caller can never alias runtime execution state.
      const readValue = (value) => (value === null || typeof value !== "object" ? value : clone(value));
      const deferredInstrument = pendingInstruments?.[id];
      if (isProductionInstrument(deferredInstrument) && Object.hasOwn(deferredInstrument.parameterSnapshot ?? {}, key)) {
        return readValue(deferredInstrument.parameterSnapshot[key]);
      }
      const instrument = instruments[id];
      if (isProductionInstrument(instrument) && Object.hasOwn(instrument.parameterSnapshot ?? {}, key)) {
        return readValue(instrument.parameterSnapshot[key]);
      }
      return undefined;
    }

    function queueAudition(input = {}) {
      auditionRequests += 1;
      const track = Number(input.track);
      const instrumentId = Number(input.instrumentId);
      const note = Number(input.note);
      const velocity = Number.isFinite(Number(input.velocity)) ? Math.max(1, Math.min(127, Math.round(Number(input.velocity)))) : 100;
      const durationFrames = Math.max(1, Math.min(maxAuditionFrames, Math.round(Number(input.durationFrames) || Math.round(Number(sampleRate) * 0.24))));
      if (!Number.isInteger(track) || track < 0 || track >= tracks) throw new RangeError(`production audition track must be 0..${tracks - 1}`);
      if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255) throw new RangeError("production audition instrumentId must be 00–FF");
      if (!Number.isFinite(note) || note < 0 || note > 127) throw new RangeError("production audition note must be 0..127");
      if (transportActive) {
        auditionRejections += 1;
        postAudition("rejected", { reason: "transport-active", track, instrumentId });
        return false;
      }
      if (blockActive) {
        auditionRejections += 1;
        postAudition("rejected", { reason: "render-block-active", track, instrumentId });
        return false;
      }
      if (!isProductionInstrument(instruments[instrumentId])) {
        auditionRejections += 1;
        postAudition("rejected", { reason: "instrument-unavailable", track, instrumentId });
        return false;
      }
      ensureRegistryFresh();

      const key = pairKey(track, instrumentId);
      let slot = performerRegistry.prepared(track, instrumentId);
      if (!slot) {
        slot = performerRegistry.prepare(track, instrumentId);
        if (slot) {
          preparedPairs += 1;
          auditionOwnedPairs.add(key);
        }
      }
      if (!slot) {
        auditionRejections += 1;
        postAudition("rejected", { reason: performerRegistry.status(track, instrumentId)?.state ?? "performer-unavailable", track, instrumentId });
        return false;
      }

      const previousPending = pendingAuditions.get(track) ?? null;
      pendingAuditions.set(track, Object.freeze({ track, instrumentId, note, velocity, durationFrames, auditionOwned: auditionOwnedPairs.has(key) }));
      if (previousPending && previousPending.instrumentId !== instrumentId) retireAuditionPair(pairKey(track, previousPending.instrumentId));
      postAudition("queued", { track, instrumentId, note, velocity, durationFrames });
      return true;
    }

    function flushPendingParameters() {
      if (!blockActive || pendingParameters.size === 0) return 0;
      let deliveries = 0;
      const commands = [...pendingParameters.values()];
      pendingParameters.clear();
      for (const command of commands) {
        for (let track = 0; track < tracks; track += 1) {
          if (!performerRegistry.prepared(track, command.instrumentId)) continue;
          if (gateway.applyParameter(track, command.instrumentId, command.parameterId, command.value, 0, command.rampFrames)) deliveries += 1;
        }
      }
      liveParameterDeliveries += deliveries;
      return deliveries;
    }

    function flushAuditions() {
      if (!blockActive) return 0;
      let deliveries = 0;
      const blockEnd = blockStart + blockFrames;
      for (let track = 0; track < tracks; track += 1) {
        const next = pendingAuditions.get(track) ?? null;
        if (next) {
          pendingAuditions.delete(track);
          const previous = activeAuditions[track];
          if (previous && performerRegistry.prepared(track, previous.instrumentId)) {
            if (gateway.allNotesOff(track, previous.instrumentId, 0)) deliveries += 1;
          }
          activeAuditions[track] = null;
          if (previous && previous.instrumentId !== next.instrumentId && previous.auditionOwned) retireAfterBlock.add(pairKey(track, previous.instrumentId));

          const slot = performerRegistry.prepared(track, next.instrumentId);
          if (!slot) {
            auditionRejections += 1;
            postAudition("rejected", { reason: performerRegistry.status(track, next.instrumentId)?.state ?? "performer-unavailable", track, instrumentId: next.instrumentId });
            if (next.auditionOwned) retireAfterBlock.add(pairKey(track, next.instrumentId));
          } else if (gateway.noteOn(track, next.instrumentId, next.note, next.velocity, 0, "host-audition")) {
            deliveries += 1;
            auditionStarts += 1;
            activeAuditions[track] = Object.freeze({ ...next, releaseFrame: blockStart + next.durationFrames });
            postAudition("started", { track, instrumentId: next.instrumentId, note: next.note, releaseFrame: blockStart + next.durationFrames });
          }
        }

        const active = activeAuditions[track];
        if (!active || active.releaseFrame >= blockEnd) continue;
        const offset = Math.max(0, active.releaseFrame - blockStart);
        if (gateway.noteOff(track, active.instrumentId, active.note, offset, "host-audition")) deliveries += 1;
        activeAuditions[track] = null;
        auditionCompletions += 1;
        if (active.auditionOwned) retireAfterBlock.add(pairKey(track, active.instrumentId));
        postAudition("completed", { track, instrumentId: active.instrumentId, note: active.note, releaseFrame: active.releaseFrame });
      }
      return deliveries;
    }

    function prepareProgram(program) {
      if (blockActive) throw new ProductionProgramError("program-prepare-boundary", "production program preparation is forbidden inside an active render block");
      ensureRegistryFresh();
      const pairs = programPairs(program, instruments, tracks);
      const requiredKeys = new Set(pairs.map(([track, instrumentId]) => pairKey(track, instrumentId)));
      let capacityPlan;
      try { capacityPlan = capacityPlanFor(pairs); }
      catch (error) { reportProgramError(error); throw error; }

      if (pendingAuditions.size > 0 || activeAuditions.some(Boolean) || auditionOwnedPairs.size > 0) {
        try { performerRegistry?.releaseAll?.(); } catch {}
        clearAuditions("transport-start");
        destroyAllAuditionOwned();
      }
      const retirementFailuresBefore = programRetirementFailures;
      retireProgramPairsExcept(requiredKeys);
      if (programRetirementFailures > retirementFailuresBefore) {
        const error = new ProductionProgramError("program-performer-retirement-failed", "failed to retire one or more obsolete production performers; replacement transport was rejected", {
          failures: programRetirementFailures - retirementFailuresBefore,
        });
        reportProgramError(error);
        throw error;
      }
      const created = [];
      for (const [track, instrumentId] of pairs) {
        if (performerRegistry.prepared(track, instrumentId)) continue;
        const slot = performerRegistry.prepare(track, instrumentId);
        if (slot) {
          preparedPairs += 1;
          const key = pairKey(track, instrumentId);
          programOwnedPairs.add(key);
          created.push(key);
          continue;
        }
        for (const key of created) destroyProgramPairNow(key);
        const status = performerRegistry.status(track, instrumentId);
        const error = new ProductionProgramError(status?.code ?? "performer-prepare-failed", `failed to prepare Track ${track} × Instrument ${instrumentId}: ${status?.message ?? status?.state ?? "performer unavailable"}`, {
          track,
          instrumentId,
          status,
          capacityPlan,
        });
        reportProgramError(error);
        throw error;
      }
      for (const key of requiredKeys) programOwnedPairs.add(key);
      transportActive = true;
      lastProgramPairCount = pairs.length;
      lastCapacityPlan = capacityPlan;
      lastProgramError = null;
      postDiagnostics();
      return Object.freeze({ requiredPairs: pairs.length, capacityPlan });
    }

    function beginBlock(startFrame, frameCount) {
      const frames = Math.round(Number(frameCount));
      if (!Number.isInteger(frames) || frames < 1 || frames > MAX_BLOCK_FRAMES) throw new RangeError(`production render block ${frames} outside 1..${MAX_BLOCK_FRAMES}`);
      if (!gateway) rebuildRegistries();
      blockFrames = frames;
      blockStart = Math.round(Number(startFrame));
      gateway.beginBlock(blockStart, blockFrames);
      blockActive = true;
      flushPendingParameters();
      flushAuditions();
    }

    function routeTracePacket(packet) {
      if (!blockActive || !packet?.events) return new Set();
      const consumed = new Set();
      const routed = [];
      for (const event of packet.events) {
        const id = Number(event?.data?.instrumentId);
        if (!Number.isInteger(id) || !isProductionInstrument(instruments[id])) continue;
        if (["note-release", "parameter", "note-trigger"].includes(event.kind)) consumed.add(event.ordinal);
        if (event.kind === "note-release" || event.kind === "note-trigger") routed.push(event);
      }
      if (routed.length > 0) gateway.routeTracePacket(Object.freeze({ ...packet, events: Object.freeze(routed) }));
      return consumed;
    }

    function routePreparedLifecycle(frame, track, instrumentId, type, note, velocity = 100) {
      if (!blockActive) throw new Error("prepared production lifecycle requires an active render block");
      const id = Number(instrumentId);
      if (!Number.isInteger(id) || id < 0 || id > 255 || !isProductionInstrument(instruments[id])) return false;
      gateway.routePreparedLifecycle(frame, track, id, type, note, velocity);
      return true;
    }

    function renderInto(left, right, trackMix) {
      if (!blockActive) return;
      for (let track = 0; track < tracks; track += 1) {
        const dryLeft = trackLeft[track];
        const dryRight = trackRight[track];
        try {
          gateway.renderTrack(track, dryLeft, dryRight, blockFrames);
          trackInsertChains[track].process(dryLeft, dryRight, blockFrames);
        }
        catch (error) {
          // Preserve the failing track without mutating an engine-owned throw.
          // JavaScript permits primitive and frozen thrown values as well as Errors.
          const tracked = new Error(String(error?.message ?? error), { cause: error });
          tracked.code = error?.code ?? null;
          tracked.productionTrack = track;
          throw tracked;
        }
        const mix = trackMix?.[track] ?? { gain: 1, mute: false, pan: 0 };
        if (mix.mute || Number(mix.gain) <= 0) continue;
        const pan = Math.max(-1, Math.min(1, Number(mix.pan) || 0));
        const gain = Math.max(0, Math.min(1, Number(mix.gain) || 0));
        const leftGain = gain * Math.sqrt((1 - pan) * 0.5);
        const rightGain = gain * Math.sqrt((1 + pan) * 0.5);
        for (let frame = 0; frame < blockFrames; frame += 1) { left[frame] += dryLeft[frame] * leftGain; right[frame] += dryRight[frame] * rightGain; }
      }
    }

    function endBlock() {
      if (!blockActive) return;
      try { gateway.endBlock(); }
      finally {
        blockActive = false;
        blockFrames = 0;
        flushRetiredPerformers();
      }
    }

    function stop() {
      transportActive = false;
      if (blockActive) {
        try { endBlock(); }
        catch (error) {
          runtimeErrors += 1;
          postMessage({ type: "production-engine-error", code: error?.code ?? "production-block-stop-failed", message: String(error?.message ?? error), details: error?.details ?? null });
          blockActive = false;
          blockFrames = 0;
        }
      }
      try { performerRegistry?.releaseAll?.(); } catch {}
      pendingParameters.clear();
      clearAuditions("transport-stop");
      destroyAllAuditionOwned();
      destroyAllProgramOwned();
      lastProgramPairCount = 0;
      try { applyPendingInstruments(); }
      catch (error) {
        runtimeErrors += 1;
        postMessage({ type: "production-engine-error", code: error?.code ?? "production-pending-instruments-failed", message: String(error?.message ?? error), details: error?.details ?? null });
      }
      postDiagnostics();
    }

    const hasInstrument = (id) => isProductionInstrument(instruments[Number(id)]);
    const hasProductionInstruments = () => Object.keys(instruments).length > 0;
    const hasPreparedPerformers = () => Number(performerRegistry?.diagnostics?.().activePreparedCount ?? 0) > 0;

    function diagnostics() {
      return Object.freeze({
        abiVersion: abiRuntime.ABI_VERSION,
        registeredPackages: abiRuntime.runtimeRecords().map((record) => {
          const capability = packageDomain.moduleInstanceCapability(record.manifest);
          return Object.freeze({ moduleId: record.entry.moduleId, engineId: record.entry.engineId, version: record.entry.version, packageSha256: record.entry.packageSha256, contentSha256: record.manifest.contentSha256, maxModuleInstances: capability.capacity, capabilitySource: capability.source, capabilityExplicit: capability.explicit, runtime: record.module?.HEAPU8?.buffer ? Object.freeze({ wasmMemoryBytes: record.module.HEAPU8.buffer.byteLength, memoryGrowth: record.manifest?.runtime?.memoryGrowth ?? null }) : null });
        }),
        activeRegistryPackages: engineRegistry?.snapshot?.() ?? Object.freeze([]),
        activeRegistryRuntimeSignature: registeredRuntimeSignature,
        instrumentCount: Object.keys(instruments).length,
        preparedPairs,
        pendingInstrumentSync: pendingInstruments !== null,
        pendingLiveParameters: pendingParameters.size,
        liveParameterUpdates,
        liveParameterCoalescedUpdates,
        liveParameterDeliveries,
        traffic: Object.freeze({
          instrumentSnapshotMessages,
          assetSnapshotMessages,
          assetRecordsAccepted,
          assetSyncRejections,
          deferredInstrumentSnapshots,
          replacedDeferredInstrumentSnapshots,
          promotedDeferredInstrumentAdditions,
          liveParameterUpdates,
          liveParameterCoalescedUpdates,
          liveParameterDeliveries,
          lastLiveParameter,
        }),
        assets: Object.freeze({
          count: assets.size,
          snapshotMessages: assetSnapshotMessages,
          recordsAccepted: assetRecordsAccepted,
          syncRejections: assetSyncRejections,
        }),
        trackInsertFx: Object.freeze({
          snapshots: trackInsertFxSnapshots,
          activeSlots: trackInsertFx.reduce((count, chain) => count + chain.filter((slot) => slot.module !== "off" && !slot.bypass).length, 0),
          configuredSlots: trackInsertFx.reduce((count, chain) => count + chain.filter((slot) => slot.module !== "off").length, 0),
          updates: trackInsertFxUpdates,
          tracks: Object.freeze(trackInsertChains.map((chain) => chain.diagnostics())),
        }),
        transportActive,
        blockActive,
        runtimeErrors,
        renderFailures,
        lastRenderFailure,
        registrationFailures: abiRuntime.registrationFailures?.() ?? Object.freeze([]),
        program: Object.freeze({
          requiredPairs: lastProgramPairCount,
          ownedPerformers: programOwnedPairs.size,
          capacityPlan: lastCapacityPlan,
          prepareFailures: programPrepareFailures,
          retirements: programRetirements,
          retirementFailures: programRetirementFailures,
          lastError: lastProgramError,
        }),
        audition: Object.freeze({
          pending: pendingAuditions.size,
          active: activeAuditions.filter(Boolean).length,
          ownedPerformers: auditionOwnedPairs.size,
          retiringPerformers: retireAfterBlock.size,
          requests: auditionRequests,
          starts: auditionStarts,
          completions: auditionCompletions,
          rejections: auditionRejections,
          maxDurationFrames: maxAuditionFrames,
        }),
        performers: performerRegistry?.diagnostics?.() ?? null,
        gateway: gateway?.diagnostics?.() ?? null,
      });
    }

    function recordRenderFailure(error, context = {}) {
      runtimeErrors += 1;
      renderFailures += 1;
      lastRenderFailure = Object.freeze({
        code: String(error?.code ?? "production-engine-error"),
        message: String(error?.message ?? error),
        blockStartFrame: Number.isSafeInteger(context.blockStartFrame) ? context.blockStartFrame : null,
        failure: renderFailures,
      });
      return lastRenderFailure;
    }

    function postDiagnostics() { postMessage({ type: "production-diagnostics", snapshot: diagnostics() }); }
    function handleMessage(data) {
      if (data?.type === "track-insert-fx") {
        try {
          configureTrackInsertFx(data.tracks);
          postMessage({ type: "track-insert-fx-applied", revision: Number(data.revision) || 0 });
          postDiagnostics();
        }
        catch (error) {
          runtimeErrors += 1;
          postMessage({ type: "production-engine-error", code: error?.code ?? "track-insert-fx-error", message: String(error?.message ?? error) });
        }
        return true;
      }
      if (data?.type === "production-assets") {
        try { configureAssets(data.assets); postDiagnostics(); }
        catch (error) {
          runtimeErrors += 1;
          postMessage({ type: "production-engine-error", code: error?.code ?? "production-asset-error", message: String(error?.message ?? error) });
        }
        return true;
      }
      if (data?.type === "production-instruments") { configureInstruments(data.instruments); postDiagnostics(); return true; }
      if (data?.type === "production-parameter") {
        // Parameter traffic is realtime control input. Counters remain available
        // through an explicit diagnostics request; do not serialize the complete
        // performer graph back to the main thread for every drag event.
        try { queueParameter(data); }
        catch (error) { runtimeErrors += 1; postMessage({ type: "production-engine-error", code: error?.code ?? "production-parameter-error", message: String(error?.message ?? error) }); }
        return true;
      }
      if (data?.type === "production-audition") {
        try { queueAudition(data); postDiagnostics(); }
        catch (error) {
          runtimeErrors += 1;
          auditionRejections += 1;
          postAudition("rejected", { reason: error?.code ?? "production-audition-error", message: String(error?.message ?? error) });
          postDiagnostics();
        }
        return true;
      }
      if (data?.type === "production-diagnostics-request") { postDiagnostics(); return true; }
      return false;
    }

    rebuildRegistries();
    return Object.freeze({ configureTrackInsertFx, configureAssets, configureInstruments, queueParameter, instrumentParameterValue, queueAudition, flushPendingParameters, flushAuditions, prepareProgram, beginBlock, routeTracePacket, routePreparedLifecycle, renderInto, endBlock, stop, hasInstrument, hasProductionInstruments, hasPreparedPerformers, diagnostics, recordRenderFailure, postDiagnostics, handleMessage });
  }

  const api = Object.freeze({ DEFAULT_TRACK_COUNT, MAX_BLOCK_FRAMES, MAX_PENDING_PARAMETERS, MAX_AUDITION_SECONDS, ProductionProgramError, programPairs, createProductionAudioRuntime });
  globalThis.BRKTRKProductionAudioRuntime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();