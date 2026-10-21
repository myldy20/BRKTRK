(() => {
  const timingDomain = globalThis.BRKTRKTimingDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./timing-domain.js") : null);
  if (!timingDomain) throw new Error("BRKTRK note lifecycle requires the K0 timing domain");

  const NOTE_EMPTY = -1;
  const NOTE_OFF = -2;
  const INTENTS = Object.freeze({
    EMPTY: "empty",
    RELEASE: "release",
    TRIGGER: "trigger",
  });
  const PARAMETER_MODES = Object.freeze({
    NONE: "none",
    CARRY: "carry",
    TRIGGER: "trigger",
  });
  const ACTION_KINDS = Object.freeze({
    NOTE_RELEASE: "note-release",
    PARAMETER_UPDATE: "parameter-update",
    NOTE_TRIGGER: "note-trigger",
    ROW_OBSERVE: "row-observe",
  });

  function safeInteger(value, name, { min = Number.MIN_SAFE_INTEGER } = {}) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < min) throw new RangeError(`${name} must be a safe integer >= ${min}`);
    return numeric;
  }

  function classifyIntent(note, mute = false, forceRelease = false) {
    if (forceRelease === true || mute === true || note === NOTE_OFF) return INTENTS.RELEASE;
    return Number.isFinite(note) && note >= 0 ? INTENTS.TRIGGER : INTENTS.EMPTY;
  }

  function parameterModeForIntent(intent) {
    if (intent === INTENTS.TRIGGER) return PARAMETER_MODES.TRIGGER;
    if (intent === INTENTS.EMPTY) return PARAMETER_MODES.CARRY;
    if (intent === INTENTS.RELEASE) return PARAMETER_MODES.NONE;
    throw new RangeError(`unsupported note lifecycle intent: ${intent}`);
  }

  function shouldApplyParameters(intent, active) {
    return intent === INTENTS.TRIGGER || (intent === INTENTS.EMPTY && active === true);
  }

  function normalizeDescriptor(event = {}, fallbackTrack = 0) {
    const source = event && typeof event === "object" ? event : {};
    const track = safeInteger(source.track ?? fallbackTrack, "track", { min: 0 });
    const sourceOrder = safeInteger(source.sourceOrder ?? 0, "sourceOrder", { min: 0 });
    const note = typeof source.note === "number" && Number.isFinite(source.note) ? source.note : NOTE_EMPTY;
    const intent = classifyIntent(note, source.mute === true, source.forceRelease === true);
    return Object.freeze({
      track,
      source: typeof source.source === "string" && source.source ? source.source : "row",
      sourceOrder,
      intent,
      parameterMode: parameterModeForIntent(intent),
      note,
      mute: source.mute === true,
      forceRelease: source.forceRelease === true,
    });
  }

  function traceEvent(frame, descriptor, kind, phase, data) {
    return {
      kind,
      source: descriptor.source,
      sourceOrder: descriptor.sourceOrder,
      track: descriptor.track,
      phase,
      position: { clock: timingDomain.CLOCK_DOMAINS.FRAME, frame },
      data,
    };
  }

  function compileLifecycleTrace({ frame, events = [], includeObserve = true } = {}) {
    const absoluteFrame = safeInteger(frame, "frame", { min: 0 });
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    const timingEvents = [];

    events.forEach((event, index) => {
      const descriptor = normalizeDescriptor(event, index);
      if (descriptor.intent === INTENTS.RELEASE) {
        timingEvents.push(traceEvent(
          absoluteFrame,
          descriptor,
          ACTION_KINDS.NOTE_RELEASE,
          timingDomain.EVENT_PHASES.NOTE_RELEASE,
          { forceRelease: descriptor.forceRelease, mute: descriptor.mute, note: descriptor.note },
        ));
        return;
      }

      // K2 owns deterministic phase ordering, not engine parameters. The
      // PARAMETER phase remains as a host-owned lifecycle boundary for K4 and
      // future modulation/Table consumers, but no preview-synth wave/gain/pan
      // payload belongs in this domain.
      timingEvents.push(traceEvent(
        absoluteFrame,
        descriptor,
        ACTION_KINDS.PARAMETER_UPDATE,
        timingDomain.EVENT_PHASES.PARAMETER,
        {
          mode: descriptor.parameterMode,
          requiresActive: descriptor.parameterMode === PARAMETER_MODES.CARRY,
        },
      ));

      if (descriptor.intent === INTENTS.TRIGGER) {
        timingEvents.push(traceEvent(
          absoluteFrame,
          descriptor,
          ACTION_KINDS.NOTE_TRIGGER,
          timingDomain.EVENT_PHASES.NOTE_TRIGGER,
          { note: descriptor.note, resetsPhase: false },
        ));
      }
    });

    if (includeObserve) {
      timingEvents.push({
        kind: ACTION_KINDS.ROW_OBSERVE,
        source: "transport",
        sourceOrder: 0,
        track: -1,
        phase: timingDomain.EVENT_PHASES.OBSERVE,
        position: { clock: timingDomain.CLOCK_DOMAINS.FRAME, frame: absoluteFrame },
        data: { trackCount: events.length },
      });
    }

    return timingDomain.compileTimingTrace({ sampleRate: 1, tempo: 120, events: timingEvents });
  }

  const api = Object.freeze({
    NOTE_EMPTY,
    NOTE_OFF,
    INTENTS,
    PARAMETER_MODES,
    ACTION_KINDS,
    classifyIntent,
    parameterModeForIntent,
    shouldApplyParameters,
    normalizeDescriptor,
    compileLifecycleTrace,
    serializeLifecycleTrace: timingDomain.serializeTimingTrace,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKNoteLifecycleDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
