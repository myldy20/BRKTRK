(() => {
  "use strict";

  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  if (!storeTypes?.createTransportChangeSet) {
    throw new Error("Prepared Instrument application state requires TransportStore change-set types");
  }

  const ACK_STATES = Object.freeze(new Set(["queued", "applying", "applied", "failed"]));
  const STATE_RANK = Object.freeze({ requested: 0, queued: 1, applying: 2, applied: 3, failed: 3 });
  const TERMINAL_STATES = Object.freeze(new Set(["applied", "failed"]));

  function instrumentId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 0 || id > 255) throw new RangeError(`Prepared Instrument id must be 00–FF, got ${String(value)}`);
    return id;
  }

  function commitId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError("Prepared Instrument commitId must be a positive safe integer");
    return id;
  }

  function optionalCommitId(value) {
    if (value == null) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
  }

  function immutableRow(value) {
    if (!value) return null;
    return Object.freeze({
      instrumentId: instrumentId(value.instrumentId),
      commitId: commitId(value.commitId),
      state: String(value.state),
      desiredPresetId: value.desiredPresetId == null ? null : String(value.desiredPresetId),
      code: value.code == null ? null : String(value.code),
      reason: value.reason == null ? null : String(value.reason),
      supersededCommitId: optionalCommitId(value.supersededCommitId),
    });
  }

  function createDomain(transportStore) {
    if (!transportStore || transportStore.owner !== "transport" || typeof transportStore.emit !== "function") {
      throw new TypeError("Prepared Instrument application state requires TransportStore");
    }

    const latest = new Map();
    let requests = 0;
    let acknowledgements = 0;
    let staleAcknowledgements = 0;
    let regressiveAcknowledgements = 0;
    let cleared = 0;

    function snapshot() {
      return Object.freeze({
        requests,
        acknowledgements,
        staleAcknowledgements,
        regressiveAcknowledgements,
        cleared,
        applications: Object.freeze([...latest.values()]
          .sort((left, right) => left.instrumentId - right.instrumentId)
          .map((row) => immutableRow(row))),
      });
    }

    function publish(before, after, subtype, source = null) {
      const row = after ?? before;
      const changeSet = storeTypes.createTransportChangeSet({
        subtype,
        target: `transport.preparedInstrumentState.${row.instrumentId}`,
        path: ["preparedInstrumentState", row.instrumentId],
        before,
        after,
        affectsPlayback: false,
        renderTargets: ["instrument.context"],
        source,
        transaction: {
          instrumentId: row.instrumentId,
          commitId: row.commitId,
          state: after?.state ?? null,
        },
      });
      for (const channel of ["transport", "status", "render"]) transportStore.emit(channel, changeSet);
      return changeSet;
    }

    function request(input = {}, metadata = {}) {
      const id = instrumentId(input.instrumentId);
      const sequence = commitId(input.commitId);
      const current = latest.get(id) ?? null;
      if (current && sequence <= current.commitId) {
        return Object.freeze({ accepted: false, stale: true, current: immutableRow(current), snapshot: snapshot() });
      }
      const next = immutableRow({
        instrumentId: id,
        commitId: sequence,
        state: "requested",
        desiredPresetId: input.desiredPresetId,
        code: null,
        reason: null,
        supersededCommitId: current?.commitId ?? null,
      });
      latest.set(id, next);
      requests += 1;
      const changeSet = publish(current ? immutableRow(current) : null, next, "prepared-state.requested", metadata.source);
      return Object.freeze({ accepted: true, stale: false, row: next, changeSet, snapshot: snapshot() });
    }

    function acknowledge(message = {}, metadata = {}) {
      const id = instrumentId(message.instrumentId);
      const sequence = commitId(message.commitId);
      const state = String(message.state ?? "");
      if (!ACK_STATES.has(state)) throw new TypeError(`Unsupported prepared-state acknowledgement: ${state || "<empty>"}`);
      const current = latest.get(id) ?? null;
      if (!current || current.commitId !== sequence) {
        staleAcknowledgements += 1;
        return Object.freeze({ accepted: false, stale: true, current: immutableRow(current), snapshot: snapshot() });
      }
      if (TERMINAL_STATES.has(current.state)) {
        if (current.state === state) return Object.freeze({ accepted: true, stale: false, mutated: false, row: immutableRow(current), snapshot: snapshot() });
        regressiveAcknowledgements += 1;
        return Object.freeze({ accepted: false, stale: true, regressive: true, current: immutableRow(current), snapshot: snapshot() });
      }
      if (STATE_RANK[state] < STATE_RANK[current.state]) {
        regressiveAcknowledgements += 1;
        return Object.freeze({ accepted: false, stale: true, regressive: true, current: immutableRow(current), snapshot: snapshot() });
      }
      if (state === current.state) {
        return Object.freeze({ accepted: true, stale: false, mutated: false, row: immutableRow(current), snapshot: snapshot() });
      }
      const next = immutableRow({
        instrumentId: id,
        commitId: sequence,
        state,
        desiredPresetId: message.desiredPresetId ?? current.desiredPresetId,
        code: message.code,
        reason: message.reason,
        supersededCommitId: current.supersededCommitId,
      });
      latest.set(id, next);
      acknowledgements += 1;
      const changeSet = publish(immutableRow(current), next, `prepared-state.${state}`, metadata.source);
      return Object.freeze({ accepted: true, stale: false, mutated: true, row: next, changeSet, snapshot: snapshot() });
    }

    function get(rawInstrumentId) {
      return immutableRow(latest.get(instrumentId(rawInstrumentId)) ?? null);
    }

    function clear(rawInstrumentId, metadata = {}) {
      const id = instrumentId(rawInstrumentId);
      const current = latest.get(id) ?? null;
      if (!current) return Object.freeze({ mutated: false, row: null, snapshot: snapshot() });
      latest.delete(id);
      cleared += 1;
      const before = immutableRow(current);
      const changeSet = publish(before, null, "prepared-state.cleared", metadata.source);
      return Object.freeze({ mutated: true, row: before, changeSet, snapshot: snapshot() });
    }

    function clearAll(metadata = {}) {
      const ids = [...latest.keys()].sort((left, right) => left - right);
      const rows = [];
      for (const id of ids) {
        const result = clear(id, metadata);
        if (result.mutated) rows.push(result.row);
      }
      return Object.freeze({ mutated: rows.length > 0, rows: Object.freeze(rows), snapshot: snapshot() });
    }

    return Object.freeze({ request, acknowledge, get, clear, clearAll, snapshot });
  }

  function install(transportStore) {
    if (transportStore.preparedInstrumentState) return transportStore.preparedInstrumentState;
    const domain = createDomain(transportStore);
    Object.defineProperty(transportStore, "preparedInstrumentState", {
      value: domain,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    return domain;
  }

  const api = Object.freeze({ createDomain, install, instrumentId, commitId, ACK_STATES });
  globalThis.BRKTRKPreparedInstrumentApplicationState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
