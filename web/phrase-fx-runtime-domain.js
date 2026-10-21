(() => {
  const timingDomain = globalThis.BRKTRKTimingDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./timing-domain.js") : null);
  const fxDomain = globalThis.BRKTRKPhraseFxDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./phrase-fx-domain.js") : null);
  if (!timingDomain || !fxDomain) throw new Error("M4.1C Phrase FX runtime requires K0 timing and M4.1A FX domains");

  const RUNTIME_VERSION = 1;
  const COMMAND = Object.freeze({
    CUT: fxDomain.commandDescriptor("cut").code,
    DELAY: fxDomain.commandDescriptor("delay").code,
    RETRIGGER: fxDomain.commandDescriptor("retrigger").code,
  });

  const safeInteger = (value, name, min = 0) => {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < min) throw new RangeError(`${name} must be a safe integer >= ${min}`);
    return numeric;
  };

  function normalizeTiming(timing = {}) {
    const sampleRate = safeInteger(timing.sampleRate, "sampleRate", 1);
    const ppqn = safeInteger(timing.ppqn, "ppqn", 1);
    timingDomain.unitsPerTick(ppqn);
    const tempo = timingDomain.normalizePositiveRational(timing.tempo ?? 120, "tempo");
    return Object.freeze({ sampleRate, ppqn, tempo });
  }

  function frameAfterTicks(startFrame, ticks, timing) {
    const frame = safeInteger(startFrame, "startFrame", 0);
    const count = safeInteger(ticks, "ticks", 0);
    if (count === 0) return frame;
    const spec = normalizeTiming(timing);
    const clock = timingDomain.createMusicalFrameClock({
      sampleRate: spec.sampleRate,
      tempo: spec.tempo,
      stepUnits: timingDomain.unitsPerTick(spec.ppqn),
      startFrame: frame,
    });
    return clock.frameAt(count);
  }

  function analyze(slots = []) {
    const normalized = fxDomain.normalizeSlots(slots);
    const delays = [];
    const cuts = [];
    const retriggers = [];
    const inert = [];

    normalized.forEach((slot, lane) => {
      if (slot.commandCode === 0) return;
      if (!slot.known) {
        inert.push(Object.freeze({ kind: "unknown-command", lane, command: slot.commandCode, value: slot.value }));
        return;
      }
      if (slot.commandCode === COMMAND.DELAY) {
        delays.push(Object.freeze({ lane, ticks: slot.value }));
        return;
      }
      if (slot.commandCode === COMMAND.CUT) {
        cuts.push(Object.freeze({ lane, ticks: slot.value }));
        return;
      }
      if (slot.commandCode === COMMAND.RETRIGGER) {
        const waitTicks = (slot.value >> 4) & 0x0F;
        const intervalTicks = slot.value & 0x0F;
        if (intervalTicks !== 0) {
          inert.push(Object.freeze({
            kind: "retrigger-ramp-unresolved",
            lane,
            command: slot.commandCode,
            value: slot.value,
            waitTicks,
            intervalTicks,
          }));
          return;
        }
        retriggers.push(Object.freeze({ lane, ticks: waitTicks, value: slot.value }));
      }
    });

    if (delays.length > 1) {
      throw new RangeError("M4.1C does not guess semantics for more than one DELAY command on the same Phrase row");
    }

    return Object.freeze({
      version: RUNTIME_VERSION,
      slots: normalized,
      delayTicks: delays[0]?.ticks ?? 0,
      delayLane: delays[0]?.lane ?? -1,
      cuts: Object.freeze(cuts),
      retriggers: Object.freeze(retriggers),
      inert: Object.freeze(inert),
    });
  }

  function compileTiming(slots, { frame, sampleRate, ppqn, tempo } = {}) {
    const analysis = analyze(slots);
    const timing = normalizeTiming({ sampleRate, ppqn, tempo });
    const originFrame = safeInteger(frame, "frame", 0);
    const executionFrame = frameAfterTicks(originFrame, analysis.delayTicks, timing);
    const cuts = Object.freeze(analysis.cuts.map((entry) => Object.freeze({
      ...entry,
      frame: frameAfterTicks(executionFrame, entry.ticks, timing),
    })));
    const retriggers = Object.freeze(analysis.retriggers.map((entry) => Object.freeze({
      ...entry,
      frame: frameAfterTicks(executionFrame, entry.ticks, timing),
    })));
    return Object.freeze({
      version: RUNTIME_VERSION,
      originFrame,
      executionFrame,
      delayTicks: analysis.delayTicks,
      cuts,
      retriggers,
      inert: analysis.inert,
    });
  }

  const api = Object.freeze({
    RUNTIME_VERSION,
    COMMAND,
    frameAfterTicks,
    analyze,
    compileTiming,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKPhraseFxRuntimeDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
