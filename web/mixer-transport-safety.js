(() => {
  const install = () => {
    const existing = globalThis.BRKTRKMixerTransportSafety;
    if (existing?.installed) {
      existing.attachTransportStore?.();
      if (!existing.isReleased?.()) existing.quarantineMixer?.();
      existing.renderScopeStatus?.();
      return true;
    }
    const renderRuntime = globalThis.BRKTRKRenderRuntime;
    if (typeof renderMixer !== "function" || typeof renderTransport !== "function"
      || !renderRuntime?.registerAfterMixer || !renderRuntime?.registerAfterTransport) return false;

    let unregisterMixerHook = null;
    let released = false;
    let quarantining = false;
    let quarantineQueued = false;
    let transportAttached = false;
    const blockedEventNames = Object.freeze(["pointerdown", "pointerup", "click", "input", "change", "keydown"]);

    function queueQuarantine() {
      if (released || quarantineQueued) return;
      quarantineQueued = true;
      queueMicrotask(() => {
        quarantineQueued = false;
        quarantineMixer();
      });
    }

    function quarantineMixer() {
      const mixer = document.querySelector("#mixer");
      if (!mixer || released || quarantining) return;
      quarantining = true;
      try {
        mixer.dataset.routingState = "quarantined";
        mixer.querySelectorAll(".channel:not(.master)").forEach((channel, track) => {
          channel.dataset.track = String(track);
          const context = channel.querySelector(".channel-header small");
          if (context) context.textContent = "ROUTING LOCKED";

          const slider = channel.querySelector('input[type="range"]');
          if (slider && slider.dataset.routingSafety !== "quarantined") {
            const safe = slider.cloneNode(true);
            safe.dataset.routingSafety = "quarantined";
            safe.value = "100";
            safe.disabled = true;
            safe.setAttribute("aria-label", `Track ${track + 1} volume unavailable until correct Track routing`);
            safe.title = "Disabled: the previous control edited an Instrument slot instead of this Track";
            slider.replaceWith(safe);
          } else if (slider) {
            slider.value = "100";
            slider.disabled = true;
          }

          const mute = channel.querySelector("button");
          if (mute && mute.dataset.routingSafety !== "quarantined") {
            const safe = mute.cloneNode(true);
            safe.dataset.routingSafety = "quarantined";
            safe.disabled = true;
            safe.setAttribute("aria-pressed", "false");
            safe.title = "Disabled until Track-owned mute routing is implemented";
            mute.replaceWith(safe);
          } else if (mute) {
            mute.disabled = true;
            mute.setAttribute("aria-pressed", "false");
          }

          const pan = channel.querySelector(".pan-readout");
          if (pan) {
            pan.textContent = "PAN —";
            pan.title = "Track pan unavailable until correct Track routing is implemented";
          }
        });

        const masterNote = mixer.querySelector(".master-note");
        if (masterNote) masterNote.textContent = "TRACK MIX SAFETY LOCK · ISSUE #81";
      } finally {
        quarantining = false;
      }
    }

    function isUnsafeMixerControl(target) {
      if (released || !(target instanceof Element)) return false;
      return Boolean(target.closest("#mixer .channel:not(.master) input, #mixer .channel:not(.master) button"));
    }

    function blockUnsafeMixerEvent(event) {
      if (!isUnsafeMixerControl(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      queueQuarantine();
      setStatus("TRACK MIX ROUTING LOCKED · ISSUE #81", "amber");
    }

    for (const eventName of blockedEventNames) {
      document.addEventListener(eventName, blockUnsafeMixerEvent, true);
    }

    const mixerObserver = new MutationObserver(() => queueQuarantine());
    function observeMixer() {
      const mixer = document.querySelector("#mixer");
      if (!mixer || released) return false;
      mixerObserver.observe(mixer, { childList: true });
      return true;
    }

    function runtimeSnapshot() {
      return globalThis.BRKTRKStores?.transport?.runtime?.snapshot?.() ?? {};
    }

    function currentAppliedScope() {
      return runtimeSnapshot().applied?.scope ?? null;
    }

    function currentRequestedScope() {
      return runtimeSnapshot().requested?.scope ?? null;
    }

    function currentQueuedScope() {
      return globalThis.BRKTRKTransport?.queueSnapshot?.().queued?.scope ?? null;
    }

    function selectedScopeLabel() {
      const selected = String(state.scope ?? "phrase").toUpperCase();
      return state.p35?.scopeLocked === false ? `AUTO→${selected}` : selected;
    }

    function renderScopeStatus() {
      const scopeSwitch = document.querySelector("#scopeSwitch");
      if (!scopeSwitch) return;
      let label = scopeSwitch.querySelector("#appliedScopeStatus");
      if (!label) {
        label = document.createElement("small");
        label.id = "appliedScopeStatus";
        label.className = "applied-scope-status";
        scopeSwitch.append(label);
      }
      const snapshot = runtimeSnapshot();
      const applied = currentAppliedScope();
      const requested = currentRequestedScope();
      const queued = currentQueuedScope();
      const tokens = [];
      if (applied) tokens.push(`RUNNING ${applied.toUpperCase()}`);
      else if (snapshot.phase === "starting" && requested) tokens.push(`STARTING ${requested.toUpperCase()}`);
      if (queued) tokens.push(`QUEUED ${queued.toUpperCase()}`);
      tokens.push(`NEXT ${selectedScopeLabel()}`);
      label.textContent = tokens.join(" · ");
      label.dataset.phase = snapshot.phase ?? "stopped";
      label.dataset.appliedScope = applied ?? "stopped";
      label.dataset.requestedScope = requested ?? "none";
      label.dataset.queuedScope = queued ?? "none";
      label.dataset.selectedScope = state.scope;
    }

    function attachTransportStore() {
      if (transportAttached) return true;
      const transportStore = globalThis.BRKTRKStores?.transport;
      if (!transportStore?.subscribe) return false;
      for (const channel of ["status", "transport"]) {
        transportStore.subscribe(channel, () => {
          queueMicrotask(renderScopeStatus);
          queueQuarantine();
        });
      }
      transportAttached = true;
      renderScopeStatus();
      queueQuarantine();
      return true;
    }

    function releaseToTrackMixer() {
      if (released) return true;
      released = true;
      quarantineQueued = false;
      mixerObserver.disconnect();
      for (const eventName of blockedEventNames) {
        document.removeEventListener(eventName, blockUnsafeMixerEvent, true);
      }
      unregisterMixerHook?.();
      unregisterMixerHook = null;
      const mixer = document.querySelector("#mixer");
      if (mixer) mixer.dataset.routingState = "track-owned-pending-render";
      document.body.dataset.mixerRoutingSafety = "released-to-track-mixer";
      document.body.dataset.mixerSafetyListeners = "removed";
      return true;
    }

    unregisterMixerHook = renderRuntime.registerAfterMixer("mixer-safety.quarantine", () => {
      if (!released) quarantineMixer();
    });
    renderRuntime.registerAfterTransport("mixer-safety.scope-status", renderScopeStatus);

    document.addEventListener("click", (event) => {
      const scope = event.target.closest?.("#scopeSwitch [data-scope], #p36MobilePolicyPanel [data-lock-scope]");
      const mode = event.target.closest?.("#p35ScopeModeButton, #p36MobileAuto");
      if (!scope && !mode) return;
      queueMicrotask(renderScopeStatus);
    });

    globalThis.BRKTRKMixerTransportSafety = Object.freeze({
      installed: true,
      quarantineMixer,
      renderScopeStatus,
      currentAppliedScope,
      currentRequestedScope,
      currentQueuedScope,
      blockUnsafeMixerEvent,
      attachTransportStore,
      releaseToTrackMixer,
      isReleased: () => released,
    });

    renderMixer();
    observeMixer();
    renderScopeStatus();
    attachTransportStore();
    document.body.dataset.mixerRoutingSafety = "quarantined-track-routing";
    document.body.dataset.mixerSafetyListeners = "active";
    return true;
  };

  if (!install()) {
    const retryInstall = () => {
      const retry = () => install() || window.setTimeout(retry, 20);
      retry();
    };
    if (document.readyState === "complete") retryInstall();
    else window.addEventListener("load", retryInstall, { once: true });
  }
})();
