(() => {
  "use strict";

  const baseRuntime = globalThis.BRKTRKBrkSynthAbiV1Runtime;
  if (!baseRuntime?.createPerformerFactory || !baseRuntime?.EVENT || !baseRuntime?.EVENT_SIZE) {
    throw new Error("R6 realtime performer extension requires BRK Synth ABI-v1 runtime");
  }

  const BRK_OK = 0;
  const EVENT = baseRuntime.EVENT;
  const EVENT_SIZE = baseRuntime.EVENT_SIZE;
  const DEFAULT_MAX_BLOCK_FRAMES = baseRuntime.DEFAULT_MAX_BLOCK_FRAMES;
  const DEFAULT_MAX_EVENTS = baseRuntime.DEFAULT_MAX_EVENTS_PER_PERFORMER;
  const MAX_NOTE_ID = 0x7fffffff;
  const PARAM_VALUE = EVENT.PARAM_VALUE;
  const PARAM_RAMP = EVENT.PARAM_RAMP;
  const PREPARED_TYPE = Object.freeze({ "note-off": EVENT.NOTE_OFF, "note-on": EVENT.NOTE_ON, retrigger: EVENT.RETRIGGER });

  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, finite(value, min)));

  function priority(kind) {
    if (kind === EVENT.RESET) return 0;
    if (kind === EVENT.ALL_NOTES_OFF) return 1;
    if (kind === EVENT.NOTE_CHOKE) return 2;
    if (kind === EVENT.NOTE_OFF) return 3;
    if (kind === PARAM_VALUE) return 5;
    if (kind === PARAM_RAMP) return 6;
    if (kind === EVENT.NOTE_ON) return 7;
    if (kind === EVENT.RETRIGGER) return 8;
    return 99;
  }

  function createPerformerFactory(record, options = {}) {
    const baseFactory = baseRuntime.createPerformerFactory(record, options);
    const module = record?.module;
    const manifest = record?.manifest;
    if (!module?.HEAPU8 || !module?.HEAPF32 || typeof module._malloc !== "function") {
      throw new baseRuntime.BrkSynthAbiError("r6-module-memory", "R6 realtime performer requires Emscripten linear memory");
    }

    const maxBlockFrames = Number.isInteger(options.maxBlockFrames) ? options.maxBlockFrames : DEFAULT_MAX_BLOCK_FRAMES;
    const maxEvents = Number.isInteger(options.maxEventsPerPerformer) ? options.maxEventsPerPerformer : DEFAULT_MAX_EVENTS;
    const descriptors = [];
    const parameterHandleById = new Map();
    for (const descriptor of Array.isArray(manifest?.parameters) ? manifest.parameters : []) {
      const id = String(descriptor?.id ?? descriptor?.key ?? "").trim();
      const abiId = Number(descriptor?.abiId ?? descriptor?.numericId ?? descriptor?.parameterId);
      if (!id || !Number.isSafeInteger(abiId) || abiId < 0) continue;
      parameterHandleById.set(id, descriptors.length);
      descriptors.push(Object.freeze({ id, abiId, defaultValue: clamp(descriptor?.defaultNormalized ?? descriptor?.normalized_default ?? descriptor?.default ?? 0, 0, 1) }));
    }
    const parameterCount = descriptors.length;

    function makePerformer(args = {}) {
      const performer = baseFactory(args);
      const handle = Number(performer.diagnostics?.().handle);
      if (!Number.isSafeInteger(handle) || handle <= 0) {
        try { performer.destroy?.(); } catch {}
        throw new baseRuntime.BrkSynthAbiError("r6-performer-handle", "R6 realtime performer requires the prepared BRK instance handle");
      }

      const pointers = [];
      const owned = (size, label) => {
        const ptr = Number(module._malloc(size));
        if (!Number.isSafeInteger(ptr) || ptr <= 0) throw new baseRuntime.BrkSynthAbiError("abi-out-of-memory", `could not allocate R6 ${label} (${size} bytes)`);
        pointers.push(ptr);
        return ptr;
      };
      let destroyed = false;
      let eventPtr = 0;
      let outputPtr = 0;
      let audioSpanPtr = 0;
      let processPtr = 0;
      try {
        eventPtr = owned(maxEvents * EVENT_SIZE.PARAM_RAMP, "event buffer");
        outputPtr = owned(maxBlockFrames * 2 * 4, "stereo output buffer");
        audioSpanPtr = owned(24, "audio span");
        processPtr = owned(64, "process info");
      } catch (error) {
        for (const ptr of pointers) { try { module._free?.(ptr); } catch {} }
        try { performer.destroy?.(); } catch {}
        throw error;
      }

      let cachedBuffer = null;
      let cachedView = null;
      let dataViewRefreshes = 0;
      function dataView() {
        const buffer = module.HEAPU8.buffer;
        if (buffer !== cachedBuffer) {
          cachedBuffer = buffer;
          cachedView = new DataView(buffer);
          dataViewRefreshes += 1;
        }
        return cachedView;
      }
      dataView(); // Prime outside AudioWorkletProcessor.process().

      const qKind = new Uint8Array(maxEvents);
      const qOffset = new Uint32Array(maxEvents);
      const qIndex = new Uint32Array(maxEvents);
      const qValue = new Float64Array(maxEvents);
      const qAux = new Float64Array(maxEvents);
      const qRamp = new Uint32Array(maxEvents);
      let qCount = 0;
      let queueHighWater = 0;

      const parameterAbiId = new Uint32Array(parameterCount);
      const parameterValue = new Float64Array(parameterCount);
      const rampRemaining = new Uint32Array(parameterCount);
      const rampNext = new Uint32Array(parameterCount);
      const deferredDirty = new Uint8Array(parameterCount);
      const deferredValue = new Float64Array(parameterCount);
      const deferredRamp = new Uint32Array(parameterCount);
      const deferredOffset = new Uint32Array(parameterCount);
      for (let index = 0; index < parameterCount; index += 1) {
        parameterAbiId[index] = descriptors[index].abiId >>> 0;
        parameterValue[index] = descriptors[index].defaultValue;
      }

      let currentNoteId = 0;
      let currentNotePitch = 0;
      let currentNoteVelocity = 0;
      let nextNoteId = 1;
      let parameterEventsEncoded = 0;
      let parameterRampEventsEncoded = 0;
      let parameterEventsDeferred = 0;
      let parameterEventsCoalesced = 0;
      let preparedLifecyclePending = 0;
      let preparedLifecycleHighWater = 0;
      let reservationToken = 0;
      let reservationCount = 0;
      let reservedKind0 = 0;
      let reservedOffset0 = 0;
      let reservedPitch0 = 0;
      let reservedVelocity0 = 100;
      let reservedKind1 = 0;
      let reservedOffset1 = 0;
      let reservedPitch1 = 0;
      let reservedVelocity1 = 100;

      function allocateNoteId() {
        const result = nextNoteId;
        nextNoteId = nextNoteId >= MAX_NOTE_ID ? 1 : nextNoteId + 1;
        return result;
      }

      function assertAlive() {
        if (destroyed) throw new baseRuntime.BrkSynthAbiError("performer-destroyed", "cannot use a destroyed R6 performer");
      }

      function eventBefore(offsetA, kindA, offsetB, kindB) {
        return offsetA < offsetB || (offsetA === offsetB && priority(kindA) <= priority(kindB));
      }

      function removeAt(index) {
        for (let cursor = index; cursor < qCount - 1; cursor += 1) {
          qKind[cursor] = qKind[cursor + 1];
          qOffset[cursor] = qOffset[cursor + 1];
          qIndex[cursor] = qIndex[cursor + 1];
          qValue[cursor] = qValue[cursor + 1];
          qAux[cursor] = qAux[cursor + 1];
          qRamp[cursor] = qRamp[cursor + 1];
        }
        qCount -= 1;
      }

      function enqueue(kind, offset, index = 0, value = 0, aux = 0, ramp = 0) {
        if (qCount >= maxEvents) throw new baseRuntime.BrkSynthAbiError("event-capacity", `R6 performer event capacity ${maxEvents} exceeded`, { count: qCount + 1 });
        let insert = qCount;
        while (insert > 0 && !eventBefore(qOffset[insert - 1], qKind[insert - 1], offset, kind)) {
          qKind[insert] = qKind[insert - 1];
          qOffset[insert] = qOffset[insert - 1];
          qIndex[insert] = qIndex[insert - 1];
          qValue[insert] = qValue[insert - 1];
          qAux[insert] = qAux[insert - 1];
          qRamp[insert] = qRamp[insert - 1];
          insert -= 1;
        }
        qKind[insert] = kind;
        qOffset[insert] = offset;
        qIndex[insert] = index;
        qValue[insert] = value;
        qAux[insert] = aux;
        qRamp[insert] = ramp;
        qCount += 1;
        if (qCount > queueHighWater) queueHighWater = qCount;
        return qCount;
      }

      function parameterHandle(parameterId) {
        const id = String(parameterId ?? "").trim();
        return parameterHandleById.has(id) ? parameterHandleById.get(id) : -1;
      }

      function preflightPreparedParameter(handleIndex, sampleOffset = 0, rampFrames = 0) {
        assertAlive();
        const index = Number(handleIndex);
        const offset = Number(sampleOffset);
        const ramp = Number(rampFrames);
        if (!Number.isSafeInteger(index) || index < 0 || index >= parameterCount) throw new baseRuntime.BrkSynthAbiError("unknown-parameter", `unknown prepared parameter handle ${String(handleIndex)}`);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= maxBlockFrames) throw new baseRuntime.BrkSynthAbiError("event-offset", `prepared parameter sample offset ${String(sampleOffset)} outside 0..${maxBlockFrames - 1}`);
        if (!Number.isSafeInteger(ramp) || ramp < 0) throw new baseRuntime.BrkSynthAbiError("parameter-ramp", "prepared parameter rampFrames must be a non-negative safe integer");
        if (qCount >= maxEvents && Number(rampRemaining[index]) <= offset) throw new baseRuntime.BrkSynthAbiError("event-capacity", `R6 performer event capacity ${maxEvents} exceeded`, { count: qCount + 1 });
        return true;
      }

      function handlePreparedParameter(handleIndex, value, sampleOffset = 0, rampFrames = 0) {
        preflightPreparedParameter(handleIndex, sampleOffset, rampFrames);
        const index = Number(handleIndex);
        const offset = Number(sampleOffset);
        const ramp = Number(rampFrames);
        const normalized = clamp(value, 0, 1);
        if (Number(rampRemaining[index]) > offset) {
          if (deferredDirty[index]) parameterEventsCoalesced += 1;
          deferredDirty[index] = 1;
          deferredValue[index] = normalized;
          deferredRamp[index] = ramp;
          deferredOffset[index] = offset;
          parameterEventsDeferred += 1;
          return false;
        }
        for (let cursor = 0; cursor < qCount; cursor += 1) {
          if ((qKind[cursor] === PARAM_VALUE || qKind[cursor] === PARAM_RAMP) && qIndex[cursor] === index && qOffset[cursor] === offset) {
            removeAt(cursor);
            parameterEventsCoalesced += 1;
            break;
          }
        }
        const kind = ramp > 0 ? PARAM_RAMP : PARAM_VALUE;
        enqueue(kind, offset, index, normalized, 0, ramp);
        return true;
      }

      function discardDeferredParameter(handleIndex) {
        if (!deferredDirty[handleIndex]) return;
        deferredDirty[handleIndex] = 0;
        parameterEventsCoalesced += 1;
      }

      function promoteDeferredParameters() {
        for (let index = 0; index < parameterCount; index += 1) {
          if (!deferredDirty[index]) continue;
          const offset = deferredOffset[index];
          if (Number(rampRemaining[index]) > offset) continue;
          const value = deferredValue[index];
          const ramp = deferredRamp[index];
          deferredDirty[index] = 0;
          handlePreparedParameter(index, value, offset, ramp);
        }
      }

      function preflightPreparedLifecycle(type, sampleOffset, pitch, velocity = 100) {
        assertAlive();
        const kind = PREPARED_TYPE[type] ?? 0;
        const offset = Number(sampleOffset);
        const note = Number(pitch);
        const normalizedVelocity = Number(velocity);
        if (!kind) throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-type", `unsupported prepared lifecycle action ${String(type)}`);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= maxBlockFrames) throw new baseRuntime.BrkSynthAbiError("event-offset", `prepared lifecycle sample offset ${String(sampleOffset)} outside 0..${maxBlockFrames - 1}`);
        if (!Number.isFinite(note) || (type !== "note-off" && (note < 0 || note > 127))) throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-pitch", `prepared lifecycle pitch ${String(pitch)} is invalid`);
        if (!Number.isFinite(normalizedVelocity)) throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-velocity", "prepared lifecycle velocity must be finite");
        if (qCount >= maxEvents) throw new baseRuntime.BrkSynthAbiError("event-capacity", `R6 performer event capacity ${maxEvents} exceeded`, { count: qCount + 1 });
        return true;
      }

      function handlePreparedLifecycle(type, sampleOffset, pitch, velocity = 100) {
        preflightPreparedLifecycle(type, sampleOffset, pitch, velocity);
        enqueue(PREPARED_TYPE[type], Number(sampleOffset), 0, Number(pitch), Number(velocity), 0);
        preparedLifecyclePending += 1;
        if (preparedLifecyclePending > preparedLifecycleHighWater) preparedLifecycleHighWater = preparedLifecyclePending;
        return preparedLifecyclePending;
      }

      function clearReservation() {
        reservationCount = 0;
        reservedKind0 = 0;
        reservedKind1 = 0;
      }

      function reservePreparedLifecyclePair(type0, sampleOffset0, pitch0, velocity0 = 100, type1 = null, sampleOffset1 = 0, pitch1 = 0, velocity1 = 100) {
        if (reservationCount !== 0) throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-reserved", "prepared lifecycle reservation is already active");
        preflightPreparedLifecycle(type0, sampleOffset0, pitch0, velocity0);
        const demand = type1 === null || type1 === undefined ? 1 : 2;
        if (qCount + demand > maxEvents) throw new baseRuntime.BrkSynthAbiError("event-capacity", `R6 performer event capacity ${maxEvents} exceeded by bounded reservation`, { count: qCount, demand });
        if (demand === 2) preflightPreparedLifecycle(type1, sampleOffset1, pitch1, velocity1);
        reservedKind0 = PREPARED_TYPE[type0];
        reservedOffset0 = Number(sampleOffset0);
        reservedPitch0 = Number(pitch0);
        reservedVelocity0 = Number(velocity0);
        if (demand === 2) {
          reservedKind1 = PREPARED_TYPE[type1];
          reservedOffset1 = Number(sampleOffset1);
          reservedPitch1 = Number(pitch1);
          reservedVelocity1 = Number(velocity1);
        }
        reservationCount = demand;
        reservationToken = reservationToken >= 0x7ffffffe ? 1 : reservationToken + 1;
        return reservationToken;
      }

      function cancelPreparedLifecycleReservation(token) {
        if (reservationCount === 0 || Number(token) !== reservationToken) throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-reservation-token", "prepared lifecycle reservation token is not active");
        clearReservation();
        return true;
      }

      function commitPreparedLifecycleReservation(token) {
        if (reservationCount === 0 || Number(token) !== reservationToken) throw new baseRuntime.BrkSynthAbiError("prepared-lifecycle-reservation-token", "prepared lifecycle reservation token is not active");
        const count = reservationCount;
        enqueue(reservedKind0, reservedOffset0, 0, reservedPitch0, reservedVelocity0, 0);
        preparedLifecyclePending += 1;
        if (count === 2) {
          enqueue(reservedKind1, reservedOffset1, 0, reservedPitch1, reservedVelocity1, 0);
          preparedLifecyclePending += 1;
        }
        if (preparedLifecyclePending > preparedLifecycleHighWater) preparedLifecycleHighWater = preparedLifecyclePending;
        clearReservation();
        return count;
      }

      function handleEvent(action) {
        assertAlive();
        const type = action?.type;
        const offset = Math.max(0, Math.round(Number(action?.sampleOffset) || 0));
        if (type === "parameter") {
          const handleIndex = parameterHandle(action.parameterId);
          if (handleIndex < 0) throw new baseRuntime.BrkSynthAbiError("unknown-parameter", `unknown stable parameter id ${String(action.parameterId)}`);
          return handlePreparedParameter(handleIndex, action.value, offset, Math.max(0, Math.round(Number(action.rampFrames) || 0)));
        }
        if (type === "note-on") return enqueue(EVENT.NOTE_ON, offset, 0, clamp(action.pitch, 0, 127), Number(action.velocity ?? 100), 0);
        if (type === "note-off") return enqueue(EVENT.NOTE_OFF, offset, 0, 0, 0, 0);
        if (type === "retrigger") return enqueue(EVENT.RETRIGGER, offset, 0, 0, 0, 0);
        if (type === "kill") return enqueue(EVENT.NOTE_CHOKE, offset, 0, 0, 0, 0);
        if (type === "all-notes-off") return enqueue(EVENT.ALL_NOTES_OFF, offset, 0, 0, 0, 0);
        if (type === "reset") return enqueue(EVENT.RESET, offset, 0, 0, 0, 0);
        throw new baseRuntime.BrkSynthAbiError("unsupported-action", `unsupported R6 BRK Synth action ${String(type)}`);
      }

      function writeHeader(view, offset, size, type, frameOffset) {
        view.setUint16(offset + 0, size, true);
        view.setUint16(offset + 2, type, true);
        view.setUint32(offset + 4, frameOffset >>> 0, true);
        view.setUint32(offset + 8, 0, true);
      }

      function writeNote(view, offset, type, frameOffset, noteId, pitch, velocity) {
        writeHeader(view, offset, EVENT_SIZE.NOTE, type, frameOffset);
        view.setUint32(offset + 12, noteId >>> 0, true);
        view.setInt16(offset + 16, Math.round(clamp(pitch, 0, 127)), true);
        view.setInt16(offset + 18, 0, true);
        view.setFloat32(offset + 20, clamp(velocity, 0, 1), true);
        view.setFloat32(offset + 24, 0, true);
        return EVENT_SIZE.NOTE;
      }

      function writeParameter(view, offset, frameOffset, handleIndex, value) {
        writeHeader(view, offset, EVENT_SIZE.PARAM_VALUE, PARAM_VALUE, frameOffset);
        view.setUint32(offset + 12, parameterAbiId[handleIndex], true);
        view.setFloat32(offset + 16, clamp(value, 0, 1), true);
        view.setUint32(offset + 20, 0, true);
        return EVENT_SIZE.PARAM_VALUE;
      }

      function writeRamp(view, offset, frameOffset, handleIndex, startValue, endValue, durationFrames) {
        writeHeader(view, offset, EVENT_SIZE.PARAM_RAMP, PARAM_RAMP, frameOffset);
        view.setUint32(offset + 12, parameterAbiId[handleIndex], true);
        view.setFloat32(offset + 16, clamp(startValue, 0, 1), true);
        view.setFloat32(offset + 20, clamp(endValue, 0, 1), true);
        view.setUint32(offset + 24, Math.max(1, Math.round(durationFrames)) >>> 0, true);
        view.setUint32(offset + 28, 0, true);
        return EVENT_SIZE.PARAM_RAMP;
      }

      function processBlock(frameCount, left, right, accumulate = true) {
        assertAlive();
        const frames = Math.round(Number(frameCount));
        if (!Number.isInteger(frames) || frames < 1 || frames > maxBlockFrames) throw new baseRuntime.BrkSynthAbiError("block-size", `frame count ${frames} outside 1..${maxBlockFrames}`);
        if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length < frames || right.length < frames) throw new TypeError("R6 BRK performer process requires Float32Array left/right outputs");

        promoteDeferredParameters();
        for (let index = 0; index < parameterCount; index += 1) rampNext[index] = Math.max(0, Number(rampRemaining[index]) - frames);

        const view = dataView();
        let cursor = eventPtr;
        let encodedCount = 0;
        for (let eventIndex = 0; eventIndex < qCount; eventIndex += 1) {
          const kind = qKind[eventIndex];
          const offset = qOffset[eventIndex];
          if (offset >= frames) throw new baseRuntime.BrkSynthAbiError("event-offset", `R6 event sample offset ${offset} outside block ${frames}`);
          if (kind === PARAM_VALUE || kind === PARAM_RAMP) {
            const parameterIndex = qIndex[eventIndex];
            if (Number(rampRemaining[parameterIndex]) > offset) {
              if (deferredDirty[parameterIndex]) parameterEventsCoalesced += 1;
              deferredDirty[parameterIndex] = 1;
              deferredValue[parameterIndex] = qValue[eventIndex];
              deferredRamp[parameterIndex] = qRamp[eventIndex];
              deferredOffset[parameterIndex] = offset;
              parameterEventsDeferred += 1;
              continue;
            }
            if (kind === PARAM_RAMP) {
              const duration = Math.max(1, qRamp[eventIndex]);
              cursor += writeRamp(view, cursor, offset, parameterIndex, parameterValue[parameterIndex], qValue[eventIndex], duration);
              rampNext[parameterIndex] = Math.max(0, duration - Math.max(0, frames - offset));
              parameterRampEventsEncoded += 1;
            } else {
              cursor += writeParameter(view, cursor, offset, parameterIndex, qValue[eventIndex]);
              rampNext[parameterIndex] = 0;
            }
            parameterValue[parameterIndex] = qValue[eventIndex];
            discardDeferredParameter(parameterIndex);
            parameterEventsEncoded += 1;
            encodedCount += 1;
            continue;
          }
          if (kind === EVENT.NOTE_ON) {
            currentNoteId = allocateNoteId();
            currentNotePitch = clamp(qValue[eventIndex], 0, 127);
            currentNoteVelocity = clamp(Number(qAux[eventIndex] || 100) / 127, 0, 1);
            cursor += writeNote(view, cursor, EVENT.NOTE_ON, offset, currentNoteId, currentNotePitch, currentNoteVelocity);
          } else if (kind === EVENT.NOTE_OFF) {
            if (currentNoteId === 0) continue;
            cursor += writeNote(view, cursor, EVENT.NOTE_OFF, offset, currentNoteId, currentNotePitch, currentNoteVelocity);
          } else if (kind === EVENT.RETRIGGER) {
            if (currentNoteId === 0) continue;
            cursor += writeNote(view, cursor, EVENT.RETRIGGER, offset, currentNoteId, currentNotePitch, currentNoteVelocity);
          } else if (kind === EVENT.NOTE_CHOKE) {
            if (currentNoteId === 0) continue;
            cursor += writeNote(view, cursor, EVENT.NOTE_CHOKE, offset, currentNoteId, currentNotePitch, currentNoteVelocity);
            currentNoteId = 0;
          } else if (kind === EVENT.ALL_NOTES_OFF || kind === EVENT.RESET) {
            writeHeader(view, cursor, EVENT_SIZE.HEADER, kind, offset);
            cursor += EVENT_SIZE.HEADER;
            currentNoteId = 0;
          } else {
            throw new baseRuntime.BrkSynthAbiError("unsupported-action", `unsupported R6 event kind ${kind}`);
          }
          encodedCount += 1;
        }

        for (let index = 0; index < 24; index += 1) view.setUint8(audioSpanPtr + index, 0);
        view.setUint32(audioSpanPtr + 0, 24, true);
        view.setUint32(audioSpanPtr + 4, outputPtr >>> 0, true);
        view.setUint32(audioSpanPtr + 8, 2, true);
        view.setUint32(audioSpanPtr + 12, maxBlockFrames >>> 0, true);
        view.setUint32(audioSpanPtr + 16, maxBlockFrames >>> 0, true);
        for (let index = 0; index < 64; index += 1) view.setUint8(processPtr + index, 0);
        view.setUint32(processPtr + 0, 64, true);
        view.setUint32(processPtr + 4, frames >>> 0, true);
        view.setUint32(processPtr + 8, audioSpanPtr >>> 0, true);
        view.setUint32(processPtr + 12, eventPtr >>> 0, true);
        view.setUint32(processPtr + 16, (cursor - eventPtr) >>> 0, true);
        view.setUint32(processPtr + 20, encodedCount >>> 0, true);
        view.setUint32(processPtr + 24, 0, true);
        view.setUint32(processPtr + 28, 1, true);
        const result = Number(module._brk_instance_process(handle, processPtr));
        if (result !== BRK_OK) throw new baseRuntime.BrkSynthAbiError("abi-call-failed", `brk_instance_process failed with BRK result ${result}`, { operation: "brk_instance_process", result });

        const heap = module.HEAPF32;
        const leftStart = outputPtr >>> 2;
        const rightStart = leftStart + maxBlockFrames;
        for (let frame = 0; frame < frames; frame += 1) {
          const l = Number.isFinite(heap[leftStart + frame]) ? heap[leftStart + frame] : 0;
          const r = Number.isFinite(heap[rightStart + frame]) ? heap[rightStart + frame] : 0;
          if (accumulate) { left[frame] += l; right[frame] += r; }
          else { left[frame] = l; right[frame] = r; }
        }
        for (let index = 0; index < parameterCount; index += 1) rampRemaining[index] = rampNext[index];
        qCount = 0;
        preparedLifecyclePending = 0;
        clearReservation();
        return true;
      }

      function process(input = {}) {
        return processBlock(input.frameCount, input.left, input.right, input.accumulate !== false);
      }

      function queueSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== "object") return 0;
        let count = 0;
        for (const key of Object.keys(snapshot)) {
          const handleIndex = parameterHandle(key);
          if (handleIndex < 0) continue;
          handlePreparedParameter(handleIndex, snapshot[key], 0, 0);
          count += 1;
        }
        return count;
      }

      queueSnapshot(args.parameterSnapshot);

      function clearRealtimeState() {
        qCount = 0;
        rampRemaining.fill(0);
        rampNext.fill(0);
        deferredDirty.fill(0);
        currentNoteId = 0;
        preparedLifecyclePending = 0;
        clearReservation();
      }

      function applyState(next = {}) {
        const result = performer.applyState?.(next);
        if (next?.patchState) clearRealtimeState();
        queueSnapshot(next?.parameterSnapshot);
        return result;
      }

      function reset() {
        const result = performer.reset?.();
        clearRealtimeState();
        return result;
      }

      function commitPreparedState() {
        const result = performer.commitPreparedState?.();
        clearRealtimeState();
        return result;
      }

      function destroy() {
        if (destroyed) return;
        destroyed = true;
        qCount = 0;
        clearReservation();
        for (const ptr of pointers) { try { module._free?.(ptr); } catch {} }
        performer.destroy?.();
      }

      function diagnostics() {
        const base = performer.diagnostics?.() ?? {};
        let activeParameterRampCount = 0;
        let deferredParameterCount = 0;
        const values = {};
        for (let index = 0; index < parameterCount; index += 1) {
          if (rampRemaining[index] > 0) activeParameterRampCount += 1;
          if (deferredDirty[index]) deferredParameterCount += 1;
          values[descriptors[index].id] = parameterValue[index];
        }
        return Object.freeze({
          ...base,
          pendingEvents: qCount,
          preparedLifecyclePending,
          preparedLifecycleHighWater,
          currentNoteId: currentNoteId || null,
          parameterEventsEncoded,
          parameterRampEventsEncoded,
          parameterEventsDeferred,
          parameterEventsCoalesced,
          activeParameterRampCount,
          deferredParameterCount,
          parameterValues: Object.freeze(values),
          r6Realtime: Object.freeze({
            primitiveParameterPath: true,
            primitiveProcessPath: true,
            parameterCount,
            queueCapacity: maxEvents,
            queueHighWater,
            dataViewRefreshes,
            scratchBytes: (maxEvents * EVENT_SIZE.PARAM_RAMP) + (maxBlockFrames * 2 * 4) + 24 + 64,
          }),
        });
      }

      return Object.freeze({
        ...performer,
        parameterHandle,
        preflightPreparedParameter,
        handlePreparedParameter,
        preflightPreparedLifecycle,
        handlePreparedLifecycle,
        reservePreparedLifecyclePair,
        cancelPreparedLifecycleReservation,
        commitPreparedLifecycleReservation,
        handleEvent,
        processBlock,
        process,
        applyState,
        reset,
        commitPreparedState,
        destroy,
        diagnostics,
      });
    }

    makePerformer.diagnostics = () => Object.freeze({
      ...(baseFactory.diagnostics?.() ?? {}),
      r6RealtimeExtension: true,
      r6ParameterCount: parameterCount,
      r6EventCapacity: maxEvents,
      r6MaxBlockFrames: maxBlockFrames,
    });
    return Object.freeze(makePerformer);
  }

  const api = Object.freeze({ ...baseRuntime, createPerformerFactory, R6_REALTIME_VERSION: 1 });
  globalThis.BRKTRKBrkSynthAbiV1Runtime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();