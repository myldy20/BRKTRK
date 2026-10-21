(() => {
  "use strict";

  const baseDomain = globalThis.BRKTRKSynthGatewayDomain;
  if (!baseDomain?.createSynthGateway) {
    throw new Error("prepared-state gateway extension requires SynthGateway");
  }

  class PreparedStateGatewayError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "PreparedStateGatewayError";
      this.code = String(code || "prepared-state-gateway-error");
      this.details = Object.freeze({ ...details });
    }
  }

  const text = (value) => String(value ?? "").trim();
  const sameIdentity = (entry, identity) => Boolean(entry && identity)
    && text(entry.moduleId) === text(identity.moduleId)
    && text(entry.engineId) === text(identity.engineId)
    && text(entry.version) === text(identity.version)
    && text(entry.packageSha256).toLowerCase() === text(identity.packageSha256).toLowerCase();

  function parameterSnapshotFor(commit, manifest) {
    const descriptors = Array.isArray(manifest?.parameters) ? manifest.parameters : [];
    if (commit.parameterIds.length !== descriptors.length || commit.parameterValues.length !== descriptors.length) {
      throw new PreparedStateGatewayError("parameter-schema", "Prepared state parameter payload does not match active engine schema");
    }
    const snapshot = {};
    for (let index = 0; index < descriptors.length; index += 1) {
      const expected = text(descriptors[index]?.id ?? descriptors[index]?.key);
      const actual = text(commit.parameterIds[index]);
      const value = commit.parameterValues[index];
      if (!expected || actual !== expected) {
        throw new PreparedStateGatewayError("parameter-schema", `Prepared parameter ${actual || "<empty>"} does not match active schema position ${expected || index}`, { index, expected, actual });
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new PreparedStateGatewayError("parameter-value", `Prepared parameter ${actual} is outside normalized [0,1]`, { index, parameterId: actual });
      }
      snapshot[actual] = value;
    }
    return Object.freeze(snapshot);
  }

  let captureToken = null;
  const captured = new Map();

  function beginCapture(token) {
    if (captureToken !== null) throw new Error("prepared-state gateway capture cannot be nested");
    captureToken = token;
    captured.delete(token);
  }

  function finishCapture(token) {
    if (captureToken !== token) throw new Error("prepared-state gateway capture token mismatch");
    captureToken = null;
    const gateway = captured.get(token) ?? null;
    captured.delete(token);
    return gateway;
  }

  function createSynthGateway(options = {}) {
    const performerRegistry = options.performerRegistry;
    const gateway = baseDomain.createSynthGateway(options);
    if (!performerRegistry?.prepared || !performerRegistry?.forEachTrack || !performerRegistry?.engineRecord) {
      throw new TypeError("prepared-state gateway requires generic PerformerRegistry engine-record access");
    }

    const staged = new Map();
    let active = false;
    let stagedCount = 0;
    let appliedCount = 0;
    let failedCount = 0;
    let reconciledCount = 0;

    function runtimeRecord(commit) {
      const record = performerRegistry.engineRecord(commit?.instrumentId);
      if (!record || !sameIdentity(record.entry, commit?.exactEngineIdentity)) {
        throw new PreparedStateGatewayError("exact-engine-identity", "Prepared state exact engine/package identity is not active in the generic EngineRegistry", {
          instrumentId: commit?.instrumentId ?? null,
          commitId: commit?.commitId ?? null,
        });
      }
      if (Number(record.manifest?.stateSchemaVersion) !== Number(commit.stateSchemaVersion)) {
        throw new PreparedStateGatewayError("state-schema", "Prepared state schema does not match active engine manifest", {
          expected: record.manifest?.stateSchemaVersion ?? null,
          actual: commit.stateSchemaVersion,
        });
      }
      if (Number(record.manifest?.stateBytes) !== Number(commit.stateBytes?.byteLength)) {
        throw new PreparedStateGatewayError("state-size", "Prepared state byte length does not match active engine manifest", {
          expected: record.manifest?.stateBytes ?? null,
          actual: commit.stateBytes?.byteLength ?? null,
        });
      }
      return record;
    }

    function targetSlots(instrumentId) {
      const slots = [];
      for (let track = 0; track < performerRegistry.trackCount; track += 1) {
        const slot = performerRegistry.prepared(track, instrumentId);
        if (slot) slots.push(slot);
      }
      return slots;
    }

    function assertSlotCapability(slot, commit) {
      if (!sameIdentity(slot.engine?.entry, commit.exactEngineIdentity)) {
        throw new PreparedStateGatewayError("performer-engine-identity", `Track ${slot.track} × Instrument ${slot.instrumentId} does not use the prepared exact engine identity`, {
          track: slot.track,
          instrumentId: slot.instrumentId,
        });
      }
      if (typeof slot.performer?.stagePreparedState !== "function" || typeof slot.performer?.commitPreparedState !== "function") {
        throw new PreparedStateGatewayError("performer-prepared-state-capability", `Track ${slot.track} × Instrument ${slot.instrumentId} performer does not expose a prepared-state boundary`, {
          track: slot.track,
          instrumentId: slot.instrumentId,
        });
      }
      return slot;
    }

    function stagePreparedState(commit) {
      if (active) throw new PreparedStateGatewayError("stage-boundary", "Prepared state staging is forbidden while SynthGateway block is active");
      if (!(commit?.stateBytes instanceof Uint8Array)) throw new PreparedStateGatewayError("state-bytes", "Prepared state gateway requires Uint8Array bytes");
      const record = runtimeRecord(commit);
      const parameterSnapshot = parameterSnapshotFor(commit, record.manifest);
      const slots = targetSlots(commit.instrumentId).map((slot) => assertSlotCapability(slot, commit));
      // Performers for one exact engine may share an adapter-owned scratch
      // buffer per Instrument. Stage once; every Track×Instrument commit reads
      // the same already copied bytes through the performer boundary.
      if (slots.length > 0) slots[0].performer.stagePreparedState({ stateBytes: commit.stateBytes, stateSchemaVersion: commit.stateSchemaVersion });
      staged.set(commit.instrumentId, Object.freeze({
        instrumentId: commit.instrumentId,
        commitId: commit.commitId,
        exactEngineIdentity: commit.exactEngineIdentity,
        stateSchemaVersion: commit.stateSchemaVersion,
        stateByteLength: commit.stateBytes.byteLength,
        parameterSnapshot,
        slots: Object.freeze(slots.map((slot) => Object.freeze({ track: slot.track, performer: slot.performer }))),
      }));
      stagedCount += 1;
      return Object.freeze({ instrumentId: commit.instrumentId, commitId: commit.commitId, preparedPerformers: slots.length });
    }

    function discardPreparedState(instrumentId, commitId) {
      const current = staged.get(Number(instrumentId));
      if (!current || current.commitId !== Number(commitId)) return false;
      staged.delete(Number(instrumentId));
      return true;
    }

    function assertPreparedSet(current) {
      const live = targetSlots(current.instrumentId);
      if (live.length !== current.slots.length) {
        throw new PreparedStateGatewayError("performer-set-changed", "Prepared performer set changed after control-plane staging", {
          instrumentId: current.instrumentId,
          preparedCount: current.slots.length,
          liveCount: live.length,
        });
      }
      for (const slot of live) {
        assertSlotCapability(slot, current);
        const prepared = current.slots.find((candidate) => candidate.track === slot.track);
        if (!prepared || prepared.performer !== slot.performer) {
          throw new PreparedStateGatewayError("performer-set-changed", "Prepared performer identity changed after control-plane staging", {
            instrumentId: current.instrumentId,
            track: slot.track,
          });
        }
      }
      return live;
    }

    function applyStagedState(instrumentId, commitId) {
      if (active) throw new PreparedStateGatewayError("apply-boundary", "Prepared state must commit before SynthGateway.beginBlock()");
      const current = staged.get(Number(instrumentId));
      if (!current || current.commitId !== Number(commitId)) {
        throw new PreparedStateGatewayError("staged-commit", "Prepared state commit is not staged for this gateway", { instrumentId, commitId });
      }
      const live = assertPreparedSet(current);
      try {
        for (const slot of live) {
          slot.performer.commitPreparedState();
          slot.performer.applyState?.({ parameterSnapshot: current.parameterSnapshot });
        }
        staged.delete(current.instrumentId);
        appliedCount += 1;
        return Object.freeze({ instrumentId: current.instrumentId, commitId: current.commitId, appliedPerformers: live.length });
      } catch (error) {
        failedCount += 1;
        throw error;
      }
    }

    function reconcilePreparedState(commit) {
      if (active) throw new PreparedStateGatewayError("reconcile-boundary", "Prepared state reconciliation requires an inactive SynthGateway");
      stagePreparedState(commit);
      const result = applyStagedState(commit.instrumentId, commit.commitId);
      reconciledCount += 1;
      return result;
    }

    function clearPreparedState() {
      if (active) throw new PreparedStateGatewayError("clear-boundary", "Prepared state tracking cannot be cleared during an active SynthGateway block");
      staged.clear();
      return true;
    }

    function beginBlock(...args) {
      const result = gateway.beginBlock(...args);
      active = true;
      return result;
    }

    function endBlock(...args) {
      try { return gateway.endBlock(...args); }
      finally { active = false; }
    }

    function preparedStateDiagnostics() {
      return Object.freeze({
        active,
        staged: staged.size,
        stagedCount,
        appliedCount,
        failedCount,
        reconciledCount,
        stagedCommits: Object.freeze([...staged.values()].map((item) => Object.freeze({
          instrumentId: item.instrumentId,
          commitId: item.commitId,
          stateByteLength: item.stateByteLength,
          preparedPerformers: item.slots.length,
        }))),
      });
    }

    const extended = Object.freeze({
      ...gateway,
      beginBlock,
      endBlock,
      stagePreparedState,
      discardPreparedState,
      applyStagedState,
      reconcilePreparedState,
      clearPreparedState,
      preparedStateDiagnostics,
    });
    if (captureToken !== null) captured.set(captureToken, extended);
    return extended;
  }

  globalThis.BRKTRKSynthGatewayDomain = Object.freeze({ ...baseDomain, createSynthGateway, PreparedStateGatewayError });
  globalThis.BRKTRKPreparedStateGatewayCapture = Object.freeze({ beginCapture, finishCapture });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Object.freeze({ createSynthGateway, PreparedStateGatewayError, beginCapture, finishCapture });
  }
})();
