(() => {
  "use strict";

  const DEFAULT_CAPACITY = 131072;
  const EMPTY = 0;
  const OCCUPIED = 1;
  const TOMBSTONE = 2;

  class RealtimeExecutionQueueError extends Error {
    constructor(code, message, details = null) {
      super(message);
      this.name = "RealtimeExecutionQueueError";
      this.code = code;
      this.details = details;
    }
  }

  const integer = (value, label, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
      throw new RangeError(`${label} must be a safe integer between ${min} and ${max}`);
    }
    return numeric;
  };

  function createRealtimeExecutionQueue({ capacity = DEFAULT_CAPACITY } = {}) {
    const limit = integer(capacity, "realtime execution capacity", 1, DEFAULT_CAPACITY);
    const frame = new Float64Array(limit);
    const phase = new Uint16Array(limit);
    const track = new Uint8Array(limit);
    const sourceOrder = new Uint32Array(limit);
    const kind = new Uint8Array(limit);
    const instrumentId = new Int16Array(limit);
    const note = new Float64Array(limit);
    const velocity = new Float64Array(limit);
    const fxLane = new Int16Array(limit);
    const flags = new Uint8Array(limit);
    const order = new Float64Array(limit);

    // Separate fixed-capacity frame counters let the Worklet preflight a whole
    // due frame against K4B before delivering any lifecycle mutation. Epochs
    // make clear() O(1): exact-bind rebuilds never sweep the full capacity.
    const countFrameKeys = new Float64Array(limit);
    const countFrameValues = new Uint32Array(limit);
    const countFrameState = new Uint8Array(limit);
    const countFrameEpoch = new Uint32Array(limit);
    let activeEpoch = 1;

    let size = 0;
    let insertionOrder = 0;
    let highWater = 0;
    let overrunCount = 0;

    const less = (left, right) => frame[left] < frame[right]
      || (frame[left] === frame[right] && (phase[left] < phase[right]
        || (phase[left] === phase[right] && (track[left] < track[right]
          || (track[left] === track[right] && (sourceOrder[left] < sourceOrder[right]
            || (sourceOrder[left] === sourceOrder[right] && (fxLane[left] < fxLane[right]
              || (fxLane[left] === fxLane[right] && order[left] < order[right])))))))));

    const copy = (target, source) => {
      frame[target] = frame[source];
      phase[target] = phase[source];
      track[target] = track[source];
      sourceOrder[target] = sourceOrder[source];
      kind[target] = kind[source];
      instrumentId[target] = instrumentId[source];
      note[target] = note[source];
      velocity[target] = velocity[source];
      fxLane[target] = fxLane[source];
      flags[target] = flags[source];
      order[target] = order[source];
    };

    const swap = (left, right) => {
      const f = frame[left]; frame[left] = frame[right]; frame[right] = f;
      const p = phase[left]; phase[left] = phase[right]; phase[right] = p;
      const t = track[left]; track[left] = track[right]; track[right] = t;
      const s = sourceOrder[left]; sourceOrder[left] = sourceOrder[right]; sourceOrder[right] = s;
      const k = kind[left]; kind[left] = kind[right]; kind[right] = k;
      const i = instrumentId[left]; instrumentId[left] = instrumentId[right]; instrumentId[right] = i;
      const n = note[left]; note[left] = note[right]; note[right] = n;
      const v = velocity[left]; velocity[left] = velocity[right]; velocity[right] = v;
      const l = fxLane[left]; fxLane[left] = fxLane[right]; fxLane[right] = l;
      const g = flags[left]; flags[left] = flags[right]; flags[right] = g;
      const o = order[left]; order[left] = order[right]; order[right] = o;
    };

    const hashFrame = (value) => {
      const low = value >>> 0;
      const high = Math.floor(value / 0x100000000) >>> 0;
      return (Math.imul(low ^ high, 0x9e3779b1) >>> 0) % limit;
    };
    const stateAt = (index) => countFrameEpoch[index] === activeEpoch ? countFrameState[index] : EMPTY;

    function frameCountSlot(value, create = false) {
      let index = hashFrame(value);
      let tombstone = -1;
      for (let probe = 0; probe < limit; probe += 1) {
        const state = stateAt(index);
        if (state === EMPTY) return create ? (tombstone >= 0 ? tombstone : index) : -1;
        if (state === OCCUPIED && countFrameKeys[index] === value) return index;
        if (create && state === TOMBSTONE && tombstone < 0) tombstone = index;
        index += 1;
        if (index === limit) index = 0;
      }
      if (create && tombstone >= 0) return tombstone;
      return -1;
    }

    function incrementFrameCount(value) {
      const index = frameCountSlot(value, true);
      if (index < 0) throw new RealtimeExecutionQueueError("execution-frame-index-overrun", "realtime execution frame index is full", { capacity: limit });
      if (stateAt(index) === OCCUPIED) countFrameValues[index] += 1;
      else {
        countFrameEpoch[index] = activeEpoch;
        countFrameState[index] = OCCUPIED;
        countFrameKeys[index] = value;
        countFrameValues[index] = 1;
      }
    }

    function decrementFrameCount(value) {
      const index = frameCountSlot(value, false);
      if (index < 0 || stateAt(index) !== OCCUPIED || countFrameValues[index] === 0) {
        throw new Error("realtime execution frame count index diverged from heap");
      }
      countFrameValues[index] -= 1;
      if (countFrameValues[index] === 0) countFrameState[index] = TOMBSTONE;
    }

    function clear() {
      size = 0;
      insertionOrder = 0;
      activeEpoch = (activeEpoch + 1) >>> 0;
      if (activeEpoch === 0) {
        countFrameEpoch.fill(0);
        activeEpoch = 1;
      }
      return true;
    }

    function push(eventFrame, eventPhase, eventTrack, eventSourceOrder, eventKind, eventInstrumentId, eventNote, eventVelocity, eventFxLane = -1, retrigger = false, resetsPhase = false) {
      if (size >= limit) {
        overrunCount += 1;
        throw new RealtimeExecutionQueueError("execution-overrun", `realtime execution queue exceeded ${limit}`, { capacity: limit });
      }
      const nextFrame = integer(eventFrame, "execution.frame", 0);
      const nextPhase = integer(eventPhase, "execution.phase", 0, 65535);
      const nextTrack = integer(eventTrack, "execution.track", 0, 255);
      const nextSourceOrder = integer(eventSourceOrder, "execution.sourceOrder", 0, 0xffffffff);
      const nextKind = integer(eventKind, "execution.kind", 0, 255);
      const nextInstrumentId = integer(eventInstrumentId, "execution.instrumentId", -1, 255);
      const nextNote = Number(eventNote);
      const nextVelocity = Number(eventVelocity);
      if (!Number.isFinite(nextNote) || !Number.isFinite(nextVelocity)) throw new TypeError("execution note/velocity must be finite");
      const nextFxLane = integer(eventFxLane, "execution.fxLane", -1, 32767);
      const nextFlags = (retrigger ? 1 : 0) | (resetsPhase ? 2 : 0);

      // All throwing validation has completed. From here onward the insertion
      // is deterministic and cannot leave a partially accepted event.
      incrementFrameCount(nextFrame);
      let index = size;
      size += 1;
      frame[index] = nextFrame;
      phase[index] = nextPhase;
      track[index] = nextTrack;
      sourceOrder[index] = nextSourceOrder;
      kind[index] = nextKind;
      instrumentId[index] = nextInstrumentId;
      note[index] = nextNote;
      velocity[index] = nextVelocity;
      fxLane[index] = nextFxLane;
      flags[index] = nextFlags;
      order[index] = insertionOrder;
      insertionOrder += 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!less(index, parent)) break;
        swap(index, parent);
        index = parent;
      }
      if (size > highWater) highWater = size;
      return size;
    }

    function peekFrame() {
      return size > 0 ? frame[0] : null;
    }

    function countFrame(dueFrame) {
      const target = integer(dueFrame, "execution count frame", 0);
      const index = frameCountSlot(target, false);
      return index >= 0 && stateAt(index) === OCCUPIED ? countFrameValues[index] : 0;
    }

    function drainFrame(dueFrame, visit) {
      const target = integer(dueFrame, "execution due frame", 0);
      if (typeof visit !== "function") throw new TypeError("execution drain requires a visitor");
      if (size > 0 && frame[0] < target) throw new RealtimeExecutionQueueError("late-execution-event", "realtime execution event became late", { eventFrame: frame[0], dueFrame: target });
      let drained = 0;
      while (size > 0 && frame[0] === target) {
        visit(
          frame[0], phase[0], track[0], sourceOrder[0], kind[0], instrumentId[0], note[0], velocity[0], fxLane[0],
          (flags[0] & 1) !== 0, (flags[0] & 2) !== 0,
        );
        const drainedFrame = frame[0];
        drained += 1;
        size -= 1;
        decrementFrameCount(drainedFrame);
        if (size === 0) break;
        copy(0, size);
        let index = 0;
        while (true) {
          const left = (index << 1) + 1;
          if (left >= size) break;
          const right = left + 1;
          let child = left;
          if (right < size && less(right, left)) child = right;
          if (!less(child, index)) break;
          swap(index, child);
          index = child;
        }
      }
      return drained;
    }

    return Object.freeze({
      capacity: limit,
      clear,
      push,
      peekFrame,
      countFrame,
      drainFrame,
      size: () => size,
      diagnostics: () => Object.freeze({ capacity: limit, size, highWater, overrunCount }),
    });
  }

  const api = Object.freeze({ DEFAULT_CAPACITY, RealtimeExecutionQueueError, createRealtimeExecutionQueue });
  globalThis.BRKTRKRealtimeExecutionQueue = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
