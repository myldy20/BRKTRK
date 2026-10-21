(() => {
  "use strict";

  const baseRuntime = globalThis.BRKTRKBrkSynthAbiV1Runtime;
  if (!baseRuntime?.createPerformerFactory || !baseRuntime?.BrkSynthAbiError) {
    throw new Error("BRK prepared-state extension requires BRK Synth ABI-v1 runtime");
  }

  function preparedPriority(type) {
    if (type === "note-off") return 3;
    if (type === "note-on") return 7;
    if (type === "retrigger") return 8;
    return 99;
  }

  function createPerformerFactory(record, options = {}) {
    const baseFactory = baseRuntime.createPerformerFactory(record, options);
    const module = record?.module;
    const manifest = record?.manifest;
    const stateCapacity = Number(manifest?.stateBytes ?? manifest?.runtime?.stateBytes ?? 0);
    const preparedLifecycleCapacity = Number.isInteger(options.maxEventsPerPerformer)
      ? options.maxEventsPerPerformer
      : baseRuntime.DEFAULT_MAX_EVENTS_PER_PERFORMER;
    if (!module?.HEAPU8 || typeof module._malloc !== "function" || !Number.isSafeInteger(stateCapacity) || stateCapacity < 1) {
      throw new baseRuntime.BrkSynthAbiError("prepared-state-capability", "BRK prepared-state performer requires module memory plus a positive verified stateBytes capacity");
    }
    if (!Number.isSafeInteger(preparedLifecycleCapacity) || preparedLifecycleCapacity < 1) {
      throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-capacity", "BRK prepared-state performer requires a positive prepared lifecycle capacity");
    }

    // The same Instrument state is committed to every Track×Instrument
    // performer using this exact engine record. Keep one extra ABI scratch
    // buffer per active Instrument, not per Track, and allocate it while the
    // performer graph is prepared — never when a prepared-state message arrives
    // and never inside AudioWorkletProcessor.process().
    const stagingByInstrument = new Map();

    function acquire(instrumentId) {
      const id = Number(instrumentId);
      let staging = stagingByInstrument.get(id) ?? null;
      if (staging) {
        staging.refs += 1;
        return staging;
      }
      const ptr = Number(module._malloc(stateCapacity));
      if (!Number.isSafeInteger(ptr) || ptr <= 0) {
        throw new baseRuntime.BrkSynthAbiError("prepared-state-out-of-memory", `could not allocate ${stateCapacity} byte prepared-state scratch for Instrument ${id}`);
      }
      staging = { instrumentId: id, ptr, refs: 1, byteLength: 0, schemaVersion: null, stages: 0, commits: 0 };
      stagingByInstrument.set(id, staging);
      return staging;
    }

    function release(staging) {
      staging.refs = Math.max(0, staging.refs - 1);
      if (staging.refs > 0) return;
      stagingByInstrument.delete(staging.instrumentId);
      try { module._free?.(staging.ptr); } catch {}
    }

    function makePerformer(args = {}) {
      const performer = baseFactory(args);
      let staging;
      try { staging = acquire(args.instrumentId); }
      catch (error) {
        try { performer.destroy?.(); } catch {}
        throw error;
      }
      let destroyed = false;
      let preparedLifecyclePending = 0;
      let reservationToken = 0;
      let reservationCount = 0;
      let reservedType0 = null;
      let reservedOffset0 = 0;
      let reservedPitch0 = 0;
      let reservedVelocity0 = 100;
      let reservedType1 = null;
      let reservedOffset1 = 0;
      let reservedPitch1 = 0;
      let reservedVelocity1 = 100;

      function clearLifecycleReservation() {
        reservationCount = 0;
        reservedType0 = null;
        reservedType1 = null;
      }

      function requireNoLifecycleReservation() {
        if (reservationCount !== 0) {
          throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-reserved", "prepared lifecycle mutation is blocked while a bounded reservation is active");
        }
      }

      function preflightPreparedLifecycle(type, sampleOffset, pitch, velocity = 100) {
        requireNoLifecycleReservation();
        return performer.preflightPreparedLifecycle(type, sampleOffset, pitch, velocity);
      }

      function handlePreparedLifecycle(type, sampleOffset, pitch, velocity = 100) {
        requireNoLifecycleReservation();
        const result = performer.handlePreparedLifecycle(type, sampleOffset, pitch, velocity);
        preparedLifecyclePending += 1;
        return result;
      }

      function reservePreparedLifecyclePair(
        type0,
        sampleOffset0,
        pitch0,
        velocity0 = 100,
        type1 = null,
        sampleOffset1 = 0,
        pitch1 = 0,
        velocity1 = 100,
      ) {
        requireNoLifecycleReservation();
        const demand = type1 === null || type1 === undefined ? 1 : 2;
        if (preparedLifecyclePending + demand > preparedLifecycleCapacity) {
          throw new baseRuntime.BrkSynthAbiError(
            "event-capacity",
            `prepared lifecycle capacity ${preparedLifecycleCapacity} exceeded by bounded reservation`,
            { capacity: preparedLifecycleCapacity, pending: preparedLifecyclePending, demand },
          );
        }

        // Primitive preflight validates the exact performer state that exists
        // before either reserved mutation. Pair-internal order is checked
        // separately because the second event is intentionally not visible to
        // the primitive preflight yet.
        performer.preflightPreparedLifecycle(type0, sampleOffset0, pitch0, velocity0);
        if (demand === 2) {
          performer.preflightPreparedLifecycle(type1, sampleOffset1, pitch1, velocity1);
          const firstOffset = Number(sampleOffset0);
          const secondOffset = Number(sampleOffset1);
          const firstPriority = preparedPriority(type0);
          const secondPriority = preparedPriority(type1);
          if (secondOffset < firstOffset || (secondOffset === firstOffset && secondPriority < firstPriority)) {
            throw new baseRuntime.BrkSynthAbiError(
              "event-order",
              "bounded prepared lifecycle reservation must preserve non-decreasing sampleOffset/priority order",
              { firstOffset, firstPriority, secondOffset, secondPriority },
            );
          }
        }

        reservedType0 = type0;
        reservedOffset0 = sampleOffset0;
        reservedPitch0 = pitch0;
        reservedVelocity0 = velocity0;
        if (demand === 2) {
          reservedType1 = type1;
          reservedOffset1 = sampleOffset1;
          reservedPitch1 = pitch1;
          reservedVelocity1 = velocity1;
        } else {
          reservedType1 = null;
        }
        reservationCount = demand;
        reservationToken = reservationToken >= 0x7ffffffe ? 1 : reservationToken + 1;
        return reservationToken;
      }

      function cancelPreparedLifecycleReservation(token) {
        if (reservationCount === 0 || Number(token) !== reservationToken) {
          throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-reservation-token", "prepared lifecycle reservation token is not active");
        }
        clearLifecycleReservation();
        return true;
      }

      function commitPreparedLifecycleReservation(token) {
        if (reservationCount === 0 || Number(token) !== reservationToken) {
          throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-reservation-token", "prepared lifecycle reservation token is not active");
        }
        const count = reservationCount;
        try {
          // Capacity and order were proven before this phase. Commit through the
          // existing primitive performer path in deterministic release→trigger
          // order; no BRK Synth C ABI or DSP semantic changes are introduced.
          performer.handlePreparedLifecycle(reservedType0, reservedOffset0, reservedPitch0, reservedVelocity0);
          preparedLifecyclePending += 1;
          if (count === 2) {
            performer.handlePreparedLifecycle(reservedType1, reservedOffset1, reservedPitch1, reservedVelocity1);
            preparedLifecyclePending += 1;
          }
          return count;
        } finally {
          clearLifecycleReservation();
        }
      }

      function process(input) {
        try { return performer.process(input); }
        finally {
          preparedLifecyclePending = 0;
          clearLifecycleReservation();
        }
      }

      function reset() {
        try { return performer.reset?.(); }
        finally {
          preparedLifecyclePending = 0;
          clearLifecycleReservation();
        }
      }

      function stagePreparedState(input = {}) {
        if (destroyed) throw new baseRuntime.BrkSynthAbiError("performer-destroyed", "cannot stage state for a destroyed performer");
        const bytes = input.stateBytes;
        const schemaVersion = Number(input.stateSchemaVersion);
        if (!(bytes instanceof Uint8Array)) throw new baseRuntime.BrkSynthAbiError("prepared-state-bytes", "prepared state requires Uint8Array bytes");
        if (bytes.byteLength !== stateCapacity) {
          throw new baseRuntime.BrkSynthAbiError("prepared-state-size", `prepared state contains ${bytes.byteLength} bytes, expected ${stateCapacity}`);
        }
        if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0 || schemaVersion !== Number(manifest.stateSchemaVersion)) {
          throw new baseRuntime.BrkSynthAbiError("prepared-state-schema", `prepared state schema ${String(input.stateSchemaVersion)} does not match ${String(manifest.stateSchemaVersion)}`);
        }
        module.HEAPU8.set(bytes, staging.ptr);
        staging.byteLength = bytes.byteLength;
        staging.schemaVersion = schemaVersion;
        staging.stages += 1;
        return bytes.byteLength;
      }

      function commitPreparedState() {
        if (destroyed) throw new baseRuntime.BrkSynthAbiError("performer-destroyed", "cannot commit state for a destroyed performer");
        if (staging.byteLength !== stateCapacity || staging.schemaVersion !== Number(manifest.stateSchemaVersion)) {
          throw new baseRuntime.BrkSynthAbiError("prepared-state-not-staged", `Instrument ${staging.instrumentId} has no complete prepared state staged`);
        }
        const handle = Number(performer.diagnostics?.().handle);
        if (!Number.isSafeInteger(handle) || handle <= 0) {
          throw new baseRuntime.BrkSynthAbiError("prepared-state-handle", "prepared state requires a live BRK performer handle");
        }
        reset();
        const deactivate = Number(module._brk_instance_deactivate(handle));
        if (deactivate !== 0) throw new baseRuntime.BrkSynthAbiError("abi-call-failed", `brk_instance_deactivate failed with BRK result ${deactivate}`, { operation: "brk_instance_deactivate", result: deactivate });
        try {
          const read = Number(module._brk_instance_state_read(handle, staging.ptr, staging.byteLength, staging.schemaVersion));
          if (read !== 0) throw new baseRuntime.BrkSynthAbiError("abi-call-failed", `brk_instance_state_read failed with BRK result ${read}`, { operation: "brk_instance_state_read", result: read });
        } finally {
          const activate = Number(module._brk_instance_activate(handle));
          if (activate !== 0) throw new baseRuntime.BrkSynthAbiError("abi-call-failed", `brk_instance_activate failed with BRK result ${activate}`, { operation: "brk_instance_activate", result: activate });
        }
        staging.commits += 1;
        return true;
      }

      function destroy() {
        if (destroyed) return;
        destroyed = true;
        preparedLifecyclePending = 0;
        clearLifecycleReservation();
        try { performer.destroy?.(); }
        finally { release(staging); }
      }

      function diagnostics() {
        const base = performer.diagnostics?.() ?? {};
        return Object.freeze({
          ...base,
          preparedLifecycleCapacity,
          preparedLifecyclePending,
          preparedLifecycleReserved: reservationCount,
          preparedState: Object.freeze({
            scratchBytes: stateCapacity,
            stagedByteLength: staging.byteLength,
            stagedSchemaVersion: staging.schemaVersion,
            stages: staging.stages,
            commits: staging.commits,
          }),
        });
      }

      return Object.freeze({
        ...performer,
        preflightPreparedLifecycle,
        handlePreparedLifecycle,
        reservePreparedLifecyclePair,
        cancelPreparedLifecycleReservation,
        commitPreparedLifecycleReservation,
        process,
        reset,
        stagePreparedState,
        commitPreparedState,
        destroy,
        diagnostics,
      });
    }

    makePerformer.diagnostics = () => Object.freeze({
      ...(baseFactory.diagnostics?.() ?? {}),
      preparedStateScratchBuffers: stagingByInstrument.size,
      preparedStateScratchBytes: stagingByInstrument.size * stateCapacity,
      preparedLifecycleCapacity,
    });
    return Object.freeze(makePerformer);
  }

  const api = Object.freeze({ ...baseRuntime, createPerformerFactory });
  globalThis.BRKTRKBrkSynthAbiV1Runtime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
