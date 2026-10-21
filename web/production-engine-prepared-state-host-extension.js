(() => {
  "use strict";

  const base = globalThis.BRKTRKProductionEngineHost;
  if (!base?.attachNode || !base?.syncProject || !base?.ensurePackageView || !base?.productionInstrumentSnapshot) {
    throw new Error("prepared-state Host extension requires ProductionEngineHost");
  }

  const STATUS_STATES = Object.freeze(new Set(["queued", "applying", "applied", "failed"]));
  const verifiedViews = new Map();
  const preparedListeners = new Set();
  const boundPorts = new WeakSet();
  const pendingByInstrument = new Map();
  let node = null;
  let attachedContext = null;
  let logicalInstrumentSnapshot = null;
  let preparedMessages = 0;
  let preparedMessageFailures = 0;
  let preparedStatusMessages = 0;
  let stalePreparedStatuses = 0;
  let lastPreparedStatus = null;

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const normalizedSha = (value) => String(value ?? "").trim().toLowerCase();
  const versionForRef = (ref) => String(ref?.resolvedVersion ?? ref?.requestedVersion ?? "").trim();
  const optionalPositiveInteger = (value) => {
    if (value == null) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : null;
  };
  const optionalNonNegativeInteger = (value) => {
    if (value == null) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  };
  const keyForIdentity = (moduleId, engineId, version, packageSha256) => `${String(moduleId ?? "")}\u0000${String(engineId ?? "")}\u0000${String(version ?? "")}\u0000${normalizedSha(packageSha256)}`;
  const keyForRef = (ref) => keyForIdentity(ref?.moduleId, ref?.engineId, versionForRef(ref), ref?.resolvedPackageSha256);
  const keyForView = (view) => keyForIdentity(view?.entry?.moduleId, view?.entry?.engineId, view?.entry?.version, view?.entry?.packageSha256);
  const keyForEnvelope = (envelope) => keyForIdentity(envelope?.exactEngineIdentity?.moduleId, envelope?.exactEngineIdentity?.engineId, envelope?.exactEngineIdentity?.version, envelope?.exactEngineIdentity?.packageSha256);
  const instrumentSnapshot = (project) => base.productionInstrumentSnapshot(project);
  const snapshotSignature = (snapshot) => JSON.stringify(snapshot ?? {});

  async function ensurePackageView(engineRef, options = {}) {
    const view = await base.ensurePackageView(engineRef, options);
    const key = keyForView(view);
    if (key) verifiedViews.set(key, view);
    return view;
  }

  function verifiedPackageViewFor(engineRef) {
    if (!engineRef?.moduleId || !engineRef?.engineId) return null;
    return verifiedViews.get(keyForRef(engineRef)) ?? null;
  }

  function syncLogicalLiveParameter({ instrumentId, instrument, parameterId, value } = {}) {
    if (!logicalInstrumentSnapshot || !instrument?.engineRef) return;
    const id = String(Number(instrumentId));
    const current = logicalInstrumentSnapshot[id];
    if (!current?.engineRef || keyForRef(current.engineRef) !== keyForRef(instrument.engineRef)) return;
    if (!current.parameterSnapshot || typeof current.parameterSnapshot !== "object" || Array.isArray(current.parameterSnapshot)) current.parameterSnapshot = {};
    current.parameterSnapshot[String(parameterId)] = clone(value);
  }

  function sendLiveParameter(input = {}) {
    const delivered = base.sendLiveParameter(input);
    if (delivered) syncLogicalLiveParameter(input);
    return delivered;
  }

  function preparedStatus(message) {
    if (message?.type !== "production-prepared-state-status") return null;
    const state = String(message.state ?? "");
    const instrumentId = Number(message.instrumentId);
    const commitId = Number(message.commitId);
    if (!STATUS_STATES.has(state) || !Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255 || !Number.isSafeInteger(commitId) || commitId < 1) return null;
    return Object.freeze({
      type: "production-prepared-state-status",
      state,
      instrumentId,
      commitId,
      desiredPresetId: message.desiredPresetId == null ? null : String(message.desiredPresetId),
      supersededCommitId: optionalPositiveInteger(message.supersededCommitId),
      appliedPerformers: optionalNonNegativeInteger(message.appliedPerformers),
      code: message.code == null ? null : String(message.code),
      reason: message.reason == null ? null : String(message.reason),
    });
  }

  function handlePreparedStatus(message) {
    const status = preparedStatus(message);
    if (!status) return false;
    preparedStatusMessages += 1;
    lastPreparedStatus = status;
    const pending = pendingByInstrument.get(status.instrumentId) ?? null;
    if (pending && pending.commitId === status.commitId) {
      if (status.state === "applied") {
        // The logical shadow already tracks the newest ProjectStore desired
        // snapshot. Do not replace it with a commit-local snapshot here: ACKs
        // for different Instruments can arrive over multiple render blocks.
        pendingByInstrument.delete(status.instrumentId);
      } else if (status.state === "failed") {
        pendingByInstrument.delete(status.instrumentId);
        // A matching failure means the optimistic logical shadow can no longer
        // prove convergence. Store sync will fall back to the structural path.
        logicalInstrumentSnapshot = null;
      }
    } else if (status.state === "applied" || status.state === "failed") {
      stalePreparedStatuses += 1;
    }
    for (const listener of [...preparedListeners]) {
      try { listener(status); } catch (error) { console.warn("Prepared-state Host status listener failed", error); }
    }
    return true;
  }

  function bindPreparedPort(nextNode) {
    const port = nextNode?.port;
    if (!port?.addEventListener || boundPorts.has(port)) return;
    boundPorts.add(port);
    port.addEventListener("message", (event) => handlePreparedStatus(event.data));
    port.start?.();
  }

  function attachNode(nextNode, context, project) {
    node = nextNode ?? null;
    attachedContext = context ?? null;
    pendingByInstrument.clear();
    logicalInstrumentSnapshot = null;
    const result = base.attachNode(nextNode, context, project);
    bindPreparedPort(nextNode);
    if (node?.port) logicalInstrumentSnapshot = instrumentSnapshot(project);
    return result;
  }

  function sendPreparedState({ envelope, instrument, project } = {}) {
    if (!node?.port || !attachedContext || !envelope || !instrument?.engineRef) {
      preparedMessageFailures += 1;
      return false;
    }
    const instrumentId = Number(envelope.instrumentId);
    const commitId = Number(envelope.commitId);
    const stateByteLength = Number(envelope.stateByteLength);
    if (!Number.isInteger(instrumentId) || instrumentId < 0 || instrumentId > 255 || !Number.isSafeInteger(commitId) || commitId < 1 || !Number.isSafeInteger(stateByteLength) || stateByteLength < 1) {
      preparedMessageFailures += 1;
      return false;
    }
    if (keyForEnvelope(envelope) !== keyForRef(instrument.engineRef)) {
      preparedMessageFailures += 1;
      return false;
    }
    const verifiedView = verifiedPackageViewFor(instrument.engineRef);
    if (!verifiedView
      || keyForView(verifiedView) !== keyForEnvelope(envelope)
      || normalizedSha(verifiedView.manifest?.contentSha256) !== normalizedSha(envelope.contentSha256)
      || Number(verifiedView.manifest?.stateSchemaVersion) !== Number(envelope.stateSchemaVersion)
      || Number(verifiedView.manifest?.stateBytes) !== stateByteLength) {
      preparedMessageFailures += 1;
      return false;
    }
    if (typeof envelope.copyStateBytesInto !== "function") {
      preparedMessageFailures += 1;
      return false;
    }

    const stateBytes = new Uint8Array(stateByteLength);
    envelope.copyStateBytesInto(stateBytes);
    const logicalSnapshot = instrumentSnapshot(project);
    const message = {
      type: "production-prepared-state",
      instrumentId,
      commitId,
      exactEngineIdentity: clone(envelope.exactEngineIdentity),
      stateSchemaVersion: Number(envelope.stateSchemaVersion),
      stateBytes,
      parameterIds: [...envelope.parameterIds],
      parameterValues: [...envelope.parameterValues],
      sourceSubtype: String(envelope.sourceSubtype),
      desiredPresetId: envelope.desiredPresetId == null ? null : String(envelope.desiredPresetId),
    };

    pendingByInstrument.set(instrumentId, { commitId });
    // This is an optimistic *desired-state* mirror used only to suppress a
    // redundant structural snapshot while the prepared commit is pending. The
    // TransportStore application domain remains authoritative for requested /
    // queued / applying / applied / failed convergence state.
    logicalInstrumentSnapshot = logicalSnapshot;
    try {
      node.port.postMessage(message);
      preparedMessages += 1;
      return Object.freeze({ instrumentId, commitId, desiredPresetId: message.desiredPresetId });
    } catch (error) {
      if (pendingByInstrument.get(instrumentId)?.commitId === commitId) pendingByInstrument.delete(instrumentId);
      logicalInstrumentSnapshot = null;
      preparedMessageFailures += 1;
      throw error;
    }
  }

  function syncProject(project, options = {}) {
    const force = options?.force === true;
    const current = instrumentSnapshot(project);
    if (!force && logicalInstrumentSnapshot && snapshotSignature(current) === snapshotSignature(logicalInstrumentSnapshot)) return false;
    const result = base.syncProject(project, options);
    if (node?.port && (result || force || !logicalInstrumentSnapshot)) {
      pendingByInstrument.clear();
      logicalInstrumentSnapshot = current;
    }
    return result;
  }

  async function activateProject(project, options = {}) {
    pendingByInstrument.clear();
    logicalInstrumentSnapshot = null;
    const result = await base.activateProject(project, options);
    if (node?.port) logicalInstrumentSnapshot = instrumentSnapshot(project);
    return result;
  }

  function invalidatePreparedStateShadow() {
    pendingByInstrument.clear();
    logicalInstrumentSnapshot = null;
  }

  function subscribePreparedStateStatus(listener) {
    if (typeof listener !== "function") throw new TypeError("Prepared-state Host status subscriber must be a function");
    preparedListeners.add(listener);
    return () => preparedListeners.delete(listener);
  }

  function preparedControlSnapshot() {
    return Object.freeze({
      preparedMessages,
      preparedMessageFailures,
      preparedStatusMessages,
      stalePreparedStatuses,
      pendingInstruments: pendingByInstrument.size,
      hasLogicalInstrumentSnapshot: Boolean(logicalInstrumentSnapshot),
      lastPreparedStatus,
    });
  }

  const api = Object.freeze({
    ...base,
    ensurePackageView,
    verifiedPackageViewFor,
    sendLiveParameter,
    attachNode,
    sendPreparedState,
    syncProject,
    activateProject,
    handlePreparedStatus,
    subscribePreparedStateStatus,
    invalidatePreparedStateShadow,
    preparedControlSnapshot,
  });
  globalThis.BRKTRKProductionEngineHost = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
