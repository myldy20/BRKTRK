(() => {
  "use strict";

  const host = globalThis.BRKTRKProductionEngineHost;
  const stores = globalThis.BRKTRKStores;
  const audioFacade = typeof audio !== "undefined" ? audio : globalThis.audio;
  const readiness = globalThis.BRKTRKAudioReadiness;
  const preparedDomain = globalThis.BRKTRKPreparedInstrumentStateDomain ?? null;
  const applicationStateApi = globalThis.BRKTRKPreparedInstrumentApplicationState ?? null;
  if (!host || !stores?.project || !stores?.transport?.runtime || !stores?.transport?.subscribe || !audioFacade || !readiness?.invalidate || !readiness?.ensureReady) {
    throw new Error("production engine Store sync requires ProductionEngineHost + Project/Transport stores + BrowserAudio + canonical AudioReadiness");
  }

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const preparedSequencer = preparedDomain?.createSequencer?.() ?? null;
  const preparedApplications = applicationStateApi?.install?.(stores.transport) ?? null;
  const hasPreparedHost = Boolean(
    host?.verifiedPackageViewFor
    && host?.sendPreparedState
    && host?.subscribePreparedStateStatus
    && host?.invalidatePreparedStateShadow,
  );

  let inFlight = Promise.resolve();
  let parameterMutations = 0;
  let liveParameterMessages = 0;
  let liveParameterRejections = 0;
  let preparedMutations = 0;
  let preparedMessages = 0;
  let preparedApplied = 0;
  let preparedFailed = 0;
  let preparedRejected = 0;
  let stalePreparedStatuses = 0;
  let preparedFallbacks = 0;
  let structuralSynchronizations = 0;
  let ignoredAudioMutations = 0;
  let readinessDeferredUntilStop = false;
  let stopBoundaryReadinessProofs = 0;
  let preparedStatusResetPending = false;

  function preparedSupportReady() {
    return Boolean(preparedDomain?.classifySameTopology && preparedDomain?.prepareEnvelope && preparedSequencer && preparedApplications && hasPreparedHost);
  }

  function authoritativeLiveTransport() {
    const snapshot = stores.transport.runtime.snapshot?.() ?? null;
    return Boolean(snapshot?.phase === "playing" && snapshot?.playing === true);
  }

  function parameterMutation(changeSet) {
    const path = Array.isArray(changeSet?.path) ? changeSet.path : [];
    if (changeSet?.subtype !== "instrument.parameter" || path[0] !== "instrumentPool" || path[2] !== "parameterSnapshot") return null;
    const instrumentId = Number(path[1]);
    const parameterId = String(path.slice(3).join(".") || changeSet?.transaction?.parameterKey || "").trim();
    if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255 || !parameterId) return null;
    return Object.freeze({ instrumentId, parameterId, value: clone(changeSet.after) });
  }

  function historyParameterMutation(changeSet) {
    if (changeSet?.subtype !== "history.undo" && changeSet?.subtype !== "history.redo") return null;
    const transaction = changeSet?.transaction;
    if (!transaction || transaction.originalSubtype !== "instrument.parameter") return null;
    if (changeSet.affectsPlayback === false || transaction.originalAffectsPlayback === false) return null;
    if (changeSet.structuralPlayback !== false || transaction.originalStructuralPlayback !== false) return null;
    const path = Array.isArray(transaction.originalPath) ? transaction.originalPath : [];
    if (path[0] !== "instrumentPool" || path[2] !== "parameterSnapshot") return null;
    const instrumentId = Number(path[1]);
    const parameterId = String(path.slice(3).join(".") || "").trim();
    if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255 || !parameterId) return null;
    return Object.freeze({ instrumentId, parameterId, value: clone(transaction.restoredValue) });
  }

  function preparedMutation(changeSet) {
    const path = Array.isArray(changeSet?.path) ? changeSet.path : [];
    if ((changeSet?.subtype !== "instrument.preset" && changeSet?.subtype !== "instrument.patch") || path[0] !== "instrumentPool") return null;
    const instrumentId = Number(path[1] ?? changeSet?.transaction?.instrumentId);
    if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255) return null;
    return Object.freeze({ instrumentId, sourceSubtype: String(changeSet.subtype) });
  }

  function beforeInstrument(changeSet, desiredInstrument, instrumentId) {
    const before = changeSet?.before;
    if (!desiredInstrument || typeof desiredInstrument !== "object") return null;
    if (before?.engineRef && typeof before.engineRef === "object") return clone(before);
    if (!before || typeof before !== "object" || Array.isArray(before)) return null;
    const current = clone(desiredInstrument);
    current.id = Number.isInteger(Number(current.id)) ? Number(current.id) : Number(instrumentId);
    if (Object.hasOwn(before, "patchState")) current.patchState = clone(before.patchState);
    if (Object.hasOwn(before, "parameterSnapshot")) current.parameterSnapshot = clone(before.parameterSnapshot);
    if (Object.hasOwn(before, "presetRef")) current.presetRef = clone(before.presetRef);
    return current;
  }

  function desiredPresetInstrument(instrument, preset) {
    if (!instrument || typeof instrument !== "object" || !preset || typeof preset !== "object") return null;
    const desired = clone(instrument);
    desired.patchState = clone(preset.patchState);
    desired.parameterSnapshot = clone(preset.parameterSnapshot);
    desired.presetRef = {
      id: preset.id == null ? null : String(preset.id),
      moduleId: instrument.engineRef?.moduleId ?? null,
      engineId: instrument.engineRef?.engineId ?? null,
      version: instrument.engineRef?.resolvedVersion ?? instrument.engineRef?.requestedVersion ?? null,
      packageSha256: instrument.engineRef?.resolvedPackageSha256 ?? null,
    };
    return desired;
  }

  function preparedPresetAvailability({ instrumentId, instrument, preset, packageView } = {}) {
    if (!preparedSupportReady()) return Object.freeze({ eligible: false, code: "prepared-support-unavailable", reason: "Prepared Instrument runtime is not ready" });
    if (preparedStatusResetPending) return Object.freeze({ eligible: false, code: "structural-reconciliation-pending", reason: "Live prepared state is unavailable until structural reconciliation reaches authoritative readiness" });
    if (!authoritativeLiveTransport()) return Object.freeze({ eligible: false, code: "transport-not-authoritatively-playing", reason: "Live prepared preset loading requires authoritative playing phase" });
    if (!audioFacade.ready || !audioFacade.context || !audioFacade.node) return Object.freeze({ eligible: false, code: "audio-runtime-unavailable", reason: "Production audio must be ready before live preset loading" });
    if (!preset?.applicable) return Object.freeze({ eligible: false, code: "preset-unavailable", reason: "Preset is not applicable to the verified package" });
    const id = Number(instrumentId);
    const desired = desiredPresetInstrument(instrument, preset);
    const view = packageView ?? host.verifiedPackageViewFor(instrument?.engineRef);
    try {
      const envelope = preparedDomain.prepareEnvelope({
        instrumentId: id,
        currentInstrument: instrument,
        desiredInstrument: desired,
        packageView: view,
        commitId: 1,
        sourceSubtype: "instrument.preset",
      });
      return Object.freeze({
        eligible: true,
        code: "same-exact-topology",
        reason: null,
        instrumentId: envelope.instrumentId,
        desiredPresetId: envelope.desiredPresetId,
      });
    } catch (error) {
      return Object.freeze({ eligible: false, code: error?.code ?? "prepared-state-ineligible", reason: String(error?.message ?? error) });
    }
  }

  function historyRestoresInstrument(changeSet) {
    if (changeSet?.subtype !== "history.undo" && changeSet?.subtype !== "history.redo") return false;
    // A G1 history restore with exact non-structural parameter metadata is owned
    // by the dedicated live-parameter path. Older entries without that metadata
    // remain conservative whole-Instrument structural restores.
    if (historyParameterMutation(changeSet)) return false;
    if (changeSet?.affectsPlayback === false || changeSet?.transaction?.originalAffectsPlayback === false) return false;
    const originalTarget = String(changeSet?.transaction?.originalTarget ?? "");
    return originalTarget === "project.instrumentPool" || originalTarget.startsWith("project.instrumentPool.");
  }

  function structuralInstrumentMutation(changeSet) {
    if (!changeSet) return true;
    if (changeSet?.subtype === "file.replace" || changeSet?.target === "project.file.replace") return true;
    if (historyRestoresInstrument(changeSet)) return true;
    const path = Array.isArray(changeSet?.path) ? changeSet.path : [];
    return path[0] === "instrumentPool";
  }

  function clearPreparedControlAfterStructural(source) {
    if (!preparedSupportReady()) return false;
    for (const row of preparedSequencer.snapshot().latest) {
      preparedSequencer.release(row.instrumentId, row.commitId);
    }
    preparedApplications.clearAll({ source });
    preparedStatusResetPending = false;
    return true;
  }

  function enqueueReadinessProof(source, onReady = null) {
    inFlight = inFlight
      .then(async () => {
        await readiness.ensureReady({ source });
        onReady?.();
      })
      .catch((error) => {
        console.warn("Production engine readiness proof failed", error);
      });
    return inFlight;
  }

  function scheduleStructuralSynchronization(project, reason = "project-instruments-changed") {
    structuralSynchronizations += 1;
    if (preparedSupportReady()) preparedStatusResetPending = true;
    readiness.invalidate({
      source: "production-engine-store-sync",
      reason,
      supersedeInFlight: true,
    });
    inFlight = inFlight
      .then(async () => {
        await host.activateProject(project);
        if (stores.transport.runtime.snapshot?.().phase === "stopped") {
          readinessDeferredUntilStop = false;
          await readiness.ensureReady({ source: "production-engine-store-sync" });
          if (preparedStatusResetPending) clearPreparedControlAfterStructural("production-engine-store-sync-structural-ready");
        } else {
          readinessDeferredUntilStop = true;
        }
      })
      .catch((error) => {
        console.warn("Production engine project synchronization failed", error);
      });
    return inFlight;
  }

  function fallbackPreparedState(project, reason, error = null) {
    preparedFallbacks += 1;
    host.invalidatePreparedStateShadow?.();
    scheduleStructuralSynchronization(project, reason);
    if (error) console.warn("Prepared Instrument state fell back to structural synchronization", error);
  }

  function deliverPreparedMutation(changeSet, project, prepared) {
    if (!preparedSupportReady() || preparedStatusResetPending || !authoritativeLiveTransport()) return false;
    const desired = project?.instrumentPool?.[prepared.instrumentId] ?? null;
    const current = beforeInstrument(changeSet, desired, prepared.instrumentId);
    const packageView = host.verifiedPackageViewFor(desired?.engineRef);
    if (!desired || !current || !packageView) return false;

    let envelope;
    try {
      envelope = preparedSequencer.prepare({
        instrumentId: prepared.instrumentId,
        currentInstrument: current,
        desiredInstrument: desired,
        packageView,
        sourceSubtype: prepared.sourceSubtype,
      });
    } catch (error) {
      preparedRejected += 1;
      return false;
    }

    const requested = preparedApplications.request({
      instrumentId: envelope.instrumentId,
      commitId: envelope.commitId,
      desiredPresetId: envelope.desiredPresetId,
    }, { source: "production-engine-store-sync" });
    if (!requested.accepted) {
      preparedRejected += 1;
      preparedSequencer.release(envelope.instrumentId, envelope.commitId);
      return false;
    }

    preparedMutations += 1;
    try {
      const delivered = host.sendPreparedState({ envelope, instrument: desired, project });
      if (!delivered) throw new Error("Production Host rejected prepared-state MessagePort delivery");
      preparedMessages += 1;
      return true;
    } catch (error) {
      preparedFailed += 1;
      preparedApplications.acknowledge({
        state: "failed",
        instrumentId: envelope.instrumentId,
        commitId: envelope.commitId,
        desiredPresetId: envelope.desiredPresetId,
        code: error?.code ?? "prepared-state-delivery",
        reason: String(error?.message ?? error),
      }, { source: "production-engine-store-sync-delivery" });
      preparedSequencer.release(envelope.instrumentId, envelope.commitId);
      fallbackPreparedState(project, "prepared-instrument-state-delivery-failed", error);
      return true;
    }
  }

  function handlePreparedStatus(status) {
    if (!preparedApplications || !preparedSequencer) return false;
    let result;
    try {
      result = preparedApplications.acknowledge(status, { source: "production-worklet-prepared-state" });
    } catch (error) {
      console.warn("Prepared Instrument Worklet status was invalid", error);
      return false;
    }
    if (!result.accepted) {
      stalePreparedStatuses += 1;
      return false;
    }
    if (status.state === "applied") {
      preparedApplied += 1;
      preparedSequencer.release(status.instrumentId, status.commitId);
      return true;
    }
    if (status.state === "failed") {
      preparedFailed += 1;
      preparedSequencer.release(status.instrumentId, status.commitId);
      fallbackPreparedState(stores.project.getState(), "prepared-instrument-state-apply-failed", status.reason ?? status.code ?? null);
      return true;
    }
    return true;
  }

  function deliverLiveParameter(parameter, project) {
    parameterMutations += 1;
    const instrument = project?.instrumentPool?.[parameter.instrumentId] ?? null;
    const delivered = host.sendLiveParameter({
      instrumentId: parameter.instrumentId,
      instrument,
      parameterId: parameter.parameterId,
      value: parameter.value,
    });
    if (delivered) liveParameterMessages += 1;
    else liveParameterRejections += 1;
    return Boolean(delivered);
  }

  const synchronize = (changeSet = null, project = stores.project.getState()) => {
    if (!audioFacade.ready || !audioFacade.context || !audioFacade.node) return;
    const parameter = parameterMutation(changeSet);
    if (parameter) {
      deliverLiveParameter(parameter, project);
      return;
    }

    const historyParameter = historyParameterMutation(changeSet);
    if (historyParameter) {
      deliverLiveParameter(historyParameter, project);
      return;
    }

    const prepared = preparedMutation(changeSet);
    if (prepared && authoritativeLiveTransport() && deliverPreparedMutation(changeSet, project, prepared)) return;

    if (!structuralInstrumentMutation(changeSet)) {
      ignoredAudioMutations += 1;
      return;
    }
    scheduleStructuralSynchronization(project);
  };

  const disconnectProject = stores.project.subscribe("audio", synchronize);
  const disconnectTransport = stores.transport.subscribe("transport", (changeSet) => {
    if (!readinessDeferredUntilStop) return;
    if (changeSet?.target !== "transport.program.stopped") return;
    readinessDeferredUntilStop = false;
    stopBoundaryReadinessProofs += 1;
    enqueueReadinessProof("production-engine-store-sync-stop-boundary", () => {
      if (preparedStatusResetPending) clearPreparedControlAfterStructural("production-engine-store-sync-stop-boundary-ready");
    });
  });
  const disconnectPreparedStatus = preparedSupportReady()
    ? host.subscribePreparedStateStatus(handlePreparedStatus)
    : () => {};
  const disconnect = () => {
    disconnectProject?.();
    disconnectTransport?.();
    disconnectPreparedStatus?.();
  };

  synchronize(null, stores.project.getState());
  host.registerDiagnostics();

  Promise.resolve(host.refreshCatalog())
    .catch((error) => console.warn("Production engine catalog unavailable for Sound", error))
    .finally(() => globalThis.BRKTRKSoundEditRenderer?.initialize?.());

  const snapshot = () => {
    const legacy = {
      parameterMutations,
      liveParameterMessages,
      liveParameterRejections,
      structuralSynchronizations,
      ignoredAudioMutations,
      readinessDeferredUntilStop,
      stopBoundaryReadinessProofs,
    };
    if (!preparedSupportReady()) return Object.freeze(legacy);
    return Object.freeze({
      parameterMutations,
      liveParameterMessages,
      liveParameterRejections,
      preparedSupportReady: true,
      preparedMutations,
      preparedMessages,
      preparedApplied,
      preparedFailed,
      preparedRejected,
      stalePreparedStatuses,
      preparedFallbacks,
      preparedStatusResetPending,
      preparedQueue: preparedSequencer.snapshot(),
      preparedApplications: preparedApplications.snapshot(),
      structuralSynchronizations,
      ignoredAudioMutations,
      readinessDeferredUntilStop,
      stopBoundaryReadinessProofs,
    });
  };

  globalThis.BRKTRKProductionEngineStoreSync = Object.freeze({
    disconnect,
    synchronize,
    parameterMutation,
    historyParameterMutation,
    preparedMutation,
    preparedSupportReady,
    authoritativeLiveTransport,
    preparedPresetAvailability,
    beforeInstrument,
    historyRestoresInstrument,
    structuralInstrumentMutation,
    handlePreparedStatus,
    snapshot,
  });
})();
