const DYNAMIC_ASSET_RELEASE = "0.9.0";
const releaseAsset = (path) => `${path}?v=${encodeURIComponent(DYNAMIC_ASSET_RELEASE)}`;
globalThis.BRKTRK_VERSION = DYNAMIC_ASSET_RELEASE;

const DYNAMIC_STYLE_ASSETS = Object.freeze([
  "./release-identity.css",
  "./mobile-context-picker.css",
  "./value-dock.css",
  "./note-entry-ui.css",
  "./touch-actions.css",
  "./p36.css",
  "./track-mixer.css",
  "./track-insert-fx.css",
  "./honest-surface.css",
  "./undo-redo.css",
  "./selection-clipboard.css",
  "./phrase-row-operations.css",
  "./ux1-visual-foundation.css",
  "./ux1-desktop-shell.css",
  "./ux1-context-sheet.css",
  "./ux1-sound-workbench.css",
]);

const DYNAMIC_SCRIPT_ASSETS = Object.freeze([
  "./track-insert-fx-domain.js",
  "./stores.js",
  "./transport-runtime-state.js",
  "./prepared-instrument-state-domain.js",
  "./prepared-instrument-application-state.js",
  "./audio-lifecycle-policy.js",
  "./audio-lifecycle-domain.js",
  "./engine-package-domain.js",
  "./engine-package-loader.js",
  "./engine-package-tar-domain.js",
  "./engine-package-browser.js",
  "./sample-asset-domain.js",
  "./sample-asset-store.js",
  "./sample-asset-host.js",
  "./sample-asset-surface.js",
  "./production-engine-host.js",
  "./production-engine-prepared-state-host-extension.js",
  "./production-engine-bootstrap.js",
  "./timing-domain.js",
  "./timing-map-domain.js",
  "./table-source-domain.js",
  "./production-timeline-domain.js",
  "./production-timeline-template.js",
  "./note-lifecycle-domain.js",
  "./i1-transport-domain.js",
  "./phrase-fx-domain.js",
  "./phrase-fx-runtime-domain.js",
  "./event-trace-domain.js",
  "./production-execution-template.js",
  "./project-phrase-step.js",
  "./project-structure.js",
  "./phrase-row-presentation.js",
  "./structural-reference-graph.js",
  "./phrase-step-renderer.js",
  "./structural-renderer.js",
  "./sound-edit-renderer.js",
  "./navigation-entry-state.js",
  "./store-runtime-adapters.js",
  "./production-engine-store-sync.js",
  "./project-file.js",
  "./project-file-session-store.js",
  "./audio-lifecycle.js",
  "./contextual-sheet-viewport.js",
  "./field-schema.js",
  "./phrase-fx-semantic-surface.js",
  "./honest-surface.js",
  "./hierarchy-context-renderer.js",
  "./mix-context-renderer.js",
  "./occurrence-context-renderer.js",
  "./workspace-context-renderer.js",
  "./project-structure-runtime.js",
  "./command-state.js",
  "./transport-command-bridge.js",
  "./command-dispatcher.js",
  "./value-dock.js",
  "./phrase-condition-surface.js",
  "./phrase-fx-phone-editor.js",
  "./prepared-entry-transaction.js",
  "./note-entry-ui.js",
  "./paste-target-input-router.js",
  "./command-bindings.js",
  "./debug-snapshot.js",
  "./production-engine-diagnostics.js",
  "./undo-redo.js",
  "./project-file-session.js",
  "./project-file-session-ui.js",
  "./project-recovery.js",
  "./selection-clipboard.js",
  "./structural-row-operations.js",
  "./keyboard-command-resolver.js",
  "./phrase-row-operations.js",
  "./input-safety.js",
  "./touch-action-policy.js",
  "./touch-actions.js",
  "./mobile-context-picker.js",
  "./song-transport-policy.js",
  "./project-transport-policy.js",
  "./event-plan-compiler.js",
  "./p36-transport.js",
  "./k3c-transport-adapter.js",
  "./project-playback-refresh.js",
  "./i1-scope-controls.js",
  "./follow-hold-policy.js",
  "./i1-transport.js",
  "./mixer-transport-safety.js",
  "./audio-lifecycle-controls.js",
  "./transport-state-ui.js",
  "./audio-lifecycle-ui.js",
  "./track-mix-domain.js",
  "./track-mix-runtime.js",
  "./track-insert-fx-runtime.js",
  "./output-latency-domain.js",
  "./track-mixer.js",
  "./track-insert-fx-surface.js",
  "./sw-update-handover.js",
  "./architecture-convergence-c3.js",
]);

const dynamicRuntimeTiming = {
  preloadStartedAtMs: null,
  executionStartedAtMs: null,
  readyAtMs: null,
  scriptsLoaded: 0,
  slowestScript: null,
  slowestScriptMs: 0,
};

function dynamicRuntimeSnapshot() {
  return Object.freeze({
    version: 1,
    owner: "app-bind-dynamic-runtime",
    preloadStartedAtMs: dynamicRuntimeTiming.preloadStartedAtMs,
    executionStartedAtMs: dynamicRuntimeTiming.executionStartedAtMs,
    readyAtMs: dynamicRuntimeTiming.readyAtMs,
    scriptsLoaded: dynamicRuntimeTiming.scriptsLoaded,
    scriptCount: DYNAMIC_SCRIPT_ASSETS.length,
    slowestScript: dynamicRuntimeTiming.slowestScript,
    slowestScriptMs: Number(dynamicRuntimeTiming.slowestScriptMs.toFixed(3)),
    executionDurationMs: dynamicRuntimeTiming.executionStartedAtMs == null
      ? null
      : Number(((dynamicRuntimeTiming.readyAtMs ?? performance.now()) - dynamicRuntimeTiming.executionStartedAtMs).toFixed(3)),
  });
}

globalThis.BRKTRKDynamicRuntimeStartup = Object.freeze({ snapshot: dynamicRuntimeSnapshot });

function warmDynamicScripts() {
  if (dynamicRuntimeTiming.preloadStartedAtMs != null) return false;
  dynamicRuntimeTiming.preloadStartedAtMs = performance.now();
  for (const src of DYNAMIC_SCRIPT_ASSETS) {
    if (document.querySelector(`link[data-brktrk-preload="${src}"]`)) continue;
    const preload = document.createElement("link");
    preload.rel = "preload";
    preload.as = "script";
    preload.dataset.brktrkPreload = src;
    preload.href = releaseAsset(src);
    document.head.append(preload);
  }
  return true;
}

warmDynamicScripts();

const baseBrowserSafetyCopyPersist = persist;
let browserSafetyCopyEnabled = true;
function saveBrowserSafetyCopy() {
  if (!browserSafetyCopyEnabled) return false;
  baseBrowserSafetyCopyPersist();
  return true;
}
persist = function c3LegacyPersistCompatibility() {
  const saved = saveBrowserSafetyCopy();
  globalThis.BRKTRKProjectPlaybackRefresh?.refreshLegacy?.({ source: "legacy-persist-compat" });
  return saved;
};
globalThis.BRKTRKProjectPersistence ??= Object.freeze({
  save: saveBrowserSafetyCopy,
  setLocalAutosaveEnabled(value) {
    browserSafetyCopyEnabled = Boolean(value);
    return browserSafetyCopyEnabled;
  },
  isLocalAutosaveEnabled() {
    return browserSafetyCopyEnabled;
  },
});

// A4B2 removes the pre-production Instrument renderer before the first paint.
// The real package-driven Sound renderer replaces this bootstrap placeholder
// once the ordered production modules have loaded. No legacy Instrument model
// is required during startup.
renderInstrumentParameters = function renderProductionBootstrapInstrumentParameters() {
  const inspector = $("#instrumentInspector");
  if (!inspector) return false;
  inspector.replaceChildren();
  const status = document.createElement("div");
  status.className = "a4a-create-panel";
  status.textContent = "PRODUCTION SOUND INITIALIZING…";
  inspector.append(status);
  globalThis.BRKTRKSoundEditRenderer?.renderProductionSurface?.();
  return true;
};

// The authoritative Track mixer owns gain/pan/mute. Until its dynamic module
// loads, keep the legacy bootstrap mixer empty rather than reconstructing mix
// state from the removed preview Instrument array.
renderMixer = function renderTrackMixerBootstrapSurface() {
  const mixer = $("#mixer");
  if (!mixer) return false;
  mixer.replaceChildren();
  mixer.dataset.routingState = "track-owned-bootstrap";
  return true;
};

function repeatButton(button, action) {
  if (!button) return;
  let timer = 0;
  let repeater = 0;
  const stop = () => {
    window.clearTimeout(timer);
    window.clearInterval(repeater);
    timer = 0;
    repeater = 0;
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    action();
    timer = window.setTimeout(() => {
      repeater = window.setInterval(action, 75);
    }, 340);
  });
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointercancel", stop);
  button.addEventListener("lostpointercapture", stop);
}

async function enableProductionAudio() {
  try {
    await audio.init({ source: "enable-audio-button" });
    renderTransport();
    setStatus("PRODUCTION AUDIO · READY");
    return true;
  } catch (error) {
    console.error(error);
    const terminal = globalThis.BRKTRKAudioReadiness?.snapshot?.().terminalError;
    setStatus(terminal ? "AUDIO PROCESSOR STOPPED · RELOAD APP" : "AUDIO FAILED · RETRY", "danger");
    return false;
  }
}

function dispatchSemantic(command) {
  if (!globalThis.BRKTRKCommands?.dispatch) {
    setStatus("COMMAND LAYER INITIALIZING", "amber");
    return null;
  }
  return globalThis.BRKTRKCommands.dispatch(command);
}

function bindUi() {
  $("#bootButton").addEventListener("click", enableProductionAudio);

  $("#playButton").addEventListener("click", async () => {
    try { await togglePlayback(false); }
    catch (error) {
      const terminal = globalThis.BRKTRKAudioReadiness?.snapshot?.().terminalError;
      setStatus(terminal ? "AUDIO PROCESSOR STOPPED · RELOAD APP" : `AUDIO ERROR · ${String(error?.message ?? error).slice(0, 160)}`, "danger");
    }
    renderTransport();
  });
  $("#stopButton").addEventListener("click", () => {
    stopPlayback();
    renderTransport();
  });

  repeatButton($("#tempoDown"), () => dispatchSemantic({
    type: "tempo.set",
    value: model.tempo - 1,
    source: "tempo-step-down",
  }));
  repeatButton($("#tempoUp"), () => dispatchSemantic({
    type: "tempo.set",
    value: model.tempo + 1,
    source: "tempo-step-up",
  }));
  $("#tempoButton").addEventListener("click", () => {
    const raw = prompt("Tempo (30–300 BPM)", String(model.tempo));
    if (raw === null || !raw.trim()) return;
    const next = Number(raw);
    if (!Number.isFinite(next)) {
      setStatus("INVALID BPM", "danger");
      return;
    }
    dispatchSemantic({ type: "tempo.set", value: next, source: "tempo-dialog" });
  });

  $("#projectName").addEventListener("click", () => {
    const next = prompt("Project name", model.projectName);
    if (next === null || !next.trim()) return;
    dispatchSemantic({ type: "project.rename", value: next, source: "project-name-dialog" });
  });

  $("#helpButton").addEventListener("click", () => $("#helpDialog").showModal());
  $("#previewButton").addEventListener("click", async () => {
    if (!await enableProductionAudio()) return;
    const project = globalThis.BRKTRKStores?.project?.getState?.();
    const instrument = project?.instrumentPool?.[state.instrument] ?? null;
    if (!instrument?.engineRef?.moduleId || !instrument?.engineRef?.engineId) {
      setStatus("AUDITION UNAVAILABLE · CREATE PRODUCTION INSTRUMENT", "amber");
      return;
    }
    if (state.playing) {
      setStatus("STOP PLAYBACK TO AUDITION", "amber");
      return;
    }
    const step = phrase(state.phrase)[state.phraseRow];
    const note = step.note >= 0 ? step.note : 48;
    const result = globalThis.BRKTRKProductionEngineBootstrap?.audition?.({
      track: state.track,
      instrumentId: state.instrument,
      note,
      velocity: step.velocity ?? 100,
      durationMs: 240,
    });
    if (!result) {
      setStatus("AUDITION UNAVAILABLE · ENGINE PACKAGE NOT READY", "amber");
      return;
    }
    setStatus(`AUDITION ${noteName(note)} · ${instrument.name ?? `INST ${hex(state.instrument)}`}`);
  });

  $("#chainPrev").addEventListener("click", () => optionNavigate("ArrowUp"));
  $("#chainNext").addEventListener("click", () => optionNavigate("ArrowDown"));
  $("#phrasePrev").addEventListener("click", () => {
    state.focus.pane = "phrase";
    optionNavigate("ArrowUp");
  });
  $("#phraseNext").addEventListener("click", () => {
    state.focus.pane = "phrase";
    optionNavigate("ArrowDown");
  });

  $("#mobileTabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button) return;
    const workspace = button.dataset.view;
    dispatchSemantic(workspace === "mix"
      ? { type: "workspace.openMix", source: "mobile-tab" }
      : { type: "workspace.select", workspace, source: "mobile-tab" });
  });

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.matches("input, textarea, select") || $("#helpDialog").open || $("#settingsDialog")?.open) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyA", "KeyS", "KeyZ", "KeyX"].includes(event.code)) {
      event.preventDefault();
      keyDown(event.code, event.repeat);
    }
  });
  document.addEventListener("keyup", (event) => keyUp(event.code));
  window.addEventListener("blur", () => heldKeys.clear());
}

// The Worklet reports actual unbounded float peaks (not a synthetic meter).
// A brief hold makes isolated over-unity transients perceptible on desktop
// and on phone, where the traditional meter bars are hidden.
let outputOverloadHold = null;
function showOutputOverload(active) {
  const warning = document.querySelector("#outputOverload");
  const meter = document.querySelector(".meter-pair");
  if (warning) warning.hidden = !active;
  if (meter) meter.dataset.outputOverload = String(active);
  document.body.dataset.outputOverload = String(active);
}
function clearOutputOverload() {
  if (outputOverloadHold !== null) clearTimeout(outputOverloadHold);
  outputOverloadHold = null;
  showOutputOverload(false);
}

// BrowserAudio emits this on the authoritative Worklet "stopped" message.
// Unlike onStep, this callback is not owned/replaced by playhead modules.
audio.onStop = clearOutputOverload;

audio.onStep = (index) => {
  if (index < 0) {
    clearOutputOverload();
    state.playing = false;
    state.playhead = locatePlayhead(-1);
    renderTransport();
    renderPlayheads();
    return;
  }
  state.playhead = locatePlayhead(index);
  renderPlayheads();
};

audio.onMeter = (left, right) => {
  const leftPeak = Number.isFinite(left) ? Math.max(0, left) : 0;
  const rightPeak = Number.isFinite(right) ? Math.max(0, right) : 0;
  $("#meterLeft").style.width = `${clamp(leftPeak * 100, 0, 100)}%`;
  $("#meterRight").style.width = `${clamp(rightPeak * 100, 0, 100)}%`;
  if (Math.max(leftPeak, rightPeak) >= 1) {
    showOutputOverload(true);
    if (outputOverloadHold !== null) clearTimeout(outputOverloadHold);
    outputOverloadHold = setTimeout(() => {
      outputOverloadHold = null;
      showOutputOverload(false);
    }, 1300);
  }
};

bindUi();
renderAll();
focusSelectedCell();

function registerServiceWorkerAfterRuntime() {
  if (!navigator.serviceWorker?.register) return;
  const registerWorker = async () => {
    try {
      const registration = await navigator.serviceWorker.register(releaseAsset("./sw.js"));
      globalThis.BRKTRKServiceWorkerUpdateHandoverDomain?.install?.(globalThis, registration);
      return registration;
    } catch (error) {
      console.warn(error);
      return null;
    }
  };
  if (document.readyState === "complete") void registerWorker();
  else window.addEventListener("load", () => { void registerWorker(); }, { once: true });
}

async function loadDynamicRuntime() {
  if (dynamicRuntimeTiming.executionStartedAtMs != null) return false;
  dynamicRuntimeTiming.executionStartedAtMs = performance.now();

  for (const href of DYNAMIC_STYLE_ASSETS) {
    if (document.querySelector(`link[data-brktrk-asset="${href}"]`)) continue;
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.dataset.brktrkAsset = href;
    style.href = releaseAsset(href);
    style.onload = null;
    document.head.append(style);
  }

  for (const src of DYNAMIC_SCRIPT_ASSETS) {
    const scriptStartedAt = performance.now();
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.dataset.brktrkAsset = src;
      script.src = releaseAsset(src);
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.body.append(script);
    });
    const durationMs = performance.now() - scriptStartedAt;
    dynamicRuntimeTiming.scriptsLoaded += 1;
    if (durationMs > dynamicRuntimeTiming.slowestScriptMs) {
      dynamicRuntimeTiming.slowestScriptMs = durationMs;
      dynamicRuntimeTiming.slowestScript = src;
    }
  }

  dynamicRuntimeTiming.readyAtMs = performance.now();
  document.body.dataset.commandArchitecture = "p3.4";
  window.dispatchEvent(new Event("brktrk-runtime-ready"));
  // Async writer acquisition can finish after window.load. Keep SW install's
  // large precache out of the editor startup fetch/execute path, as it was when
  // the parser-owned runtime finished before the old window.load registration.
  registerServiceWorkerAfterRuntime();
  return true;
}

if (globalThis.BRKTRKBrowserWriterAuthority?.runtimeReady) {
  globalThis.BRKTRKBrowserWriterAuthority.runtimeReady.then(() => loadDynamicRuntime());
} else if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => loadDynamicRuntime(), { once: true });
} else {
  queueMicrotask(() => loadDynamicRuntime());
}
