(() => {
  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  if (!storeTypes?.createProjectChangeSet || !storeTypes?.createNavigationChangeSet) {
    throw new Error("A2 project-session store boundary requires Store types");
  }

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  function defineOwn(target, key, value, enumerable = true) {
    Object.defineProperty(target, key, {
      value,
      enumerable,
      writable: true,
      configurable: true,
    });
  }

  function cloneRuntimeProject(project) {
    if (!isObject(project)) throw new TypeError("Project replacement requires an object");
    const output = {};
    for (const key of Object.keys(project)) defineOwn(output, key, clone(project[key]), true);
    if (Object.hasOwn(project, "instruments") && Array.isArray(project.instruments)) {
      defineOwn(output, "instruments", clone(project.instruments), false);
    }
    return output;
  }

  function projectIdentity(project) {
    return Object.freeze({
      schemaVersion: Number.isInteger(project?.schemaVersion) ? project.schemaVersion : null,
      projectName: String(project?.projectName ?? ""),
    });
  }

  function safeDiagnosticField(error, field, fallback) {
    try {
      const value = error?.[field];
      if (value !== undefined && value !== null) return String(value);
    } catch {}
    try { return String(error); } catch {}
    return fallback;
  }

  function reportNotificationFailure(label, error) {
    try { console.error?.(label, error); } catch {}
  }

  function notificationError(channel, error) {
    return Object.freeze({
      channel: String(channel),
      name: safeDiagnosticField(error, "name", "Error"),
      message: safeDiagnosticField(error, "message", "Unknown subscriber failure"),
    });
  }

  function isConcreteChannelStore(store) {
    return [storeTypes.ProjectStore, storeTypes.NavigationStore, storeTypes.TransportStore]
      .some((StoreType) => typeof StoreType === "function" && store instanceof StoreType);
  }

  function emitCommitted(store, channel, changeSet) {
    const listeners = store?.listeners?.get?.(String(channel));
    if (!(listeners instanceof Set)) {
      if (typeof store?.emit !== "function") return null;
      try {
        store.emit(channel, changeSet);
        return Object.freeze([]);
      } catch (error) {
        reportNotificationFailure("BRKTRK post-commit Store notification failed", error);
        return Object.freeze([notificationError(channel, error)]);
      }
    }

    const errors = [];
    for (const listener of [...listeners]) {
      try { listener(changeSet, store.state); }
      catch (error) {
        errors.push(notificationError(channel, error));
        reportNotificationFailure("BRKTRK post-commit Store subscriber failed", error);
      }
    }
    return Object.freeze(errors);
  }

  function publishCommitted(store, changeSet, channels) {
    // Only the repository's exported Store implementations may use their
    // concrete listener sets for isolated post-commit fanout. A custom Store is
    // defined by its public contract, even if it happens to keep an unrelated
    // Map-valued `listeners` property internally.
    if (!isConcreteChannelStore(store) && typeof store?.publish === "function") {
      try {
        store.publish(changeSet, channels);
        return Object.freeze([]);
      } catch (error) {
        reportNotificationFailure("BRKTRK post-commit ProjectStore publish failed", error);
        return Object.freeze([notificationError("publish", error)]);
      }
    }

    const errors = [];
    for (const channel of channels) {
      const delivered = emitCommitted(store, channel, changeSet);
      if (delivered === null) {
        const error = new TypeError(`Store cannot notify committed channel ${String(channel)}`);
        errors.push(notificationError(channel, error));
        reportNotificationFailure("BRKTRK post-commit Store notification unavailable", error);
        continue;
      }
      errors.push(...delivered);
    }
    return Object.freeze(errors);
  }

  function descriptorMismatch(actual, expected) {
    if (!actual) return "missing";
    if (Boolean(actual.configurable) !== Boolean(expected.configurable)) return "configurable";
    if (Boolean(actual.enumerable) !== Boolean(expected.enumerable)) return "enumerable";
    const expectedData = Object.hasOwn(expected, "value") || Object.hasOwn(expected, "writable");
    const actualData = Object.hasOwn(actual, "value") || Object.hasOwn(actual, "writable");
    if (actualData !== expectedData) return "kind";
    if (expectedData) {
      if (Boolean(actual.writable) !== Boolean(expected.writable)) return "writable";
      if (!Object.is(actual.value, expected.value)) return "value";
      return null;
    }
    if (!Object.is(actual.get, expected.get)) return "get";
    if (!Object.is(actual.set, expected.set)) return "set";
    return null;
  }

  function descriptorVerificationFailures(target, expectedDescriptors) {
    try {
      const actualDescriptors = Object.getOwnPropertyDescriptors(target);
      const expectedKeys = Object.getOwnPropertyNames(expectedDescriptors);
      const actualKeys = Object.getOwnPropertyNames(actualDescriptors);
      const failures = [];
      for (const key of actualKeys) {
        if (!Object.hasOwn(expectedDescriptors, key)) failures.push(`unexpected:${key}`);
      }
      for (const key of expectedKeys) {
        if (!Object.hasOwn(actualDescriptors, key)) {
          failures.push(`missing:${key}`);
          continue;
        }
        const mismatch = descriptorMismatch(actualDescriptors[key], expectedDescriptors[key]);
        if (mismatch) failures.push(`${mismatch}:${key}`);
      }
      return Object.freeze(failures);
    } catch (error) {
      return Object.freeze([`inspect:${safeDiagnosticField(error, "message", "error")}`]);
    }
  }

  function restoreDescriptors(target, descriptors) {
    const failures = [];
    for (const key of Object.getOwnPropertyNames(target)) {
      try {
        if (!Reflect.deleteProperty(target, key)) failures.push(`delete:${key}`);
      } catch (error) {
        failures.push(`delete:${key}:${safeDiagnosticField(error, "message", "error")}`);
      }
    }
    for (const key of Object.getOwnPropertyNames(descriptors)) {
      try {
        if (!Reflect.defineProperty(target, key, descriptors[key])) failures.push(`define:${key}`);
      } catch (error) {
        failures.push(`define:${key}:${safeDiagnosticField(error, "message", "error")}`);
      }
    }
    failures.push(...descriptorVerificationFailures(target, descriptors).map((failure) => `verify:${failure}`));
    return Object.freeze(failures);
  }

  function replaceOwnDescriptors(target, replacement) {
    const original = Object.getOwnPropertyDescriptors(target);
    const targetKeys = Object.getOwnPropertyNames(target);
    for (const key of targetKeys) {
      const descriptor = original[key];
      if (descriptor?.configurable === false) throw new Error(`Project field ${key} is not replaceable`);
    }

    try {
      for (const key of targetKeys) {
        if (!Reflect.deleteProperty(target, key)) throw new Error(`Could not clear project field ${key}`);
      }
      for (const key of Object.getOwnPropertyNames(replacement)) {
        if (!Reflect.defineProperty(target, key, replacement[key])) throw new Error(`Could not install project field ${key}`);
      }
      const verificationFailures = descriptorVerificationFailures(target, replacement);
      if (verificationFailures.length > 0) {
        throw new Error(`Project replacement verification failed: ${verificationFailures.join(", ")}`);
      }
      return true;
    } catch (error) {
      const rollbackFailures = restoreDescriptors(target, original);
      if (rollbackFailures.length > 0) {
        const wrapped = new Error(`Project replacement failed and descriptor rollback was incomplete: ${rollbackFailures.join(", ")}`);
        try { wrapped.cause = error; } catch {}
        throw wrapped;
      }
      throw error;
    }
  }

  function replaceProjectState(projectStore, nextProject, metadata = {}) {
    if (!projectStore?.getState || !projectStore?.publish) throw new TypeError("ProjectStore replacement boundary is unavailable");
    const target = projectStore.getState();
    const prepared = cloneRuntimeProject(nextProject);
    const before = projectIdentity(target);
    const after = projectIdentity(prepared);

    // Prepare every successor descriptor before touching the live object. The
    // descriptor mutation itself is guarded and rolls back on pre-commit
    // failure. After it succeeds, subscriber work is post-commit and cannot
    // make the old Project become true again.
    const replacement = Object.getOwnPropertyDescriptors(prepared);
    replaceOwnDescriptors(target, replacement);

    const changeSet = storeTypes.createProjectChangeSet({
      subtype: "file.replace",
      target: "project.file.replace",
      path: [],
      before,
      after,
      affectsPlayback: true,
      persistsProject: true,
      renderTargets: ["project.all"],
      source: metadata.source ?? "project-file-session",
      transaction: {
        operation: metadata.operation ?? "replace",
        fileName: metadata.fileName ?? null,
      },
    });
    const notificationErrors = publishCommitted(projectStore, changeSet, ["project", "persistence", "audio", "render", "track-mix"]);
    return Object.freeze({ value: target, before, after, mutated: true, projectChangeSet: changeSet, notificationErrors });
  }

  function firstProjectContext(project) {
    const song = Array.isArray(project?.song) ? project.song : [];
    const chains = isObject(project?.chains) ? project.chains : {};
    const phrases = isObject(project?.phrases) ? project.phrases : {};
    let songRow = 0;
    let track = 0;
    let chainId = null;

    outer: for (let row = 0; row < song.length; row += 1) {
      for (let lane = 0; lane < (Array.isArray(song[row]) ? song[row].length : 0); lane += 1) {
        const candidate = song[row][lane];
        if (Number.isInteger(candidate) && candidate >= 0 && Object.hasOwn(chains, candidate)) {
          songRow = row;
          track = lane;
          chainId = candidate;
          break outer;
        }
      }
    }
    if (chainId == null) {
      const first = Object.keys(chains).map(Number).filter(Number.isInteger).sort((a, b) => a - b)[0];
      chainId = Number.isInteger(first) ? first : 0;
    }

    const chainRows = Array.isArray(chains[chainId]) ? chains[chainId] : [];
    let chainRow = chainRows.findIndex((row) => Number.isInteger(row?.phrase) && row.phrase >= 0 && Object.hasOwn(phrases, row.phrase));
    if (chainRow < 0) chainRow = 0;
    let phraseId = chainRows[chainRow]?.phrase;
    if (!Number.isInteger(phraseId) || phraseId < 0 || !Object.hasOwn(phrases, phraseId)) {
      const first = Object.keys(phrases).map(Number).filter(Number.isInteger).sort((a, b) => a - b)[0];
      phraseId = Number.isInteger(first) ? first : 0;
    }

    return Object.freeze({ songRow, track, chain: chainId, chainRow, phrase: phraseId });
  }

  function resetNavigationForProject(navigationStore, project, metadata = {}) {
    if (!navigationStore?.state || typeof navigationStore.emit !== "function") {
      throw new TypeError("NavigationStore project reset boundary is unavailable");
    }
    const state = navigationStore.state;
    state.p3 ??= {};
    const beforeContext = storeTypes.normalizeNavigationContext({}, state);
    const before = {
      context: beforeContext,
      returnDepth: Array.isArray(state.p3.parents) ? state.p3.parents.length : 0,
      mixReturn: clone(state.p3.mixReturn ?? null),
      activeSheet: state.p3.activeSheet ?? null,
    };
    const base = firstProjectContext(project);
    const target = storeTypes.normalizeNavigationContext({
      view: "phrase",
      dock: "none",
      activeWorkspace: "phrase",
      focus: { pane: "phrase", row: 0, col: 0 },
      songRow: base.songRow,
      track: base.track,
      chain: base.chain,
      chainRow: base.chainRow,
      phrase: base.phrase,
      phraseRow: 0,
      instrument: 0,
      soundParam: 0,
      lastChain: base.chain,
      lastPhrase: base.phrase,
    }, state);

    state.view = target.view;
    state.dock = target.dock;
    state.songRow = target.songRow;
    state.track = target.track;
    state.chain = target.chain;
    state.chainRow = target.chainRow;
    state.phrase = target.phrase;
    state.phraseRow = target.phraseRow;
    state.instrument = target.instrument;
    state.focus = clone(target.focus);
    state.lastChain = target.lastChain;
    state.lastPhrase = target.lastPhrase;
    state.p3.soundParam = target.soundParam;
    state.p3.activeWorkspace = target.activeWorkspace;
    state.p3.parents = [];
    state.p3.mixReturn = null;
    state.p3.activeSheet = null;
    state.p3.valueReturn = { originCursor: null, returnSheet: null, returnCursor: null };
    state.p3.preparedEntry = {
      velocity: 100,
      instrument: 0,
      octave: 4,
      editStep: 1,
      preview: true,
      applying: false,
      locked: false,
    };

    const after = {
      context: storeTypes.normalizeNavigationContext({}, state),
      returnDepth: 0,
      mixReturn: null,
      activeSheet: null,
    };
    const changeSet = storeTypes.createNavigationChangeSet({
      subtype: "project.reset",
      target: "navigation.projectReset",
      path: ["projectContext"],
      before,
      after,
      renderTargets: [
        "navigation.workspace", "navigation.context", "navigation.focus",
        "navigation.activeSheet", "navigation.preparedEntry",
      ],
      source: metadata.source ?? "project-file-session",
      transaction: { operation: metadata.operation ?? "replace" },
    });
    const notificationErrors = publishCommitted(navigationStore, changeSet, ["navigation"]);
    return Object.freeze({ value: after.context, before, after, mutated: true, navigationChangeSet: changeSet, notificationErrors });
  }

  function install(projectStore, navigationStore) {
    if (!projectStore || !navigationStore) throw new TypeError("A2 project-session store boundary requires ProjectStore and NavigationStore");
    if (!projectStore.fileSession) {
      Object.defineProperty(projectStore, "fileSession", {
        enumerable: false,
        configurable: false,
        writable: false,
        value: Object.freeze({
          replaceProject: (nextProject, metadata) => replaceProjectState(projectStore, nextProject, metadata),
        }),
      });
    }
    if (!navigationStore.fileSession) {
      Object.defineProperty(navigationStore, "fileSession", {
        enumerable: false,
        configurable: false,
        writable: false,
        value: Object.freeze({
          resetForProject: (project, metadata) => resetNavigationForProject(navigationStore, project, metadata),
        }),
      });
    }
    return Object.freeze({ project: projectStore.fileSession, navigation: navigationStore.fileSession });
  }

  const api = Object.freeze({
    cloneRuntimeProject,
    projectIdentity,
    safeDiagnosticField,
    notificationError,
    isConcreteChannelStore,
    emitCommitted,
    publishCommitted,
    descriptorMismatch,
    descriptorVerificationFailures,
    restoreDescriptors,
    replaceOwnDescriptors,
    firstProjectContext,
    replaceProjectState,
    resetNavigationForProject,
    install,
  });
  globalThis.BRKTRKProjectFileSessionStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
