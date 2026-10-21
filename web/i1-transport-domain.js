(() => {
  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  if (!storeTypes) throw new Error("Store types are required for I1 transport queue ownership");

  const domains = new WeakMap();
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const integerOr = (value, fallback = 0) => Number.isInteger(Number(value)) ? Number(value) : fallback;

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

  function normalizeBoundary(candidate = {}) {
    return Object.freeze({
      kind: candidate.kind === "phrase" ? "phrase" : "phrase",
      track: Math.max(0, integerOr(candidate.track, 0)),
      requestedAfter: integerOr(candidate.requestedAfter, -1),
    });
  }

  function normalizeRequest(candidate = {}, scope = "phrase") {
    return Object.freeze({
      scope,
      songRow: Math.max(0, integerOr(candidate.songRow, 0)),
      track: Math.max(0, integerOr(candidate.track, 0)),
      chainId: integerOr(candidate.chainId, -1),
      chainRow: Math.max(0, integerOr(candidate.chainRow, 0)),
      phraseId: integerOr(candidate.phraseId, -1),
      continueFromChain: candidate.continueFromChain === true,
      explicit: candidate.explicit !== false,
    });
  }

  function install(transportStore, runtime) {
    if (!transportStore || transportStore.owner !== "transport") {
      throw new TypeError("I1 transport queue requires TransportStore");
    }
    if (!runtime?.requestUpdate || !runtime?.snapshot) {
      throw new TypeError("I1 transport queue requires the TransportStore runtime domain");
    }
    if (domains.has(transportStore)) return domains.get(transportStore);

    const state = transportStore.getState();
    const previous = state.transportI1 && typeof state.transportI1 === "object" ? state.transportI1 : {};
    const queue = {
      version: Math.max(0, integerOr(previous.version, 0)),
      descriptor: null,
      program: null,
    };
    state.transportI1 = queue;

    function publicSnapshot() {
      return Object.freeze({
        version: queue.version,
        queued: queue.descriptor,
      });
    }

    function publish(changeSet) {
      for (const channel of ["transport", "status", "render"]) transportStore.emit(channel, changeSet);
    }

    function change({ subtype, target, before, after, source = null }) {
      return storeTypes.createTransportChangeSet({
        subtype,
        target,
        path: ["queued"],
        before,
        after,
        affectsPlayback: true,
        renderTargets: ["transport.controls"],
        source,
      });
    }

    function requestQueue(program, metadata = {}) {
      if (!program || typeof program !== "object") throw new TypeError("Queued transport program must be an object");
      if (!activeProgram(program)) throw new RangeError("Queued transport program has no playable content");
      const before = publicSnapshot();
      queue.version += 1;
      const scope = programScope(program);
      queue.program = program;
      queue.descriptor = Object.freeze({
        id: `queue-${queue.version}`,
        version: queue.version,
        mode: programMode(program),
        scope,
        active: true,
        boundary: normalizeBoundary(metadata.boundary),
        request: normalizeRequest(metadata.request, scope),
        source: metadata.source ?? null,
      });
      const after = publicSnapshot();
      const changeSet = change({
        subtype: before.queued ? "program.queue-replace" : "program.queue",
        target: before.queued ? "transport.program.queue-replace" : "transport.program.queue",
        before,
        after,
        source: metadata.source,
      });
      publish(changeSet);
      return Object.freeze({ descriptor: queue.descriptor, program: queue.program, changeSet, snapshot: after });
    }

    function cancelQueue(metadata = {}) {
      const before = publicSnapshot();
      if (!queue.descriptor) return Object.freeze({ mutated: false, changeSet: null, snapshot: before });
      queue.descriptor = null;
      queue.program = null;
      const after = publicSnapshot();
      const changeSet = change({
        subtype: "program.queue-cancel",
        target: "transport.program.queue-cancel",
        before,
        after,
        source: metadata.source,
      });
      publish(changeSet);
      return Object.freeze({ mutated: true, changeSet, snapshot: after });
    }

    function commitQueue(metadata = {}) {
      const before = publicSnapshot();
      if (!queue.descriptor || !queue.program) {
        return Object.freeze({ committed: false, request: null, changeSet: null, snapshot: before });
      }
      if (!runtime.isPlaying()) {
        cancelQueue({ source: metadata.source ?? "queue-commit-stopped" });
        return Object.freeze({ committed: false, request: null, changeSet: null, snapshot: publicSnapshot() });
      }
      const descriptor = queue.descriptor;
      const program = queue.program;
      queue.descriptor = null;
      queue.program = null;
      const request = runtime.requestUpdate(program, { source: metadata.source ?? "i1-queue-commit" });
      const after = publicSnapshot();
      const changeSet = change({
        subtype: "program.queue-commit",
        target: "transport.program.queue-commit",
        before: Object.freeze({ ...before, committedQueue: clone(descriptor) }),
        after: Object.freeze({ ...after, requested: request.identity }),
        source: metadata.source,
      });
      publish(changeSet);
      return Object.freeze({ committed: true, descriptor, program, request, changeSet, snapshot: after });
    }

    const domain = Object.freeze({
      snapshot: publicSnapshot,
      getQueuedProgram: () => queue.program,
      requestQueue,
      cancelQueue,
      commitQueue,
    });
    domains.set(transportStore, domain);
    return domain;
  }

  const api = Object.freeze({ install, normalizeBoundary, normalizeRequest });
  if (typeof globalThis !== "undefined") globalThis.BRKTRKI1TransportDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
