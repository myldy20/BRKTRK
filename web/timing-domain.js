(() => {
  const MUSICAL_UNITS_PER_QUARTER = 1536;
  const TRACKER_ROWS_PER_QUARTER = 4;
  const TRACKER_ROW_UNITS = MUSICAL_UNITS_PER_QUARTER / TRACKER_ROWS_PER_QUARTER;
  const MIDI_CLOCK_PPQN = 24;
  const MIDI_CLOCK_UNITS = MUSICAL_UNITS_PER_QUARTER / MIDI_CLOCK_PPQN;
  const SUPPORTED_M8_GROOVE_PPQN = Object.freeze([24, 48, 96, 192]);
  const TABLE_DETACHED_HZ = 200;
  const ROUNDING_MODE = "nearest-ties-up";
  const CLOCK_DOMAINS = Object.freeze({
    MUSICAL: "musical",
    RATE: "rate",
    FRAME: "frame",
  });
  const EVENT_PHASES = Object.freeze({
    CLOCK: 0,
    SOURCE_CONTROL: 100,
    TABLE: 200,
    NOTE_RELEASE: 300,
    PARAMETER: 400,
    NOTE_TRIGGER: 500,
    OBSERVE: 900,
  });

  const isPlainObject = (value) => value !== null
    && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

  function assertSafeInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`${name} must be a safe integer between ${min} and ${max}`);
    }
    return value;
  }

  function gcdBigInt(a, b) {
    let left = a < 0n ? -a : a;
    let right = b < 0n ? -b : b;
    while (right !== 0n) {
      const next = left % right;
      left = right;
      right = next;
    }
    return left || 1n;
  }

  function normalizeFraction(numerator, denominator = 1, name = "fraction") {
    const n = typeof numerator === "bigint" ? numerator : BigInt(assertSafeInteger(numerator, `${name}.numerator`));
    const d = typeof denominator === "bigint" ? denominator : BigInt(assertSafeInteger(denominator, `${name}.denominator`, { min: 1 }));
    if (d <= 0n) throw new RangeError(`${name}.denominator must be positive`);
    if (n <= 0n) throw new RangeError(`${name}.numerator must be positive`);
    const divisor = gcdBigInt(n, d);
    return Object.freeze({ numerator: n / divisor, denominator: d / divisor });
  }

  function decimalStringToFraction(source, name = "value") {
    const text = String(source).trim();
    const match = /^([+]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) throw new TypeError(`${name} must be a positive decimal number or rational`);
    const whole = match[2];
    const fraction = match[3] ?? "";
    const exponent = Number(match[4] ?? 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new RangeError(`${name} exponent is out of range`);
    let numerator = BigInt(`${whole}${fraction}`);
    let denominator = 10n ** BigInt(fraction.length);
    if (exponent > 0) numerator *= 10n ** BigInt(exponent);
    else if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
    return normalizeFraction(numerator, denominator, name);
  }

  function normalizePositiveRational(value, name = "value") {
    if (isPlainObject(value)) {
      return normalizeFraction(value.numerator, value.denominator ?? 1, name);
    }
    if (typeof value === "bigint") return normalizeFraction(value, 1n, name);
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
      return decimalStringToFraction(String(value), name);
    }
    if (typeof value === "string") return decimalStringToFraction(value, name);
    throw new TypeError(`${name} must be a positive number, decimal string, or rational object`);
  }

  function serializeRational(value, name = "value") {
    const rational = normalizePositiveRational(value, name);
    const numerator = Number(rational.numerator);
    const denominator = Number(rational.denominator);
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
      throw new RangeError(`${name} is too large to serialize safely`);
    }
    return Object.freeze({ numerator, denominator });
  }

  function roundNonNegativeRatio(numerator, denominator) {
    if (numerator < 0n || denominator <= 0n) throw new RangeError("roundNonNegativeRatio expects numerator >= 0 and denominator > 0");
    return (2n * numerator + denominator) / (2n * denominator);
  }

  function safeNumberFromBigInt(value, name) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`${name} exceeds JavaScript safe-integer range`);
    }
    return Number(value);
  }

  function unitsPerTick(ppqn) {
    const value = assertSafeInteger(Number(ppqn), "ppqn", { min: 1 });
    if (MUSICAL_UNITS_PER_QUARTER % value !== 0) {
      throw new RangeError(`ppqn ${value} does not divide ${MUSICAL_UNITS_PER_QUARTER}`);
    }
    return MUSICAL_UNITS_PER_QUARTER / value;
  }

  function unitsPerSubtick(ppqn, subdivisions = 8) {
    const divisor = assertSafeInteger(Number(subdivisions), "subdivisions", { min: 1 });
    const tickUnits = unitsPerTick(ppqn);
    if (tickUnits % divisor !== 0) {
      throw new RangeError(`${subdivisions} subticks do not divide one ${ppqn} PPQN tick exactly`);
    }
    return tickUnits / divisor;
  }

  function musicalFrameRatio({ positionUnits, sampleRate, tempo }) {
    const units = assertSafeInteger(Number(positionUnits), "positionUnits", { min: 0 });
    const rate = assertSafeInteger(Number(sampleRate), "sampleRate", { min: 1 });
    const bpm = normalizePositiveRational(tempo, "tempo");
    return Object.freeze({
      numerator: BigInt(units) * BigInt(rate) * 60n * bpm.denominator,
      denominator: BigInt(MUSICAL_UNITS_PER_QUARTER) * bpm.numerator,
    });
  }

  function musicalPositionToFrame(spec) {
    const ratio = musicalFrameRatio(spec);
    return safeNumberFromBigInt(roundNonNegativeRatio(ratio.numerator, ratio.denominator), "musical frame");
  }

  function rateFrameRatio({ step, sampleRate, rate }) {
    const index = assertSafeInteger(Number(step), "step", { min: 0 });
    const sampleRateValue = assertSafeInteger(Number(sampleRate), "sampleRate", { min: 1 });
    const frequency = normalizePositiveRational(rate, "rate");
    return Object.freeze({
      numerator: BigInt(index) * BigInt(sampleRateValue) * frequency.denominator,
      denominator: frequency.numerator,
    });
  }

  function detachedRateStepToFrame(spec) {
    const ratio = rateFrameRatio(spec);
    return safeNumberFromBigInt(roundNonNegativeRatio(ratio.numerator, ratio.denominator), "detached-rate frame");
  }

  function createFrameClock({ stepNumerator, stepDenominator, startFrame = 0, startStep = 0 } = {}) {
    const ratio = normalizeFraction(stepNumerator, stepDenominator, "frameClock.step");
    const frameOrigin = assertSafeInteger(Number(startFrame), "startFrame", { min: 0 });
    let cursor = assertSafeInteger(Number(startStep), "startStep", { min: 0 });

    function frameAt(step) {
      const index = assertSafeInteger(Number(step), "step", { min: 0 });
      const offset = roundNonNegativeRatio(BigInt(index) * ratio.numerator, ratio.denominator);
      return assertSafeInteger(frameOrigin + safeNumberFromBigInt(offset, "frame clock offset"), "frame clock result", { min: 0 });
    }

    return Object.freeze({
      rounding: ROUNDING_MODE,
      ratio: Object.freeze({
        numerator: safeNumberFromBigInt(ratio.numerator, "frame clock numerator"),
        denominator: safeNumberFromBigInt(ratio.denominator, "frame clock denominator"),
      }),
      frameAt,
      peek: () => frameAt(cursor),
      next: () => {
        const result = frameAt(cursor);
        cursor += 1;
        return result;
      },
      seek: (step) => {
        cursor = assertSafeInteger(Number(step), "step", { min: 0 });
        return frameAt(cursor);
      },
      position: () => cursor,
    });
  }

  function createMusicalFrameClock({ sampleRate, tempo, stepUnits = TRACKER_ROW_UNITS, startFrame = 0 } = {}) {
    const rate = assertSafeInteger(Number(sampleRate), "sampleRate", { min: 1 });
    const units = assertSafeInteger(Number(stepUnits), "stepUnits", { min: 1 });
    const bpm = normalizePositiveRational(tempo, "tempo");
    return createFrameClock({
      stepNumerator: BigInt(units) * BigInt(rate) * 60n * bpm.denominator,
      stepDenominator: BigInt(MUSICAL_UNITS_PER_QUARTER) * bpm.numerator,
      startFrame,
    });
  }

  function createDetachedRateFrameClock({ sampleRate, rate, startFrame = 0 } = {}) {
    const sampleRateValue = assertSafeInteger(Number(sampleRate), "sampleRate", { min: 1 });
    const frequency = normalizePositiveRational(rate, "rate");
    return createFrameClock({
      stepNumerator: BigInt(sampleRateValue) * frequency.denominator,
      stepDenominator: frequency.numerator,
      startFrame,
    });
  }

  function resolveEventFrame(event, timing) {
    const position = event.position;
    if (!isPlainObject(position)) throw new TypeError("timing event position must be an object");
    const clock = position.clock;
    if (clock === CLOCK_DOMAINS.MUSICAL) {
      return musicalPositionToFrame({
        positionUnits: position.units,
        sampleRate: timing.sampleRate,
        tempo: position.tempo ?? timing.tempo,
      });
    }
    if (clock === CLOCK_DOMAINS.RATE) {
      return detachedRateStepToFrame({
        step: position.step,
        sampleRate: timing.sampleRate,
        rate: position.rate,
      });
    }
    if (clock === CLOCK_DOMAINS.FRAME) {
      return assertSafeInteger(Number(position.frame), "position.frame", { min: 0 });
    }
    throw new RangeError(`unsupported timing clock: ${clock}`);
  }

  function canonicalize(value, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("trace values must be finite");
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) {
      if (seen.has(value)) throw new TypeError("trace values must not contain cycles");
      seen.add(value);
      const result = value.map((entry) => canonicalize(entry, seen));
      seen.delete(value);
      return result;
    }
    if (isPlainObject(value)) {
      if (seen.has(value)) throw new TypeError("trace values must not contain cycles");
      seen.add(value);
      const result = {};
      for (const key of Object.keys(value).sort()) {
        const entry = value[key];
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
          throw new TypeError(`unsupported trace value at ${key}`);
        }
        result[key] = canonicalize(entry, seen);
      }
      seen.delete(value);
      return result;
    }
    throw new TypeError("trace values must contain only JSON-compatible data");
  }

  function normalizePosition(position, timing) {
    if (position.clock === CLOCK_DOMAINS.MUSICAL) {
      return Object.freeze({
        clock: CLOCK_DOMAINS.MUSICAL,
        units: assertSafeInteger(Number(position.units), "position.units", { min: 0 }),
        tempo: serializeRational(position.tempo ?? timing.tempo, "tempo"),
      });
    }
    if (position.clock === CLOCK_DOMAINS.RATE) {
      return Object.freeze({
        clock: CLOCK_DOMAINS.RATE,
        step: assertSafeInteger(Number(position.step), "position.step", { min: 0 }),
        rate: serializeRational(position.rate, "rate"),
      });
    }
    return Object.freeze({
      clock: CLOCK_DOMAINS.FRAME,
      frame: assertSafeInteger(Number(position.frame), "position.frame", { min: 0 }),
    });
  }

  function compareTraceEvents(left, right) {
    return left.frame - right.frame
      || left.phase - right.phase
      || left.track - right.track
      || left.sourceOrder - right.sourceOrder
      || left.ordinal - right.ordinal;
  }

  function compileTimingTrace({ sampleRate, tempo = 120, events = [] } = {}) {
    const timing = Object.freeze({
      sampleRate: assertSafeInteger(Number(sampleRate), "sampleRate", { min: 1 }),
      tempo: serializeRational(tempo, "tempo"),
    });
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    const trace = events.map((event, ordinal) => {
      if (!isPlainObject(event)) throw new TypeError(`event ${ordinal} must be an object`);
      if (typeof event.kind !== "string" || !event.kind) throw new TypeError(`event ${ordinal} kind is required`);
      if (typeof event.source !== "string" || !event.source) throw new TypeError(`event ${ordinal} source is required`);
      const phase = assertSafeInteger(Number(event.phase ?? EVENT_PHASES.NOTE_TRIGGER), `event ${ordinal} phase`, { min: 0 });
      const track = assertSafeInteger(Number(event.track ?? -1), `event ${ordinal} track`, { min: -1 });
      const sourceOrder = assertSafeInteger(Number(event.sourceOrder ?? 0), `event ${ordinal} sourceOrder`, { min: 0 });
      const frame = resolveEventFrame(event, timing);
      return Object.freeze({
        frame,
        phase,
        track,
        sourceOrder,
        ordinal,
        clock: event.position.clock,
        kind: event.kind,
        source: event.source,
        position: normalizePosition(event.position, timing),
        data: Object.freeze(canonicalize(event.data ?? {})),
      });
    });
    trace.sort(compareTraceEvents);
    return Object.freeze(trace);
  }

  function serializeTimingTrace(trace) {
    if (!Array.isArray(trace)) throw new TypeError("trace must be an array");
    return `${JSON.stringify(canonicalize(trace), null, 2)}\n`;
  }

  const api = Object.freeze({
    MUSICAL_UNITS_PER_QUARTER,
    TRACKER_ROWS_PER_QUARTER,
    TRACKER_ROW_UNITS,
    MIDI_CLOCK_PPQN,
    MIDI_CLOCK_UNITS,
    SUPPORTED_M8_GROOVE_PPQN,
    TABLE_DETACHED_HZ,
    ROUNDING_MODE,
    CLOCK_DOMAINS,
    EVENT_PHASES,
    normalizePositiveRational: serializeRational,
    unitsPerTick,
    unitsPerSubtick,
    musicalPositionToFrame,
    detachedRateStepToFrame,
    createFrameClock,
    createMusicalFrameClock,
    createDetachedRateFrameClock,
    compileTimingTrace,
    serializeTimingTrace,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKTimingDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
