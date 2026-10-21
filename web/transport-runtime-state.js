(() => {
  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  if (!storeTypes) throw new Error("TransportStore types are required for runtime ownership");

  const DEFAULT_TRACK_COUNT = 8;
  const PHASES = Object.freeze(["stopped", "starting", "playing", "stopping", "error"]);
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const integerOr = (value, fallback = 0) => Number.isInteger(value) ? value : fallback;
  const freezeArray = (value, length, fallback = -1) => Object.freeze(
    Array.from({ length }, (_, index) => integerOr(value?.[index], fallback)),
  );

  function programMode(program) {
    return program?.mode === "track-plan" ? "track-plan" : "sequence";
  }

  function programScope(program) {
    const scope = String(program?.scope ?? "phrase").toLowerCase();
    return ["song", "chain", "phrase"].includes(scope) ? scope : "phrase";
  }

  function activeProgram(program) {
    if (programMode(program) === "track-plan") return program?.active === true;
    return Array.isArray(program?.steps) && program.steps.length > 0;
  }

  function requestedTrackPositions(program, trackCount) {
    if (programMode(program) !== "track-plan") return freezeArray([], trackCount);
    return Object.freeze(Array.from({ length: trackCount }, (_, track) => {
      const candidate = program?.tracks?.[track];
      return candidate?.active === true && Number.isInteger(candidate.startIndex) ? candidate.startIndex : -1;
    }));
  }

  function normalizeIdentity(value, fallback = {}) {
    const source = value && typeof value === "object" ? value : {};
    const version = Math.max(0, integerOr(source.version, integerOr(fallback.version, 0)));
    const id = typeof source.id === "string" && source.id
      ? source.id
      : typeof fallback.id === "string" && fallback.id
        ? fallback.id
        : version > 0 ? `transport-${version}` : "transport-0";
    const mode = source.mode === "track-plan" || source.mode === "sequence"
      ? source.mode
      : fallback.mode === "track-plan" ? "track-plan" : "sequence";
    const scope = ["song", "chain", "phrase"].includes(source.scope)
      ? source.scope
      : ["song", "chain", "phrase"].includes(fallback.scope) ? fallback.scope : "phrase";
    return Object.freeze({ id, version, mode, scope });
  }

  function identityMatches(candidate, expected) {
    if (!candidate || !expected) return false;
    return candidate.id === expected.id && candidate.version === expected.version;
  }

  function createDescriptor(identity, program, trackCount) {
    return Object.freeze({
      ...identity,
      active: activeProgram(program),
      requestedTrackPositions: requestedTrackPositions(program, trackCount),
    });
  }

  function createDomain(transportStore, options = {}) {
    if (!transportStore || transportStore.owner !== "transport") {
      throw new TypeError("Transport runtime domain requires TransportStore");
    }
    const state = transportStore.getState();
    const trackCount = Number.isInteger(options.trackCount) ? options.trackCount : DEFAULT_TRACK_COUNT;
    const initialPlaying = Boolean(state.playing);
    const initialProgram = state.currentSequence ?? null;
    const previous = state.transportRuntime && typeof state.transportRuntime === "object"
      ? state.transportRuntime
      : {};
    const runtime = {
      phase: PHASES.includes(previous.phase)
        ? previous.phase
        : initialPlaying ? "playing" : "stopped",
      playing: typeof previous.playing === "boolean" ? previous.playing : initialPlaying,
      version: Math.max(0, integerOr(previous.version, 0)),
      program: previous.program ?? initialProgram,
      appliedProgram: previous.appliedProgram ?? (previous.applied ? previous.program ?? initialProgram : null),
      requested: previous.requested ?? null,
      applied: previous.applied ?? null,
      stopRequest: previous.stopRequest ?? null,
      globalStep: integerOr(previous.globalStep, -1),
      trackPositions: freezeArray(previous.trackPositions, trackCount),
      requestedTrackPositions: freezeArray(previous.requestedTrackPositions, trackCount),
      worklet: {
        ready: previous.worklet?.ready === true,
        error: typeof previous.worklet?.error === "string" ? previous.worklet.error : null,
        terminal: previous.worklet?.terminal === true,
      },
    };
    state.transportRuntime = runtime;

    function publicSnapshot() {
      return Object.freeze({
        phase: runtime.phase,
        playing: runtime.playing,
        version: runtime.version,
        requested: runtime.requested,
        applied: runtime.applied,
        stopRequest: runtime.stopRequest,
        globalStep: runtime.globalStep,
        trackPositions: runtime.trackPositions,
        requestedTrackPositions: runtime.requestedTrackPositions,
        worklet: Object.freeze({ ...runtime.worklet }),
      });
    }

    function publish(changeSet, channels = []) {
      const unique = new Set(["transport", ...channels]);
      for (const channel of unique) transportStore.emit(channel, changeSet);
    }

    function change({ subtype, target, path, before, after, affectsPlayback = false, renderTargets = [], source = null }) {
      return storeTypes.createTransportChangeSet({
        subtype,
        target,
        path,
        before,
        after,
        affectsPlayback,
        renderTargets,
        source,
      });
    }

    function installLegacyMirror(key, getter, setter) {
      const descriptor = Object.getOwnPropertyDescriptor(state, key);
      if (descriptor?.get || descriptor?.set) return;
      Object.defineProperty(state, key, {
        enumerable: true,
        configurable: true,
        get: getter,
        set: setter,
      });
    }

    function adoptLegacyProgram(program, metadata = {}) {
      const before = runtime.program;
      if (before === program) return { mutated: false, before, after: program };
      runtime.program = program ?? null;
      if (!runtime.program && !runtime.playing) {
        runtime.requested = null;
        runtime.applied = null;
        runtime.appliedProgram = null;
        runtime.requestedTrackPositions = freezeArray([], trackCount);
      }
      const changeSet = change({
        subtype: "compatibility.program",
        target: "transport.compatibility.program",
        path: ["program"],
        before: before ? { mode: programMode(before), scope: programScope(before) } : null,
        after: program ? { mode: programMode(program), scope: programScope(program) } : null,
        renderTargets: ["transport.controls"],
        source: metadata.source ?? "legacy-current-sequence-mirror",
      });
      publish(changeSet, ["status", "render"]);
      return { mutated: true, before, after: program, changeSet };
    }

    function adoptLegacyPlaying(value, metadata = {}) {
      const after = Boolean(value);
      const before = runtime.playing;
      if (before === after) return { mutated: false, before, after };
      runtime.playing = after;
      runtime.phase = after ? (runtime.applied ? "playing" : "starting") : "stopped";
      if (!after) {
        runtime.globalStep = -1;
        runtime.trackPositions = freezeArray([], trackCount);
      }
      const changeSet = change({
        subtype: "compatibility.playing",
        target: "transport.compatibility.playing",
        path: ["playing"],
        before,
        after,
        renderTargets: ["transport.controls"],
        source: metadata.source ?? "legacy-playing-mirror",
      });
      publish(changeSet, ["status", "render"]);
      return { mutated: true, before, after, changeSet };
    }

    installLegacyMirror("currentSequence", () => runtime.program, (value) => adoptLegacyProgram(value));
    installLegacyMirror("playing", () => runtime.playing, (value) => adoptLegacyPlaying(value));

    function nextIdentity(program) {
      runtime.version += 1;
      return normalizeIdentity({
        id: `transport-${runtime.version}`,
        version: runtime.version,
        mode: programMode(program),
        scope: programScope(program),
      });
    }

    function requestProgram(program, metadata = {}, subtype = "program.start") {
      if (runtime.worklet.terminal) throw new Error("AudioWorklet processor stopped; reload BRKTRK to restore audio");
      if (!program || typeof program !== "object") throw new TypeError("Transport program must be an object");
      if (!activeProgram(program)) throw new RangeError("Transport program has no playable content");
      const before = publicSnapshot();
      const identity = nextIdentity(program);
      const descriptor = createDescriptor(identity, program, trackCount);
      runtime.program = program;
      runtime.requested = descriptor;
      runtime.stopRequest = null;
      runtime.requestedTrackPositions = descriptor.requestedTrackPositions;
      runtime.playing = true;
      runtime.phase = "starting";
      runtime.worklet.error = null;
      if (subtype === "program.start") {
        runtime.applied = null;
        runtime.appliedProgram = null;
        runtime.globalStep = -1;
        runtime.trackPositions = freezeArray([], trackCount);
      }
      const after = publicSnapshot();
      const changeSet = change({
        subtype,
        target: subtype === "program.start" ? "transport.program.start" : "transport.program.update",
        path: ["requested"],
        before,
        affectsPlayback: true,
        after,
        renderTargets: ["transport.controls"],
        source: metadata.source,
      });
      publish(changeSet, ["status", "render"]);
      return Object.freeze({ identity, descriptor, program, changeSet, snapshot: after });
    }

    function requestStart(program, metadata = {}) {
      return requestProgram(program, metadata, "program.start");
    }

    function requestUpdate(program, metadata = {}) {
      if (!runtime.playing || !runtime.program) throw new Error("Cannot update a stopped transport");
      return requestProgram(program, metadata, "program.update");
    }

    function acknowledgeApplied(message = {}, metadata = {}) {
      if (runtime.worklet.terminal) return Object.freeze({ accepted: false, stale: true, identity: null, snapshot: publicSnapshot() });
      const identity = normalizeIdentity(message.transport ?? message.identity ?? message, runtime.requested ?? {});
      if (!runtime.requested || !identityMatches(identity, runtime.requested)) {
        return Object.freeze({ accepted: false, stale: true, identity, snapshot: publicSnapshot() });
      }
      const before = publicSnapshot();
      runtime.applied = runtime.requested;
      runtime.appliedProgram = runtime.program;
      runtime.phase = "playing";
      runtime.playing = true;
      runtime.worklet.ready = true;
      runtime.worklet.error = null;
      runtime.trackPositions = freezeArray(message.trackPositions, trackCount);
      const after = publicSnapshot();
      const changeSet = change({
        subtype: "program.applied",
        target: "transport.program.applied",
        path: ["applied"],
        before,
        after,
        renderTargets: ["transport.controls"],
        source: metadata.source,
      });
      publish(changeSet, ["status", "render"]);
      return Object.freeze({ accepted: true, stale: false, identity, changeSet, snapshot: after });
    }

    function acknowledgeDeferred(message = {}, metadata = {}) {
      const identity = normalizeIdentity(message.transport);
      const appliedIdentity = normalizeIdentity(message.appliedTransport);
      if (runtime.worklet.terminal || !runtime.playing || runtime.stopRequest
        || !runtime.appliedProgram || !identityMatches(identity, runtime.requested)
        || identityMatches(identity, runtime.applied)
        || !identityMatches(appliedIdentity, runtime.applied)) {
        return Object.freeze({ accepted: false, stale: true, identity, snapshot: publicSnapshot() });
      }
      const before = publicSnapshot();
      runtime.program = runtime.appliedProgram;
      runtime.requested = runtime.applied;
      runtime.requestedTrackPositions = runtime.applied.requestedTrackPositions;
      runtime.phase = "playing";
      const after = publicSnapshot();
      const changeSet = change({
        subtype: "program.deferred", target: "transport.program.deferred",
        path: ["requested"], before, after, renderTargets: ["transport.controls"],
        source: metadata.source,
      });
      publish(changeSet, ["status", "render"]);
      return Object.freeze({ accepted: true, stale: false, identity, changeSet, snapshot: after });
    }

    function reportStep(message = {}, metadata = {}) {
      if (runtime.worklet.terminal) return Object.freeze({ accepted: false, stale: true, identity: null, snapshot: publicSnapshot() });
      const expected = runtime.applied ?? runtime.requested;
      const identity = normalizeIdentity(message.transport ?? message.identity ?? message, expected ?? {});
      if (!expected || !identityMatches(identity, expected)) {
        return Object.freeze({ accepted: false, stale: true, identity, snapshot: publicSnapshot() });
      }
      const index = integerOr(message.index, -1);
      if (index < 0) return Object.freeze({ accepted: false, stale: false, identity, snapshot: publicSnapshot() });
      const before = Object.freeze({ globalStep: runtime.globalStep, trackPositions: runtime.trackPositions });
      runtime.globalStep = index;
      runtime.trackPositions = freezeArray(message.trackSteps ?? message.trackPositions, trackCount);
      runtime.phase = "playing";
      runtime.playing = true;
      const after = Object.freeze({ globalStep: runtime.globalStep, trackPositions: runtime.trackPositions });
      const changeSet = change({
        subtype: "position.report",
        target: "transport.position.report",
        path: ["trackPositions"],
        before,
        after,
        renderTargets: [],
        source: metadata.source,
      });
      publish(changeSet, ["position"]);
      return Object.freeze({ accepted: true, stale: false, identity, changeSet, snapshot: publicSnapshot() });
    }

    function requestStop(metadata = {}) {
      if (runtime.worklet.terminal) return Object.freeze({ identity: null, mutated: false, changeSet: null, snapshot: publicSnapshot() });
      const before = publicSnapshot();
      const descriptor = runtime.requested ?? runtime.applied;
      const identity = descriptor ? normalizeIdentity(descriptor) : null;
      if (!runtime.playing && !runtime.program && runtime.phase === "stopped") {
        return Object.freeze({ identity: null, mutated: false, changeSet: null, snapshot: before });
      }
      runtime.stopRequest = descriptor;
      runtime.phase = "stopping";
      runtime.playing = false;
      const after = publicSnapshot();
      const changeSet = change({
        subtype: "program.stop-request",
        target: "transport.program.stop-request",
        path: ["stopRequest"],
        before,
        after,
        affectsPlayback: true,
        renderTargets: ["transport.controls"],
        source: metadata.source,
      });
      publish(changeSet, ["status", "render"]);
      return Object.freeze({ identity, mutated: true, changeSet, snapshot: after });
    }

    function acknowledgeStopped(message = {}, metadata = {}) {
      if (runtime.worklet.terminal) return Object.freeze({ accepted: false, stale: true, identity: null, snapshot: publicSnapshot() });
      const expected = runtime.stopRequest ?? runtime.applied ?? runtime.requested;
      const identity = normalizeIdentity(message.transport ?? message.identity ?? message, expected ?? {});
      if (expected && !identityMatches(identity, expected)) {
        return Object.freeze({ accepted: false, stale: true, identity, snapshot: publicSnapshot() });
      }
      const before = publicSnapshot();
      runtime.phase = "stopped";
      runtime.playing = false;
      runtime.program = null;
      runtime.appliedProgram = null;
      runtime.requested = null;
      runtime.applied = null;
      runtime.stopRequest = null;
      runtime.globalStep = -1;
      runtime.trackPositions = freezeArray([], trackCount);
      runtime.requestedTrackPositions = freezeArray([], trackCount);
      const after = publicSnapshot();
      const changeSet = change({
        subtype: "program.stopped",
        target: "transport.program.stopped",
        path: ["phase"],
        before,
        after,
        renderTargets: ["transport.controls"],
        source: metadata.source,
      });
      publish(changeSet, ["status", "render"]);
      return Object.freeze({ accepted: true, stale: false, identity, changeSet, snapshot: after });
    }

    function markWorkletReady(metadata = {}) {
      if (runtime.worklet.terminal) return Object.freeze({ mutated: false, before: false, after: false, snapshot: publicSnapshot() });
      const before = runtime.worklet.ready;
      if (before) return Object.freeze({ mutated: false, before, after: true, snapshot: publicSnapshot() });
      runtime.worklet.ready = true;
      runtime.worklet.error = null;
      const changeSet = change({
        subtype: "worklet.ready",
        target: "transport.worklet.ready",
        path: ["worklet", "ready"],
        before,
        after: true,
        renderTargets: ["transport.controls"],
        source: metadata.source,
      });
      publish(changeSet, ["status", "render"]);
      return Object.freeze({ mutated: true, before, after: true, changeSet, snapshot: publicSnapshot() });
    }

    function markWorkletError(error, metadata = {}) {
      if (runtime.worklet.terminal && metadata.terminal !== true) {
        return Object.freeze({ error: runtime.worklet.error, changeSet: null, snapshot: publicSnapshot() });
      }
      const message = error instanceof Error ? error.message : String(error || "Unknown audio runtime error");
      const before = publicSnapshot();
      runtime.phase = "error";
      runtime.playing = false;
      runtime.worklet.error = message;
      if (metadata.terminal === true) {
        // This node can never acknowledge Stop or render another program.
        runtime.worklet.terminal = true;
        runtime.worklet.ready = false;
        runtime.program = null;
        runtime.appliedProgram = null;
        runtime.requested = null;
        runtime.applied = null;
        runtime.stopRequest = null;
        runtime.globalStep = -1;
        runtime.trackPositions = freezeArray([], trackCount);
        runtime.requestedTrackPositions = freezeArray([], trackCount);
      }
      const after = publicSnapshot();
      const changeSet = change({
        subtype: "worklet.error",
        target: "transport.worklet.error",
        path: ["worklet", "error"],
        before,
        after,
        renderTargets: ["transport.controls"],
        source: metadata.source,
      });
      publish(changeSet, ["status", "render"]);
      return Object.freeze({ error: message, changeSet, snapshot: after });
    }

    return Object.freeze({
      snapshot: publicSnapshot,
      getProgram: () => runtime.program,
      getRequestedIdentity: () => runtime.requested ? normalizeIdentity(runtime.requested) : null,
      getAppliedIdentity: () => runtime.applied ? normalizeIdentity(runtime.applied) : null,
      isPlaying: () => runtime.playing,
      requestStart,
      requestUpdate,
      acknowledgeApplied,
      acknowledgeDeferred,
      reportStep,
      requestStop,
      acknowledgeStopped,
      markWorkletReady,
      markWorkletError,
      adoptLegacyProgram,
      adoptLegacyPlaying,
      constants: Object.freeze({ DEFAULT_TRACK_COUNT, PHASES }),
    });
  }

  function install(transportStore, options = {}) {
    if (transportStore.runtime) return transportStore.runtime;
    const domain = createDomain(transportStore, options);
    Object.defineProperty(transportStore, "runtime", {
      value: domain,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    return domain;
  }

  const api = Object.freeze({
    install,
    createDomain,
    normalizeIdentity,
    identityMatches,
    requestedTrackPositions,
    activeProgram,
    programMode,
    programScope,
  });

  globalThis.BRKTRKTransportRuntimeState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
