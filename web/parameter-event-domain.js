(() => {
  "use strict";

  const INTERPOLATION = Object.freeze({ STEP: "step", LINEAR: "linear" });
  const DEFAULT_MAX_PARAMETER_EVENTS_PER_ROW = 8;
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

  function exactInteger(value, name, min, max) {
    // An absent ID is not Instrument 00. Fail closed before persistence or audio preparation.
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
      throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
    }
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
      throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
    }
    return numeric;
  }

  function stableParameterId(value, name = "parameterId") {
    const id = String(value ?? "").trim();
    if (!id) throw new TypeError(`${name} must not be empty`);
    if (id.length > 128) throw new RangeError(`${name} must be at most 128 characters`);
    return id;
  }

  function scalar(value, name = "value") {
    const type = typeof value;
    if (value === null || type === "string" || type === "boolean") return value;
    if (type === "number" && Number.isFinite(value)) return value;
    throw new TypeError(`${name} must be a finite JSON scalar`);
  }

  function normalizeInterpolation(value = INTERPOLATION.STEP, name = "interpolationOut") {
    if (value === INTERPOLATION.STEP || value === INTERPOLATION.LINEAR) return value;
    throw new RangeError(`${name} must be step or linear`);
  }

  function parameterTargetKey(instrumentId, parameterId) {
    return `${exactInteger(instrumentId, "instrumentId", 0, 255)}\u0000${stableParameterId(parameterId)}`;
  }

  function normalizeParameterEvent(value, { name = "parameterEvent" } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
    return Object.freeze({
      instrumentId: exactInteger(value.instrumentId, `${name}.instrumentId`, 0, 255),
      parameterId: stableParameterId(value.parameterId, `${name}.parameterId`),
      value: clone(scalar(value.value, `${name}.value`)),
      interpolationOut: normalizeInterpolation(value.interpolationOut ?? INTERPOLATION.STEP, `${name}.interpolationOut`),
    });
  }

  function compareParameterEvents(left, right) {
    const instrumentOrder = left.instrumentId - right.instrumentId;
    if (instrumentOrder !== 0) return instrumentOrder;
    if (left.parameterId < right.parameterId) return -1;
    if (left.parameterId > right.parameterId) return 1;
    return 0;
  }

  function normalizeParameterEvents(value, { name = "parameterEvents", maxEvents = DEFAULT_MAX_PARAMETER_EVENTS_PER_ROW } = {}) {
    const source = value == null ? [] : value;
    if (!Array.isArray(source)) throw new TypeError(`${name} must be an array`);
    const max = exactInteger(maxEvents, "maxEvents", 0, 256);
    if (source.length > max) throw new RangeError(`${name} exceeds the maximum of ${max} events`);
    const events = source.map((entry, index) => normalizeParameterEvent(entry, { name: `${name}[${index}]` }));
    const seen = new Set();
    for (const event of events) {
      const key = parameterTargetKey(event.instrumentId, event.parameterId);
      if (seen.has(key)) throw new RangeError(`${name} contains duplicate target ${event.instrumentId}:${event.parameterId}`);
      seen.add(key);
    }
    events.sort(compareParameterEvents);
    return Object.freeze(events);
  }

  function serializeParameterEvents(value, options = {}) {
    return normalizeParameterEvents(value, options).map((event) => ({
      instrumentId: event.instrumentId,
      parameterId: event.parameterId,
      value: clone(event.value),
      interpolationOut: event.interpolationOut,
    }));
  }

  const api = Object.freeze({
    INTERPOLATION,
    DEFAULT_MAX_PARAMETER_EVENTS_PER_ROW,
    parameterTargetKey,
    normalizeInterpolation,
    normalizeParameterEvent,
    normalizeParameterEvents,
    serializeParameterEvents,
    compareParameterEvents,
  });

  globalThis.BRKTRKParameterEventDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
