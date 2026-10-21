(() => {
  "use strict";

  const SHA256_RE = /^[0-9a-f]{64}$/;
  const SUPPORTED_SUBTYPES = Object.freeze(new Set(["instrument.preset", "instrument.patch"]));
  const MIN_INSTRUMENT_ID = 0;
  const MAX_INSTRUMENT_ID = 255;

  class PreparedStateQueueError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "PreparedStateQueueError";
      this.code = String(code || "prepared-state-queue-error");
      this.details = Object.freeze({ ...details });
    }
  }

  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const text = (value) => String(value ?? "").trim();
  const normalizedSha = (value) => text(value).toLowerCase();

  function instrumentId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < MIN_INSTRUMENT_ID || id > MAX_INSTRUMENT_ID) {
      throw new PreparedStateQueueError("instrument-id", `Instrument id must be 00–FF, got ${String(value)}`);
    }
    return id;
  }

  function commitId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new PreparedStateQueueError("commit-id", "Prepared state commitId must be a positive safe integer");
    }
    return id;
  }

  function exactIdentity(value) {
    if (!object(value)) throw new PreparedStateQueueError("exact-engine-identity", "Prepared state requires exact engine identity");
    const moduleId = text(value.moduleId);
    const engineId = text(value.engineId);
    const version = text(value.version ?? value.resolvedVersion);
    const packageSha256 = normalizedSha(value.packageSha256 ?? value.resolvedPackageSha256);
    if (!moduleId || !engineId || !version || !SHA256_RE.test(packageSha256)) {
      throw new PreparedStateQueueError("exact-engine-identity", "Prepared state exact engine identity is incomplete or invalid");
    }
    return Object.freeze({ moduleId, engineId, version, packageSha256 });
  }

  function normalizedParameters(idsValue, valuesValue) {
    if (!Array.isArray(idsValue) || !Array.isArray(valuesValue) || idsValue.length !== valuesValue.length) {
      throw new PreparedStateQueueError("parameter-shape", "Prepared parameter ids/values must be equal-length arrays");
    }
    const ids = [];
    const values = [];
    const seen = new Set();
    for (let index = 0; index < idsValue.length; index += 1) {
      const id = text(idsValue[index]);
      const value = valuesValue[index];
      if (!id || seen.has(id)) throw new PreparedStateQueueError("parameter-id", "Prepared parameter ids must be unique non-empty strings", { index });
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new PreparedStateQueueError("parameter-value", `Prepared parameter ${id} must be numeric normalized [0,1]`, { index, parameterId: id });
      }
      seen.add(id);
      ids.push(id);
      values.push(value);
    }
    return Object.freeze({ ids: Object.freeze(ids), values: Object.freeze(values) });
  }

  function normalizeCommit(input = {}) {
    const id = instrumentId(input.instrumentId);
    const sequence = commitId(input.commitId);
    const identity = exactIdentity(input.exactEngineIdentity);
    const schemaVersion = Number(input.stateSchemaVersion);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
      throw new PreparedStateQueueError("state-schema", "Prepared state schemaVersion must be a non-negative safe integer");
    }
    if (!(input.stateBytes instanceof Uint8Array)) {
      throw new PreparedStateQueueError("state-bytes", "Prepared state Worklet payload must contain Uint8Array stateBytes");
    }
    const subtype = String(input.sourceSubtype ?? "");
    if (!SUPPORTED_SUBTYPES.has(subtype)) {
      throw new PreparedStateQueueError("source-subtype", "Prepared state is limited to instrument.preset / instrument.patch");
    }
    const parameters = normalizedParameters(input.parameterIds, input.parameterValues);

    // MessagePort structured cloning/transfer gives the Worklet its own payload,
    // but the domain also copies here so direct callers/tests cannot mutate a
    // queued commit after validation. This staging allocation happens in the
    // Worklet control-message callback, never in AudioWorkletProcessor.process().
    const stateBytes = input.stateBytes.slice();
    return {
      instrumentId: id,
      commitId: sequence,
      exactEngineIdentity: identity,
      stateSchemaVersion: schemaVersion,
      stateBytes,
      parameterIds: parameters.ids,
      parameterValues: parameters.values,
      sourceSubtype: subtype,
      desiredPresetId: input.desiredPresetId == null ? null : String(input.desiredPresetId),
    };
  }

  function createQueue() {
    const pending = new Map();
    const applying = new Map();
    const lastSeen = new Map();
    const lastApplied = new Map();
    let staged = 0;
    let superseded = 0;
    let staleRejected = 0;
    let applied = 0;
    let failed = 0;

    function stage(input = {}) {
      const normalized = normalizeCommit(input);
      const id = normalized.instrumentId;
      const sequence = normalized.commitId;
      const seen = lastSeen.get(id) ?? 0;
      if (sequence <= seen) {
        staleRejected += 1;
        throw new PreparedStateQueueError("stale-commit", `Prepared state commit ${sequence} is not newer than ${seen} for Instrument ${id}`, {
          instrumentId: id,
          commitId: sequence,
          lastSeenCommitId: seen,
        });
      }
      const previous = pending.get(id) ?? null;
      if (previous) superseded += 1;
      lastSeen.set(id, sequence);
      pending.set(id, normalized);
      staged += 1;
      return Object.freeze({
        state: "queued",
        instrumentId: id,
        commitId: sequence,
        supersededCommitId: previous?.commitId ?? null,
        desiredPresetId: normalized.desiredPresetId,
      });
    }

    function nextPending() {
      if (pending.size === 0) return null;
      let selected = null;
      for (const candidate of pending.values()) {
        if (!selected || candidate.instrumentId < selected.instrumentId) selected = candidate;
      }
      return selected;
    }

    function beginNext() {
      const selected = nextPending();
      if (!selected) return null;
      const id = selected.instrumentId;
      if (applying.has(id)) throw new PreparedStateQueueError("already-applying", `Instrument ${id} already has an applying prepared state`);
      pending.delete(id);
      applying.set(id, selected);
      return selected;
    }

    function finishApplied(idValue, commitValue) {
      const id = instrumentId(idValue);
      const sequence = commitId(commitValue);
      const current = applying.get(id);
      if (!current || current.commitId !== sequence) {
        throw new PreparedStateQueueError("apply-token", `Prepared state applied token ${id}/${sequence} does not match current applying commit`);
      }
      applying.delete(id);
      lastApplied.set(id, sequence);
      applied += 1;
      return Object.freeze({ state: "applied", instrumentId: id, commitId: sequence, desiredPresetId: current.desiredPresetId });
    }

    function finishFailed(idValue, commitValue, reason = null) {
      const id = instrumentId(idValue);
      const sequence = commitId(commitValue);
      const current = applying.get(id);
      if (!current || current.commitId !== sequence) {
        throw new PreparedStateQueueError("apply-token", `Prepared state failed token ${id}/${sequence} does not match current applying commit`);
      }
      applying.delete(id);
      failed += 1;
      return Object.freeze({ state: "failed", instrumentId: id, commitId: sequence, desiredPresetId: current.desiredPresetId, reason: reason == null ? null : String(reason) });
    }

    function snapshot() {
      return Object.freeze({
        pending: pending.size,
        applying: applying.size,
        staged,
        superseded,
        staleRejected,
        applied,
        failed,
        lastSeen: Object.freeze([...lastSeen.entries()].sort((left, right) => left[0] - right[0]).map(([id, sequence]) => Object.freeze({ instrumentId: id, commitId: sequence }))),
        lastApplied: Object.freeze([...lastApplied.entries()].sort((left, right) => left[0] - right[0]).map(([id, sequence]) => Object.freeze({ instrumentId: id, commitId: sequence }))),
        pendingCommits: Object.freeze([...pending.values()].sort((left, right) => left.instrumentId - right.instrumentId).map((item) => Object.freeze({
          instrumentId: item.instrumentId,
          commitId: item.commitId,
          sourceSubtype: item.sourceSubtype,
          desiredPresetId: item.desiredPresetId,
          stateByteLength: item.stateBytes.byteLength,
          parameterCount: item.parameterIds.length,
        }))),
      });
    }

    return Object.freeze({ stage, beginNext, finishApplied, finishFailed, snapshot });
  }

  const api = Object.freeze({
    MIN_INSTRUMENT_ID,
    MAX_INSTRUMENT_ID,
    PreparedStateQueueError,
    exactIdentity,
    normalizeCommit,
    createQueue,
  });

  globalThis.BRKTRKPreparedInstrumentStateWorkletDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
