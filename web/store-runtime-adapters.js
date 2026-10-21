(() => {
  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  const transportRuntimeDomain = globalThis.BRKTRKTransportRuntimeState
    ?? (typeof require === "function" ? require("./transport-runtime-state.js") : null);
  const phraseStepDomain = globalThis.BRKTRKProjectPhraseStep
    ?? (typeof require === "function" ? require("./project-phrase-step.js") : null);
  const navigationEntryDomain = globalThis.BRKTRKNavigationEntryState
    ?? (typeof require === "function" ? require("./navigation-entry-state.js") : null);
  if (!storeTypes || !transportRuntimeDomain || !phraseStepDomain || !navigationEntryDomain) {
    throw new Error("Store types, transport runtime, Phrase-step and Navigation entry domains must load before runtime adapters");
  }

  function parsePhraseRowTarget(target) {
    const match = /^phrase\.row\.(\d+)\.(\d+)$/.exec(String(target));
    return match ? { phraseId: Number(match[1]), row: Number(match[2]) } : null;
  }

  function parseInstrumentParameterTarget(target) {
    const production = /^production-instrument\.parameter\.(\d+)\.(.+)$/.exec(String(target));
    if (!production) return null;
    const parameterId = String(production[2] ?? "").trim();
    return parameterId ? { instrumentId: Number(production[1]), parameterId, production: true } : null;
  }

  function structuralPlaybackChange(changeSet) {
    if (typeof changeSet?.structuralPlayback === "boolean") return changeSet.structuralPlayback;
    return Boolean(changeSet?.affectsPlayback);
  }

  function historyOriginalTarget(changeSet) {
    if (changeSet?.subtype !== "history.undo" && changeSet?.subtype !== "history.redo") return null;
    const target = String(changeSet?.transaction?.originalTarget ?? "").trim();
    return target || null;
  }

  function createBrowserProjectSubscribers(root, stores, environment = {}) {
    const document = root.document;
    const persistProject = environment.persistProject;
    const setAudioTempo = environment.setAudioTempo;
    const refreshPlayback = environment.refreshPlayback;
    const renderPhraseStep = environment.renderPhraseStep;
    const renderInstrumentParameter = environment.renderInstrumentParameter;
    const renderInstrumentContext = environment.renderInstrumentContext;
    const renderInstrumentPresets = environment.renderInstrumentPresets;
    return Object.freeze({
      persistence: () => {
        if (typeof persistProject === "function") persistProject();
      },
      audio: (changeSet) => {
        const directTempo = changeSet.target === "project.tempo";
        const restoredTempo = historyOriginalTarget(changeSet) === "project.tempo";
        if ((directTempo || restoredTempo) && typeof setAudioTempo === "function") {
          const value = directTempo ? changeSet.after : stores.project.select(storeTypes.selectors.tempo);
          setAudioTempo(value);
          return;
        }
        // Only structural changes re-plan playback. A change that is audible but
        // non-structural (an ordinary live Instrument parameter) reaches the
        // engine through its dedicated owner and must not enter program refresh.
        // Older/hand-built changeSets without the explicit signal keep the
        // previous `affectsPlayback` behavior.
        if (structuralPlaybackChange(changeSet) && typeof refreshPlayback === "function") refreshPlayback(changeSet);
      },
      render: (changeSet) => {
        if (!document) return;
        if (changeSet.renderTargets.includes("transport.tempo")) {
          const output = document.querySelector("#tempoValue");
          if (output) output.textContent = String(stores.project.select(storeTypes.selectors.tempo));
        }
        if (changeSet.renderTargets.includes("project.identity.name")) {
          const output = document.querySelector("#projectName");
          if (output) output.textContent = stores.project.select(storeTypes.selectors.projectName);
        }
        for (const target of changeSet.renderTargets) {
          const phraseRow = parsePhraseRowTarget(target);
          if (phraseRow && typeof renderPhraseStep === "function") {
            renderPhraseStep(phraseRow.phraseId, phraseRow.row, changeSet);
          }
          const instrumentParameter = parseInstrumentParameterTarget(target);
          if (instrumentParameter && typeof renderInstrumentParameter === "function") {
            renderInstrumentParameter(changeSet, instrumentParameter);
          }
        }
        if (changeSet.renderTargets.includes("instrument.presets") && typeof renderInstrumentPresets === "function") {
          renderInstrumentPresets(changeSet);
        }
        if (changeSet.renderTargets.includes("instrument.context") && typeof renderInstrumentContext === "function") {
          renderInstrumentContext(changeSet);
        }
      },
    });
  }

  function createBrowserNavigationSubscribers(root, stores, environment = {}) {
    const document = root.document;
    const renderPreparedEntry = environment.renderPreparedEntry;
    const renderActiveSheet = environment.renderActiveSheet;
    const releaseActiveSheetInput = environment.releaseActiveSheetInput;
    const sheetSurfaces = Object.freeze([
      { sheet: "note", selector: "#p3NoteDock", bodyClass: "p3-note-open" },
      { sheet: "value", selector: "#p32ValueDock", bodyClass: "p32-value-open" },
      { sheet: "context", selector: "#p3ContextPicker", bodyClass: "p3-context-picker-open" },
      { sheet: "follow-scope", selector: "#p36MobilePolicyPanel", bodyClass: "p36-follow-scope-open" },
    ]);

    function updateActiveSheet() {
      const activeSheet = stores.navigation.entryState.getActiveSheet();
      if (document) {
        for (const surface of sheetSurfaces) {
          const active = activeSheet === surface.sheet;
          const element = document.querySelector(surface.selector);
          if (element) {
            element.setAttribute("aria-hidden", String(!active));
            if (surface.elementClass) element.classList.toggle(surface.elementClass, active);
          }
          document.body?.classList.toggle(surface.bodyClass, active);
        }
        const policyButton = document.querySelector("#p36MobilePolicyButton");
        if (policyButton) policyButton.setAttribute("aria-expanded", String(activeSheet === "follow-scope"));
      }
      if (typeof renderActiveSheet === "function") renderActiveSheet(activeSheet);
      return activeSheet;
    }

    function updatePreparedEntry() {
      const preparedEntry = stores.navigation.entryState.getPreparedEntry();
      if (typeof renderPreparedEntry === "function") renderPreparedEntry(preparedEntry);
    }

    return Object.freeze({
      navigation: (changeSet) => {
        if (changeSet.renderTargets.includes("navigation.activeSheet")) {
          if (changeSet.before !== changeSet.after && typeof releaseActiveSheetInput === "function") {
            releaseActiveSheetInput(changeSet.before, changeSet.after, changeSet);
          }
          updateActiveSheet();
        }
        if (changeSet.renderTargets.includes("navigation.preparedEntry")) updatePreparedEntry();
      },
      refreshActiveSheet: updateActiveSheet,
      initial: () => {
        updateActiveSheet();
        updatePreparedEntry();
      },
    });
  }

  function createBrowserTransportSubscribers(root, stores, environment = {}) {
    const renderTransport = environment.renderTransport;
    return Object.freeze({
      render: (changeSet) => {
        if (!changeSet.renderTargets.includes("transport.controls")) return;
        if (typeof renderTransport === "function") renderTransport(changeSet, stores.transport.runtime.snapshot());
      },
    });
  }

  function install(root, environment = {}) {
    if (root.BRKTRKStoreRuntime?.installed) return root.BRKTRKStoreRuntime;
    const project = environment.model;
    const navigation = environment.state;
    if (!project || !navigation) throw new TypeError("Store runtime adapters require project and navigation state");
    const trackCount = Number.isInteger(environment.trackCount) ? environment.trackCount : 8;
    const stores = environment.stores ?? storeTypes.createStores({ model: project, state: navigation, trackCount });
    transportRuntimeDomain.install(stores.transport, { trackCount });
    phraseStepDomain.install(stores.project);
    navigationEntryDomain.install(stores.navigation);

    const subscribers = createBrowserProjectSubscribers(root, stores, environment);
    const navigationSubscribers = createBrowserNavigationSubscribers(root, stores, environment);
    const transportSubscribers = createBrowserTransportSubscribers(root, stores, environment);
    const disconnectProject = storeTypes.connectProjectSubscribers(stores.project, subscribers);
    const disconnectNavigation = stores.navigation.subscribe("navigation", navigationSubscribers.navigation);
    const disconnectTransportRender = stores.transport.subscribe("render", transportSubscribers.render);
    navigationSubscribers.initial();

    const disconnect = () => {
      disconnectProject();
      disconnectNavigation();
      disconnectTransportRender();
    };
    root.BRKTRKStores = stores;
    root.BRKTRKStoreDisconnect = disconnect;
    const runtime = Object.freeze({
      installed: true,
      stores,
      subscribers,
      navigationSubscribers,
      transportSubscribers,
      disconnect,
    });
    root.BRKTRKStoreRuntime = runtime;
    if (root.document?.body) {
      root.document.body.dataset.storeArchitecture = "m4.0a";
      root.document.body.dataset.transportStoreArchitecture = "m4.0a-i0";
      root.document.body.dataset.navigationEntryArchitecture = "m4.0a-e4";
      root.document.body.dataset.navigationEntryConsolidation = "m4.0a-e5";
    }
    return runtime;
  }

  const api = Object.freeze({
    parsePhraseRowTarget,
    parseInstrumentParameterTarget,
    structuralPlaybackChange,
    historyOriginalTarget,
    createBrowserProjectSubscribers,
    createBrowserNavigationSubscribers,
    createBrowserTransportSubscribers,
    install,
  });

  globalThis.BRKTRKStoreRuntimeAdapters = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalThis.document && typeof model !== "undefined" && typeof state !== "undefined") {
    install(globalThis, {
      model,
      state,
      trackCount: typeof TRACKS !== "undefined" ? TRACKS : 8,
      persistProject: () => globalThis.BRKTRKProjectPersistence?.save?.(),
      setAudioTempo: (value) => {
        if (typeof audio !== "undefined" && typeof audio.tempo === "function") audio.tempo(value);
      },
      refreshPlayback: (changeSet) => globalThis.BRKTRKProjectPlaybackRefresh?.refresh?.(changeSet),
      renderPhraseStep: (phraseId, row) => globalThis.BRKTRKPhraseStepRenderer?.render?.(phraseId, row),
      renderInstrumentParameter: (changeSet) => globalThis.BRKTRKSoundEditRenderer?.renderProjectMutation?.(changeSet),
      // A user-preset library edit redraws the preset panel where it stands.
      // It must not reach renderInstrumentParameters, which replaces the whole
      // inspector and re-verifies the engine package.
      renderInstrumentPresets: () => globalThis.BRKTRKSoundPresetSurface?.refreshMountedPresetPanels?.(),
      renderInstrumentContext: () => {
        if (typeof renderPhrase === "function") renderPhrase();
        if (typeof renderFocusState === "function") renderFocusState();
        if (typeof renderInspectorIdentity === "function") renderInspectorIdentity();
        if (typeof renderInstrumentParameters === "function") renderInstrumentParameters();
      },
      renderPreparedEntry: () => {
        globalThis.BRKTRKNoteEntry?.refresh?.();
        globalThis.BRKTRKCommandBindings?.refreshNoteDock?.();
      },
      releaseActiveSheetInput: (beforeSheet) => {
        // Any sheet change drops held keys: a modifier held while the surface under it
        // is replaced would otherwise stay stuck and turn the next tap into a chord.
        globalThis.BRKTRKCommandBindings?.releaseHeldKeys?.();
        if (beforeSheet === "note") globalThis.BRKTRKNoteEntry?.releaseInput?.();
        if (beforeSheet === "value") globalThis.BRKTRKValueDock?.releaseInput?.();
      },
      renderActiveSheet: (activeSheet) => {
        globalThis.BRKTRKCommandBindings?.refreshNoteDock?.();
        globalThis.BRKTRKCommandBindings?.renderTouchController?.(activeSheet);
        globalThis.BRKTRKValueDock?.renderNavigationState?.(activeSheet);
        globalThis.BRKTRKMobileContextPicker?.renderNavigationState?.(activeSheet);
        globalThis.BRKTRKTransport?.renderNavigationState?.(activeSheet);
        globalThis.BRKTRKContextualSheetViewport?.syncNow?.("navigation-active-sheet");
      },
      renderTransport: () => {
        if (typeof renderTransport === "function") renderTransport();
      },
    });
  }
})();
