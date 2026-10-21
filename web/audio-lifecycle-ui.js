(() => {
  const lifecycle = globalThis.BRKTRKAudioLifecycle;
  const readiness = globalThis.BRKTRKAudioReadiness;
  const transportStore = globalThis.BRKTRKStores?.transport;
  const projectStore = globalThis.BRKTRKStores?.project;
  const navigationStore = globalThis.BRKTRKStores?.navigation;
  const runtime = transportStore?.runtime;
  const renderRuntime = globalThis.BRKTRKRenderRuntime;
  if (!lifecycle || !readiness || !transportStore || !projectStore || !runtime || !renderRuntime?.registerAfterTransport) {
    throw new Error("Audio lifecycle UI requires lifecycle/readiness, Project/Transport stores and C3 render runtime");
  }
  if (globalThis.BRKTRKAudioLifecycleUI) return;

  const PHONE_MEDIA = "(max-width: 760px)";
  const phoneMedia = window.matchMedia(PHONE_MEDIA);
  const initialStatusText = "READY · AUDIO DISABLED";
  let lastProjectedReadinessLabel = initialStatusText;
  let lastAnnouncedFailure = null;

  // The lifecycle keeps the failure's own words (for an engine that cannot
  // register, "<engine>@<version> could not start in the AudioWorklet: ...").
  // The chip stays short; the reason belongs where a musician reads it.
  function failureReason(error) {
    const text = String(error ?? "").replace(/\s+/g, " ").replace(/^(?:Error|TypeError|RangeError):\s*/, "").trim();
    return text ? text.slice(0, 160) : null;
  }

  function describeReadiness(audioState = {}, authority = {}) {
    const status = String(audioState?.status ?? "disabled");
    const canonicalReady = authority?.canonicalReady === true;
    const workletReady = authority?.workletReady === true;
    const hasProductionInstrument = authority?.hasProductionInstrument === true;
    const terminalError = failureReason(authority?.terminalError);

    if (terminalError) {
      return Object.freeze({ state: "failure", label: "AUDIO STOPPED · RELOAD APP", tone: "danger", reason: terminalError });
    }
    if (status === "error") {
      return Object.freeze({ state: "failure", label: "AUDIO ERROR · RETRY", tone: "danger", reason: failureReason(audioState?.error) });
    }
    if (status === "initializing" || status === "resuming") {
      return Object.freeze({ state: "starting", label: "AUDIO STARTING…", tone: "amber" });
    }
    if (status === "disabled" || status === "suspended") {
      return Object.freeze({ state: "disabled", label: status === "suspended" ? "SUSPENDED · ENABLE AUDIO" : "ENABLE AUDIO", tone: "muted" });
    }
    if (status === "ready") {
      if (!canonicalReady || !workletReady) {
        return Object.freeze({ state: "starting", label: "HOST VERIFYING…", tone: "amber" });
      }
      if (!hasProductionInstrument) {
        return Object.freeze({ state: "host-ready-no-playable", label: "HOST READY · NO PLAYABLE INSTRUMENT", tone: "amber" });
      }
      return Object.freeze({ state: "playable", label: "PLAYABLE · READY", tone: "green" });
    }
    return Object.freeze({ state: "disabled", label: "ENABLE AUDIO", tone: "muted" });
  }

  function readinessAuthority() {
    const project = projectStore.getState();
    const context = navigationStore?.captureContext?.() ?? null;
    const instrumentId = Number(context?.instrument ?? 0);
    const instrument = project?.instrumentPool?.[instrumentId] ?? null;
    const hasProductionInstrument = Boolean(instrument?.engineRef?.moduleId && instrument?.engineRef?.engineId);
    let workletReady = false;
    try {
      workletReady = globalThis.BRKTRKProductionEngineBootstrap?.isWorkletReady?.(project) === true;
    } catch {
      workletReady = false;
    }
    const canonical = readiness.snapshot();
    return Object.freeze({
      canonicalReady: canonical.ready === true,
      terminalError: canonical.terminalError,
      hasProductionInstrument,
      workletReady,
    });
  }

  function currentReadiness() {
    return describeReadiness(lifecycle.snapshot(), readinessAuthority());
  }

  function ensurePhoneStatusStyle() {
    if (document.querySelector("#a5PhoneStatusTruthStyle")) return;
    const style = document.createElement("style");
    style.id = "a5PhoneStatusTruthStyle";
    style.textContent = `
      @media ${PHONE_MEDIA} {
        body { --command-h: 104px; }
        .command-bar {
          min-height: var(--command-h);
          /* The third track held the retired ASZX toggle. It now holds only the
             EDIT fallback, which touch-actions hides whenever the action strip
             installs, so size it to its content and give the phone back those
             44px instead of reserving them for an empty column. */
          grid-template-columns: minmax(0, 1fr) auto auto;
          grid-template-rows: repeat(3, minmax(14px, 1fr)) 44px;
          grid-template-areas:
            "status history edit"
            "save history edit"
            "breadcrumb history edit"
            "actions actions actions";
          column-gap: 8px;
          row-gap: 2px;
          padding: 4px 6px;
        }
        .status-line {
          display: block;
          grid-area: status;
          min-width: 0;
          align-self: center;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: pointer;
        }
        .project-save-state {
          grid-area: save;
          min-width: 0;
          max-width: 112px;
          align-self: center;
          justify-self: start;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .edit-breadcrumb {
          display: block;
          grid-area: breadcrumb;
          min-width: 0;
          width: 100%;
          max-width: 100%;
          align-self: center;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 7px;
        }
        .phone-edit-button {
          grid-area: edit;
          align-self: center;
          min-height: 44px;
          padding-inline: 9px;
        }
        .undo-redo-controls {
          grid-area: history;
          align-self: center;
        }
        .p34-touch-actions,
        .m42b-selection-actions {
          grid-area: actions;
        }
      }
    `;
    document.head.append(style);
  }

  function openHelpFromStatus(event) {
    if (!phoneMedia.matches) return;
    if (event?.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    event?.preventDefault?.();
    const dialog = document.querySelector("#helpDialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function syncPhoneStatusAffordance() {
    const status = document.querySelector("#statusLine");
    if (!status) return null;
    const enabled = phoneMedia.matches;
    status.dataset.phoneStatusAffordance = String(enabled);
    if (enabled) {
      status.setAttribute("role", "button");
      status.tabIndex = 0;
      status.setAttribute("aria-label", "Status, audio readiness and Help");
      status.title = "Status / readiness · tap for Help";
    } else {
      status.removeAttribute("role");
      status.removeAttribute("aria-label");
      status.removeAttribute("tabindex");
      status.removeAttribute("title");
    }
    return status;
  }

  function projectReadiness(status, descriptor) {
    if (!status) return;
    status.dataset.audioReadinessState = descriptor.state;
    if (descriptor.state !== "failure") lastAnnouncedFailure = null;
    // A new failure interrupts whatever the status line last said, once: it is
    // the reason the next Play will not sound. While it lasts the line is left
    // alone, and the announced text stays the last projection so that recovery
    // replaces it through the ordinary projection below.
    if (descriptor.state === "failure" && descriptor.reason) {
      if (descriptor.reason !== lastAnnouncedFailure) {
        lastAnnouncedFailure = descriptor.reason;
        lastProjectedReadinessLabel = `AUDIO ERROR · ${descriptor.reason}`;
        status.textContent = lastProjectedReadinessLabel;
        status.style.color = `var(--${descriptor.tone})`;
      }
      return;
    }
    const current = status.textContent.trim();
    if (current === initialStatusText || current === lastProjectedReadinessLabel) {
      status.textContent = descriptor.label;
      status.style.color = `var(--${descriptor.tone})`;
    }
    lastProjectedReadinessLabel = descriptor.label;
  }

  ensurePhoneStatusStyle();
  const statusAffordance = syncPhoneStatusAffordance();
  statusAffordance?.addEventListener("click", openHelpFromStatus);
  statusAffordance?.addEventListener("keydown", openHelpFromStatus);
  phoneMedia.addEventListener?.("change", () => syncPhoneStatusAffordance());

  const inheritedSetStatus = globalThis.setStatus;
  if (typeof inheritedSetStatus === "function") {
    globalThis.setStatus = function truthfulAudioStatus(message, tone = "green") {
      if (String(message) === "PRODUCTION AUDIO · READY") {
        const descriptor = currentReadiness();
        return inheritedSetStatus(descriptor.label, descriptor.tone);
      }
      return inheritedSetStatus(message, tone);
    };
  }

  function render() {
    const audioState = lifecycle.snapshot();
    const transportState = runtime.snapshot();
    const authority = readinessAuthority();
    const descriptor = describeReadiness(audioState, authority);
    const button = document.querySelector("#bootButton");
    const detail = button?.querySelector("small");
    if (detail) detail.textContent = descriptor.label;
    if (button) {
      if (authority.terminalError) button.disabled = true;
      button.setAttribute("aria-pressed", String(audioState.status === "ready" && !authority.terminalError));
      button.dataset.audioLifecycleStatus = audioState.status;
      button.dataset.audioReadinessState = descriptor.state;
      button.dataset.audioContextState = audioState.contextState;
      button.dataset.canonicalReady = String(authority.canonicalReady);
      button.dataset.workletReady = String(authority.workletReady);
      button.dataset.playableInstrument = String(authority.hasProductionInstrument);
      button.dataset.requestedVersion = String(transportState.requested?.version ?? 0);
      button.dataset.appliedVersion = String(transportState.applied?.version ?? 0);
      button.dataset.stopVersion = String(transportState.stopRequest?.version ?? 0);
      button.dataset.pageHidden = String(audioState.pageHidden);
      button.dataset.persistedRestore = String(audioState.persistedRestore);
      button.title = `${descriptor.label}${descriptor.reason ? ` — ${descriptor.reason}` : ""}; lifecycle ${audioState.status}; context ${audioState.contextState}; canonical ${authority.canonicalReady}; worklet ${authority.workletReady}; playable instrument ${authority.hasProductionInstrument}; requested ${transportState.requested?.version ?? 0}; applied ${transportState.applied?.version ?? 0}; stop ${transportState.stopRequest?.version ?? 0}`;
    }
    const status = syncPhoneStatusAffordance();
    projectReadiness(status, descriptor);
    document.body.dataset.audioLifecycleStatus = audioState.status;
    document.body.dataset.audioReadinessState = descriptor.state;
    document.body.dataset.audioContextState = audioState.contextState;
    document.body.dataset.audioVisibility = audioState.visibility;
    document.body.dataset.audioPageHidden = String(audioState.pageHidden);
    document.body.dataset.audioPersistedRestore = String(audioState.persistedRestore);
    return Object.freeze({ audioState, authority, descriptor });
  }

  renderRuntime.registerAfterTransport("audio-lifecycle.status", render);
  transportStore.subscribe("transport", (changeSet) => {
    if (changeSet.target === "transport.audioLifecycle" || changeSet.target.startsWith("transport.program") || changeSet.target === "transport.worklet.error") {
      queueMicrotask(render);
    }
  });
  projectStore.subscribe("project", (changeSet) => {
    if (String(changeSet?.target ?? "").startsWith("project.instrumentPool")) queueMicrotask(render);
  });
  navigationStore?.subscribe?.("navigation", () => queueMicrotask(render));
  render();

  globalThis.BRKTRKAudioLifecycleUI = Object.freeze({ render, describeReadiness, currentReadiness });
  document.body.dataset.audioLifecyclePresentation = "boot-status";
})();
