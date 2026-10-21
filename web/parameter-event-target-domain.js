(() => {
  "use strict";

  const eventDomain = globalThis.BRKTRKParameterEventDomain
    ?? (typeof require === "function" ? require("./parameter-event-domain.js") : null);
  if (!eventDomain) throw new Error("ParameterEvent target preparation requires ParameterEvent domain");

  const SHA256_RE = /^[0-9a-f]{64}$/;
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
  const text = (value) => String(value ?? "").trim();
  const normalizedSha = (value) => text(value).toLowerCase();

  function exactIdentityFromRef(ref) {
    if (!object(ref)) return null;
    const moduleId = text(ref.moduleId);
    const engineId = text(ref.engineId);
    const version = text(ref.resolvedVersion);
    const packageSha256 = normalizedSha(ref.resolvedPackageSha256);
    if (!moduleId || !engineId || !version || !SHA256_RE.test(packageSha256)) return null;
    return Object.freeze({ moduleId, engineId, version, packageSha256 });
  }

  function exactIdentityFromView(view) {
    const entry = view?.entry;
    if (!object(entry)) return null;
    const moduleId = text(entry.moduleId);
    const engineId = text(entry.engineId);
    const version = text(entry.version);
    const packageSha256 = normalizedSha(entry.packageSha256);
    if (!moduleId || !engineId || !version || !SHA256_RE.test(packageSha256)) return null;
    return Object.freeze({ moduleId, engineId, version, packageSha256 });
  }

  function sameIdentity(left, right) {
    return Boolean(left && right
      && left.moduleId === right.moduleId
      && left.engineId === right.engineId
      && left.version === right.version
      && left.packageSha256 === right.packageSha256);
  }

  function interactionForView(view, parameterId) {
    const id = text(parameterId);
    const parameter = Array.isArray(view?.parameters)
      ? view.parameters.find((candidate) => text(candidate?.id) === id)
      : null;
    if (!parameter) return null;
    const discrete = parameter.type === "enum" || parameter.type === "stepped" || Array.isArray(parameter.values);
    const profile = discrete ? view.ui?.interaction?.discrete : view.ui?.interaction?.continuous;
    const smoothingOverride = Number(view.ui?.smoothingMsByKey?.[id]);
    const smoothingMs = Number.isFinite(smoothingOverride)
      ? Math.max(0, smoothingOverride)
      : Math.max(0, Number(profile?.defaultSmoothingMs) || 0);
    const policy = text(profile?.policy) || (discrete ? "parameter-value" : "parameter-ramp");
    return Object.freeze({
      parameter: Object.freeze(clone(parameter)),
      discrete,
      policy,
      smoothingMs,
      rampAllowed: !discrete && policy === "parameter-ramp",
    });
  }

  function unresolved(event, index, code, reason, details = {}) {
    return Object.freeze({
      index,
      status: "unresolved",
      code,
      reason,
      event: Object.freeze(clone(event)),
      ...Object.freeze(clone(details)),
    });
  }

  function resolved(event, index, identity, interaction) {
    return Object.freeze({
      index,
      status: "resolved",
      code: "resolved",
      event: Object.freeze(clone(event)),
      target: Object.freeze({
        instrumentId: event.instrumentId,
        parameterId: event.parameterId,
        engine: identity,
        parameter: interaction.parameter,
        capabilities: Object.freeze({
          discrete: interaction.discrete,
          policy: interaction.policy,
          smoothingMs: interaction.smoothingMs,
          rampAllowed: interaction.rampAllowed,
        }),
      }),
    });
  }

  function prepareOne(eventValue, index, options = {}) {
    const event = eventDomain.normalizeParameterEvent(eventValue, { name: `parameterEvents[${index}]` });
    const instrumentPool = object(options.instrumentPool) ? options.instrumentPool : {};
    const instrument = instrumentPool[event.instrumentId];
    if (!object(instrument)) {
      return unresolved(event, index, "instrument-missing", `Instrument ${event.instrumentId} does not exist`);
    }

    const requestedIdentity = exactIdentityFromRef(instrument.engineRef);
    if (!requestedIdentity) {
      return unresolved(event, index, "exact-engine-identity-missing", "ParameterEvent target requires resolved version + exact package SHA", {
        instrumentId: event.instrumentId,
      });
    }

    const packageViewFor = options.packageViewFor;
    if (typeof packageViewFor !== "function") {
      return unresolved(event, index, "package-view-unavailable", "Verified package view resolver is unavailable", {
        engine: requestedIdentity,
      });
    }

    let view;
    try {
      view = packageViewFor(instrument.engineRef, event.instrumentId, instrument);
    } catch (error) {
      return unresolved(event, index, "package-view-error", String(error?.message ?? error), {
        engine: requestedIdentity,
      });
    }
    if (!view) {
      return unresolved(event, index, "package-view-unavailable", "Exact verified package view is not prepared", {
        engine: requestedIdentity,
      });
    }

    const preparedIdentity = exactIdentityFromView(view);
    if (!sameIdentity(requestedIdentity, preparedIdentity)) {
      return unresolved(event, index, "package-identity-mismatch", "Verified package view does not match the Instrument exact engine identity", {
        engine: requestedIdentity,
        preparedEngine: preparedIdentity,
      });
    }

    const interaction = interactionForView(view, event.parameterId);
    if (!interaction) {
      return unresolved(event, index, "parameter-unavailable", `Stable parameter ${event.parameterId} is not present in the exact verified package`, {
        engine: requestedIdentity,
      });
    }

    if (typeof event.value !== "number" || !Number.isFinite(event.value) || event.value < 0 || event.value > 1) {
      return unresolved(event, index, "parameter-value-not-normalized", `Parameter ${event.parameterId} must resolve to a normalized numeric value in [0,1]`, {
        engine: requestedIdentity,
      });
    }

    return resolved(event, index, requestedIdentity, interaction);
  }

  function prepareParameterEvents(value, options = {}) {
    const events = eventDomain.serializeParameterEvents(value);
    const targets = events.map((event, index) => prepareOne(event, index, options));
    const resolvedTargets = targets.filter((target) => target.status === "resolved");
    const unresolvedTargets = targets.filter((target) => target.status === "unresolved");
    return Object.freeze({
      ok: unresolvedTargets.length === 0,
      total: targets.length,
      resolvedCount: resolvedTargets.length,
      unresolvedCount: unresolvedTargets.length,
      targets: Object.freeze(targets),
      resolved: Object.freeze(resolvedTargets),
      unresolved: Object.freeze(unresolvedTargets),
    });
  }

  const api = Object.freeze({
    exactIdentityFromRef,
    exactIdentityFromView,
    sameIdentity,
    interactionForView,
    prepareOne,
    prepareParameterEvents,
  });

  globalThis.BRKTRKParameterEventTargetDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
