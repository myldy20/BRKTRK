(() => {
  const projectStore = globalThis.BRKTRKStores?.project;
  const navigationStore = globalThis.BRKTRKStores?.navigation;
  const domain = globalThis.BRKTRKTrackMix;
  const runtime = globalThis.BRKTRKTrackMixRuntime;
  const safety = globalThis.BRKTRKMixerTransportSafety;
  if (!projectStore || !navigationStore || !domain || !runtime || typeof renderMixer !== "function") {
    throw new Error("Track mixer requires ProjectStore, NavigationStore, Track mix domain/runtime and the Mixer renderer");
  }
  if (globalThis.BRKTRKTrackMixer?.installed) return;

  safety?.releaseToTrackMixer?.();

  // The output path's own latency, stated where the output is. It is a reading,
  // not a control, so it does not cross the master reserve's line: nothing here
  // changes the signal. An owner test read the tracker as running slow when the
  // tempo was exact to three parts per million and the device was adding 192 ms
  // on the way out (#496 item 7); the number was in the debug snapshot and
  // nowhere a musician could see it.
  const latencyDomain = globalThis.BRKTRKOutputLatencyDomain;
  const audioFacade = () => (typeof audio !== "undefined" ? audio : globalThis.audio);
  const audioContext = () => audioFacade()?.context ?? audioFacade()?.ctx ?? null;

  // It sits beside the channel strip rather than inside the Master placard.
  // `.mixer > .channel.master` is display:none under 760px, so a reading living
  // in the Master would be invisible on exactly the device that needs it - a
  // phone, where Bluetooth output is the norm and where the owner's 192 ms came
  // from. Here it is one element, visible at every width.
  function ensureOutputLatencyPanel() {
    const section = document.querySelector("#mixerSection");
    const mixer = document.querySelector("#mixer");
    if (!section || !mixer) return null;
    const existing = section.querySelector(".mixer-output-latency");
    if (existing) return existing;
    const panel = document.createElement("div");
    panel.className = "mixer-output-latency";
    const label = document.createElement("span");
    label.className = "mixer-output-latency-label";
    label.textContent = "OUTPUT LATENCY";
    const value = document.createElement("strong");
    value.className = "mixer-output-latency-value";
    const note = document.createElement("small");
    note.className = "mixer-output-latency-note";
    panel.append(label, value, note);
    mixer.after(panel);
    return panel;
  }

  function paintOutputLatency(panel) {
    if (!panel || !latencyDomain) return false;
    const reading = latencyDomain.outputLatencyReading(audioContext());
    panel.dataset.outputLatencyBand = reading.band;
    panel.dataset.outputLatencyMs = reading.known ? String(reading.totalMs) : "";
    panel.querySelector(".mixer-output-latency-value").textContent = latencyDomain.outputLatencyLabel(reading);
    panel.querySelector(".mixer-output-latency-note").textContent = latencyDomain.outputLatencyNote(reading);
    return true;
  }

  // Readiness is when a context exists and can report anything at all. There is
  // no event for the musician unplugging headphones mid-session, and this does
  // not poll for one: the next readiness transition or Mixer render restates it.
  function refreshOutputLatency() {
    return paintOutputLatency(ensureOutputLatencyPanel());
  }

  function replaceLegacyMixerSurface() {
    const legacy = document.querySelector("#mixer");
    if (!legacy) return null;
    const clean = legacy.cloneNode(false);
    clean.dataset.routingState = "track-owned-clean-surface";
    legacy.replaceWith(clean);
    document.body.dataset.trackMixerLegacySurface = "replaced";
    return clean;
  }

  replaceLegacyMixerSurface();

  const diagnostics = {
    actions: 0,
    lastAction: null,
    lastError: null,
    ownerChanges: 0,
    containedEvents: 0,
    panDrags: 0,
    panCenterResets: 0,
    touchFallbacks: 0,
    selectionUpdates: 0,
  };
  let inputOwner = null;
  let panDrag = null;
  let disconnectNavigationSelection = null;

  function diagnosticsSnapshot() {
    return Object.freeze({
      actions: diagnostics.actions,
      lastAction: diagnostics.lastAction ? { ...diagnostics.lastAction } : null,
      lastError: diagnostics.lastError,
      ownerChanges: diagnostics.ownerChanges,
      containedEvents: diagnostics.containedEvents,
      panDrags: diagnostics.panDrags,
      panCenterResets: diagnostics.panCenterResets,
      touchFallbacks: diagnostics.touchFallbacks,
      selectionUpdates: diagnostics.selectionUpdates,
      selectedTrack: navigationStore.captureContext().track,
      panDragActive: Boolean(panDrag),
      panDragKind: panDrag?.kind ?? null,
      ownerCurrent: inputOwner === document.querySelector("#mixer"),
      projectIdentity: projectStore.getState() === model,
    });
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function panLabel(value) {
    const amount = Math.round(Math.abs(value) * 100);
    if (amount === 0) return "C";
    return `${value < 0 ? "L" : "R"}${amount}`;
  }

  function panAngle(value) {
    return `${Math.round(clamp(value, -1, 1) * 135)}deg`;
  }

  function renderMixStatus(track = navigationStore.captureContext().track) {
    if (state.p3?.activeWorkspace !== "mix") return false;
    const normalized = clamp(Math.round(Number(track)), 0, domain.trackCount - 1);
    const mix = domain.get(normalized);
    const editor = document.querySelector("#activeEditorLabel");
    const breadcrumb = document.querySelector("#editBreadcrumb");
    if (editor) editor.textContent = "EDITING MIX";
    if (breadcrumb) {
      breadcrumb.innerHTML = `EDIT · MIX · TRACK <b>${normalized + 1}</b> · GAIN ${Math.round(mix.gain * 100)}% · PAN ${panLabel(mix.pan)} · MUTE ${mix.mute ? "ON" : "OFF"}`;
    }
    document.body.dataset.trackMixerStatusTrack = String(normalized);
    return true;
  }

  function updateTrackSelection(track = navigationStore.captureContext().track) {
    const normalized = clamp(Math.round(Number(track)), 0, domain.trackCount - 1);
    let channelCount = 0;
    document.querySelectorAll("#mixer .track-bus-channel").forEach((channel) => {
      const active = Number(channel.dataset.track) === normalized;
      channel.classList.toggle("active", active);
      channel.tabIndex = active ? 0 : -1;
      channel.setAttribute("aria-selected", String(active));
      channelCount += 1;
    });
    diagnostics.selectionUpdates += 1;
    document.body.dataset.trackMixerSelectedTrack = String(normalized);
    document.body.dataset.trackMixerSelectionUpdates = String(diagnostics.selectionUpdates);
    renderMixStatus(normalized);
    return Object.freeze({ track: normalized, channelCount });
  }

  function selectTrack(track) {
    const before = navigationStore.captureContext();
    const normalized = clamp(Math.round(Number(track)), 0, domain.trackCount - 1);
    const mutation = navigationStore.restoreContext({ ...before, track: normalized }, {
      source: "track-mixer-channel-select",
      subtype: "track.select",
      target: "navigation.track",
      path: ["track"],
      renderTargets: ["navigation.track-selection"],
    });
    updateTrackSelection(mutation.after.track);
    if (mutation.mutated) setStatus(`MIX · T${mutation.after.track + 1}`);
    return mutation;
  }

  function handleNavigationSelection(changeSet) {
    if (!changeSet?.renderTargets?.some((target) => [
      "navigation.track-selection",
      "navigation.context",
      "navigation.workspace",
    ].includes(target))) return;
    updateTrackSelection(navigationStore.captureContext().track);
  }

  function applyMix(track, patch, field, source) {
    const transportBefore = globalThis.BRKTRKStores?.transport?.runtime?.snapshot?.();
    try {
      const result = domain.set(track, patch, { field, source });
      const transportAfter = globalThis.BRKTRKStores?.transport?.runtime?.snapshot?.();
      if (transportBefore && transportAfter && transportBefore.version !== transportAfter.version) {
        throw new Error("Track mix must not allocate a structural transport version");
      }
      diagnostics.actions += result.mutated ? 1 : 0;
      diagnostics.lastAction = {
        track,
        field,
        source,
        mutated: result.mutated,
        before: { ...result.before },
        after: { ...result.after },
      };
      diagnostics.lastError = null;
      document.body.dataset.trackMixerActions = String(diagnostics.actions);
      document.body.dataset.trackMixerLastAction = `${track}:${field}:${result.mutated ? "mutated" : "unchanged"}`;
      document.body.dataset.trackMixerLastError = "";
      if (navigationStore.captureContext().track === track) renderMixStatus(track);
      return result;
    } catch (error) {
      diagnostics.lastError = error instanceof Error ? error.message : String(error);
      document.body.dataset.trackMixerLastError = diagnostics.lastError;
      throw error;
    }
  }

  function createRange(label, field, min, max, value) {
    const group = document.createElement("label");
    group.className = `track-mix-control track-${field}-control`;
    group.dataset.mixField = field;
    const title = document.createElement("span");
    title.textContent = label;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = "1";
    slider.value = String(value);
    slider.className = `track-mix-range track-${field}-range`;
    slider.setAttribute("aria-label", label);
    const output = document.createElement("output");
    group.append(title, slider, output);
    return { group, slider, output };
  }

  function createPanTrigger(track, value) {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "track-pan-trigger";
    trigger.dataset.panTrigger = String(track);
    trigger.dataset.panInteraction = "vertical-knob-double-center";
    trigger.setAttribute("role", "slider");
    trigger.setAttribute("aria-label", `Track ${track + 1} pan`);
    trigger.setAttribute("aria-valuemin", "-100");
    trigger.setAttribute("aria-valuemax", "100");
    trigger.setAttribute("aria-valuenow", String(Math.round(value * 100)));
    trigger.setAttribute("aria-valuetext", panLabel(value));
    trigger.style.setProperty("--pan-angle", panAngle(value));
    trigger.title = "Drag up/down · Double-click to center · Arrow keys";
    trigger.innerHTML = `<span class="track-pan-knob-face" aria-hidden="true"></span><output>${panLabel(value)}</output>`;
    return trigger;
  }

  function channelTrack(target) {
    const channel = target.closest?.(".track-bus-channel");
    const track = Number(channel?.dataset.track);
    return Number.isInteger(track) && track >= 0 && track < domain.trackCount ? { channel, track } : null;
  }

  function containControlEvent(event) {
    if (!event.target.closest?.("#mixer .track-bus-controls input, #mixer .track-bus-controls button")) return false;
    diagnostics.containedEvents += 1;
    document.body.dataset.trackMixerContainedEvents = String(diagnostics.containedEvents);
    event.stopImmediatePropagation?.();
    return true;
  }

  function updateMuteControl(mute, muted) {
    mute.setAttribute("aria-pressed", String(muted));
    mute.dataset.state = muted ? "on" : "off";
    mute.classList.toggle("active", muted);
    const stateLabel = mute.querySelector("small");
    if (stateLabel) stateLabel.textContent = muted ? "ON" : "OFF";
  }

  function updatePanVisuals(track, value) {
    const label = panLabel(value);
    const channel = document.querySelector(`#mixer .track-bus-channel[data-track="${track}"]`);
    const range = channel?.querySelector(".track-pan-range");
    const rangeOutput = channel?.querySelector(".track-pan-control output");
    const trigger = channel?.querySelector(".track-pan-trigger");
    const triggerOutput = trigger?.querySelector("output");
    if (range) range.value = String(Math.round(value * 100));
    if (rangeOutput) rangeOutput.textContent = label;
    if (triggerOutput) triggerOutput.textContent = label;
    if (trigger) {
      trigger.setAttribute("aria-valuenow", String(Math.round(value * 100)));
      trigger.setAttribute("aria-valuetext", label);
      trigger.style.setProperty("--pan-angle", panAngle(value));
      trigger.classList.toggle("centered", label === "C");
    }
  }

  function applyRangeEvent(event) {
    const input = event.target.closest?.("input[type=range]");
    const located = input && channelTrack(input);
    const field = input?.closest?.("[data-mix-field]")?.dataset.mixField;
    if (!located || !["gain", "pan"].includes(field)) return;
    containControlEvent(event);
    const result = applyMix(
      located.track,
      { [field]: Number(input.value) / 100 },
      field,
      `track-mixer-${field}-${event.type}`,
    );
    input.value = String(Math.round(result.after[field] * 100));
    const output = input.closest(".track-mix-control")?.querySelector("output");
    if (output) {
      output.textContent = field === "gain"
        ? `${Math.round(result.after.gain * 100)}%`
        : panLabel(result.after.pan);
    }
    if (field === "gain") {
      setStatus(`T${located.track + 1} GAIN ${Math.round(result.after.gain * 100)}% · LIVE TRACK BUS`);
    } else {
      updatePanVisuals(located.track, result.after.pan);
      setStatus(`T${located.track + 1} PAN ${panLabel(result.after.pan)} · LIVE TRACK BUS`);
    }
  }

  function toggleMuteControl(mute, source) {
    const located = channelTrack(mute);
    if (!located) return null;
    const result = applyMix(
      located.track,
      { mute: !domain.get(located.track).mute },
      "mute",
      source,
    );
    updateMuteControl(mute, result.after.mute);
    setStatus(
      `T${located.track + 1} ${result.after.mute ? "MUTED" : "UNMUTED"} · LIVE TRACK BUS`,
      result.after.mute ? "amber" : "green",
    );
    return result;
  }

  function centerPan(trigger, source = "track-mixer-pan-double-click") {
    const located = channelTrack(trigger);
    if (!located) return null;
    const result = applyMix(located.track, { pan: 0 }, "pan", source);
    diagnostics.panCenterResets += 1;
    document.body.dataset.trackMixerPanCenterResets = String(diagnostics.panCenterResets);
    updatePanVisuals(located.track, result.after.pan);
    setStatus(`T${located.track + 1} PAN C · CENTERED`);
    return result;
  }

  function beginPanDrag(event, trigger, { kind, id, clientY }) {
    if (panDrag) return false;
    const located = channelTrack(trigger);
    if (!located || !Number.isFinite(clientY)) return false;
    event.preventDefault?.();
    containControlEvent(event);
    panDrag = {
      kind,
      id,
      track: located.track,
      trigger,
      startY: clientY,
      startPan: domain.get(located.track).pan,
    };
    diagnostics.panDrags += 1;
    if (kind === "touch") diagnostics.touchFallbacks += 1;
    document.body.dataset.trackMixerPanDrags = String(diagnostics.panDrags);
    document.body.dataset.trackMixerTouchFallbacks = String(diagnostics.touchFallbacks);
    document.body.dataset.trackMixerPanDrag = `T${located.track + 1}:${kind}:vertical`;
    if (kind === "pointer") trigger.setPointerCapture?.(id);
    trigger.classList.add("adjusting");
    updatePanVisuals(located.track, panDrag.startPan);
    setStatus(`T${located.track + 1} PAN ${panLabel(panDrag.startPan)} · DRAG UP / DOWN`);
    return true;
  }

  function updateActivePanDrag(event, { kind, id, clientY }) {
    if (!panDrag || panDrag.kind !== kind || panDrag.id !== id || !Number.isFinite(clientY)) return false;
    event.preventDefault?.();
    containControlEvent(event);
    const sensitivity = event.shiftKey ? 384 : 96;
    const raw = clamp(panDrag.startPan + ((panDrag.startY - clientY) / sensitivity), -1, 1);
    const quantized = Math.abs(raw) < 0.03 ? 0 : Math.round(raw * 100) / 100;
    const result = applyMix(
      panDrag.track,
      { pan: quantized },
      "pan",
      `track-mixer-pan-${kind}-vertical-drag`,
    );
    updatePanVisuals(panDrag.track, result.after.pan);
    setStatus(`T${panDrag.track + 1} PAN ${panLabel(result.after.pan)} · DRAG UP / DOWN`);
    return true;
  }

  function finishPanDrag(event, { kind, id }) {
    if (!panDrag || panDrag.kind !== kind || panDrag.id !== id) return false;
    event.preventDefault?.();
    containControlEvent(event);
    const finished = panDrag;
    panDrag = null;
    if (kind === "pointer") finished.trigger.releasePointerCapture?.(id);
    finished.trigger.classList.remove("adjusting");
    document.body.dataset.trackMixerPanDrag = "";
    const value = domain.get(finished.track).pan;
    setStatus(`T${finished.track + 1} PAN ${panLabel(value)} · LIVE TRACK BUS`);
    return true;
  }

  function startPanDrag(event, trigger) {
    if (event.isPrimary === false) return false;
    return beginPanDrag(event, trigger, {
      kind: "pointer",
      id: event.pointerId,
      clientY: event.clientY,
    });
  }

  function movePanDrag(event) {
    return updateActivePanDrag(event, {
      kind: "pointer",
      id: event.pointerId,
      clientY: event.clientY,
    });
  }

  function endPanDrag(event) {
    return finishPanDrag(event, { kind: "pointer", id: event.pointerId });
  }

  function findTouch(event, id = null) {
    const candidates = [...(event.changedTouches ?? []), ...(event.touches ?? [])];
    return id === null ? candidates[0] : candidates.find((touch) => touch.identifier === id);
  }

  function handleMixerTouchStart(event) {
    if (panDrag) return;
    const trigger = event.target.closest?.(".track-pan-trigger");
    const touch = trigger && findTouch(event);
    if (!trigger || !touch) return;
    beginPanDrag(event, trigger, {
      kind: "touch",
      id: touch.identifier,
      clientY: touch.clientY,
    });
  }

  function handleMixerTouchMove(event) {
    if (panDrag?.kind !== "touch") return;
    const touch = findTouch(event, panDrag.id);
    if (!touch) return;
    updateActivePanDrag(event, {
      kind: "touch",
      id: touch.identifier,
      clientY: touch.clientY,
    });
  }

  function handleMixerTouchEnd(event) {
    if (panDrag?.kind !== "touch") return;
    const touch = findTouch(event, panDrag.id);
    if (!touch) return;
    finishPanDrag(event, { kind: "touch", id: touch.identifier });
  }

  function handleMixerTouchCancel(event) {
    handleMixerTouchEnd(event);
  }

  function handleMixerInput(event) {
    applyRangeEvent(event);
  }

  function handleMixerChange(event) {
    applyRangeEvent(event);
  }

  function handleMixerPointerDown(event) {
    const trigger = event.target.closest?.(".track-pan-trigger");
    if (trigger && startPanDrag(event, trigger)) return;
    containControlEvent(event);
  }

  function handleMixerPointerMove(event) {
    movePanDrag(event);
  }

  function handleMixerPointerUp(event) {
    if (endPanDrag(event)) return;
    containControlEvent(event);
  }

  function handleMixerPointerCancel(event) {
    endPanDrag(event);
  }

  function handleMixerDoubleClick(event) {
    const panTrigger = event.target.closest?.(".track-pan-trigger");
    if (!panTrigger) return;
    event.preventDefault?.();
    containControlEvent(event);
    centerPan(panTrigger);
  }

  function handleMixerKeydown(event) {
    const panTrigger = event.target.closest?.(".track-pan-trigger");
    if (panTrigger && ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.code)) {
      const located = channelTrack(panTrigger);
      if (!located) return;
      event.preventDefault();
      containControlEvent(event);
      const current = domain.get(located.track).pan;
      const step = event.shiftKey ? 0.1 : 0.01;
      const next = event.code === "Home" ? -1
        : event.code === "End" ? 1
          : clamp(current + (["ArrowRight", "ArrowUp"].includes(event.code) ? step : -step), -1, 1);
      const result = applyMix(located.track, { pan: next }, "pan", `track-mixer-pan-key-${event.code.toLowerCase()}`);
      updatePanVisuals(located.track, result.after.pan);
      setStatus(`T${located.track + 1} PAN ${panLabel(result.after.pan)} · LIVE TRACK BUS`);
      return;
    }
    const mute = event.target.closest?.(".track-mute-control");
    if (!mute || !["Space", "Enter"].includes(event.code)) return;
    event.preventDefault();
    containControlEvent(event);
    toggleMuteControl(mute, `track-mixer-mute-${event.code.toLowerCase()}`);
  }

  function handleMixerClick(event) {
    const panTrigger = event.target.closest?.(".track-pan-trigger");
    if (panTrigger) {
      containControlEvent(event);
      return;
    }
    const mute = event.target.closest?.(".track-mute-control");
    if (mute) {
      containControlEvent(event);
      toggleMuteControl(mute, "track-mixer-mute-click");
      return;
    }
    if (event.target.closest?.("input, button")) {
      containControlEvent(event);
      return;
    }
    const located = channelTrack(event.target);
    if (located) selectTrack(located.track);
  }

  function removeInputOwnerListeners(owner) {
    owner.removeEventListener("input", handleMixerInput, true);
    owner.removeEventListener("change", handleMixerChange, true);
    owner.removeEventListener("pointerdown", handleMixerPointerDown, true);
    owner.removeEventListener("pointermove", handleMixerPointerMove, true);
    owner.removeEventListener("pointerup", handleMixerPointerUp, true);
    owner.removeEventListener("pointercancel", handleMixerPointerCancel, true);
    owner.removeEventListener("touchstart", handleMixerTouchStart, true);
    owner.removeEventListener("touchmove", handleMixerTouchMove, true);
    owner.removeEventListener("touchend", handleMixerTouchEnd, true);
    owner.removeEventListener("touchcancel", handleMixerTouchCancel, true);
    owner.removeEventListener("dblclick", handleMixerDoubleClick, true);
    owner.removeEventListener("keydown", handleMixerKeydown, true);
    owner.removeEventListener("click", handleMixerClick, true);
  }

  function ensureInputOwner() {
    const current = document.querySelector("#mixer");
    if (!current) return null;
    if (inputOwner === current) return current;
    if (inputOwner) removeInputOwnerListeners(inputOwner);
    inputOwner = current;
    inputOwner.addEventListener("input", handleMixerInput, true);
    inputOwner.addEventListener("change", handleMixerChange, true);
    inputOwner.addEventListener("pointerdown", handleMixerPointerDown, true);
    inputOwner.addEventListener("pointermove", handleMixerPointerMove, true);
    inputOwner.addEventListener("pointerup", handleMixerPointerUp, true);
    inputOwner.addEventListener("pointercancel", handleMixerPointerCancel, true);
    inputOwner.addEventListener("touchstart", handleMixerTouchStart, { capture: true, passive: false });
    inputOwner.addEventListener("touchmove", handleMixerTouchMove, { capture: true, passive: false });
    inputOwner.addEventListener("touchend", handleMixerTouchEnd, { capture: true, passive: false });
    inputOwner.addEventListener("touchcancel", handleMixerTouchCancel, { capture: true, passive: false });
    inputOwner.addEventListener("dblclick", handleMixerDoubleClick, true);
    inputOwner.addEventListener("keydown", handleMixerKeydown, true);
    inputOwner.addEventListener("click", handleMixerClick, true);
    diagnostics.ownerChanges += 1;
    document.body.dataset.trackMixerInputOwner = "capture-terminal-container";
    document.body.dataset.trackMixerOwnerChanges = String(diagnostics.ownerChanges);
    return inputOwner;
  }

  function renderTrackMixer() {
    const mixer = ensureInputOwner();
    if (!mixer) return;
    mixer.replaceChildren();
    mixer.dataset.routingState = "track-owned";
    mixer.dataset.meterPolicy = "signal-meter-not-yet-implemented";
    mixer.dataset.sendPolicy = "reserved-no-fake-controls";
    panDrag = null;
    const selectedTrack = navigationStore.captureContext().track;

    for (let track = 0; track < domain.trackCount; track += 1) {
      const mix = domain.get(track);
      const channel = document.createElement("div");
      const selected = selectedTrack === track;
      channel.className = `track-bus-channel ${selected ? "active" : ""}`;
      channel.dataset.track = String(track);
      channel.tabIndex = selected ? 0 : -1;
      channel.setAttribute("aria-selected", String(selected));

      const header = document.createElement("div");
      header.className = "channel-header";
      const label = document.createElement("strong");
      label.textContent = `T${track + 1}`;
      header.append(label);
      channel.setAttribute("aria-label", `Track ${track + 1} bus`);

      const controls = document.createElement("div");
      controls.className = "channel-controls track-bus-controls";
      const gain = createRange(`Track ${track + 1} gain`, "gain", 0, 100, Math.round(mix.gain * 100));
      gain.output.textContent = `${Math.round(mix.gain * 100)}%`;

      const mute = document.createElement("button");
      mute.type = "button";
      mute.className = "track-mute-control";
      mute.setAttribute("aria-label", `Mute Track ${track + 1}`);
      mute.innerHTML = "<span>M</span><small>OFF</small>";
      updateMuteControl(mute, mix.mute);

      const pan = createRange(`Track ${track + 1} pan`, "pan", -100, 100, Math.round(mix.pan * 100));
      pan.output.textContent = panLabel(mix.pan);
      const panTrigger = createPanTrigger(track, mix.pan);
      panTrigger.classList.toggle("centered", panLabel(mix.pan) === "C");

      const extensionRack = document.createElement("div");
      extensionRack.className = "track-extension-rack";
      extensionRack.hidden = true;
      extensionRack.dataset.futureOwner = "track-sends";
      extensionRack.setAttribute("aria-hidden", "true");

      const secondaryControls = document.createElement("div");
      secondaryControls.className = "track-secondary-controls";
      secondaryControls.append(panTrigger, mute);

      controls.append(gain.group, pan.group, secondaryControls, extensionRack);
      channel.append(header, controls);
      mixer.append(channel);
    }

    const master = document.createElement("div");
    master.className = "channel master master-reserve";
    master.innerHTML = `
      <div class="master-reserve-copy">
        <strong>MASTER / OUTPUT</strong>
        <span>RESERVED FOR SIGNAL-BACKED OUTPUT, ANALYSIS AND MASTER PROCESSING</span>
        <small>NO CONTROLS UNTIL THEIR ENGINE CONTRACT EXISTS</small>
      </div>`;
    mixer.append(master);
    refreshOutputLatency();

    const mixRuntime = runtime.snapshot();
    mixer.dataset.mixRequestedRevision = String(mixRuntime.requestedRevision);
    mixer.dataset.mixAppliedRevision = String(mixRuntime.appliedRevision);
    mixer.dataset.mixPending = String(mixRuntime.pending);
  }

  renderMixer = renderTrackMixer;
  renderTrackMixer();
  disconnectNavigationSelection = navigationStore.subscribe("navigation", handleNavigationSelection);
  // A context that does not exist yet reports no latency, so the first useful
  // reading arrives with readiness rather than with this render.
  globalThis.BRKTRKAudioReadiness?.subscribe?.(() => { refreshOutputLatency(); });
  updateTrackSelection(navigationStore.captureContext().track);
  document.body.dataset.mixerRoutingSafety = "track-owned-gain-mute-pan";
  document.body.dataset.trackMixerArchitecture = "g1-1-desktop-compact-clarity";
  document.body.dataset.trackMixerPanInteraction = "vertical-knob-double-center";
  document.body.dataset.trackMixerActions = "0";
  document.body.dataset.trackMixerContainedEvents = "0";
  document.body.dataset.trackMixerPanDrags = "0";
  document.body.dataset.trackMixerPanCenterResets = "0";
  document.body.dataset.trackMixerTouchFallbacks = "0";
  document.body.dataset.trackMixerSelectionArchitecture = "g1-targeted-navigation";
  document.body.dataset.trackMixerSelectionUpdates = String(diagnostics.selectionUpdates);
  document.body.dataset.trackMixerSelectedTrack = String(navigationStore.captureContext().track);
  document.body.dataset.trackMixerPanDrag = "";
  document.body.dataset.trackMixerLastError = "";

  globalThis.BRKTRKTrackMixer = Object.freeze({
    installed: true,
    render: renderTrackMixer,
    refreshOutputLatency,
    applyMix,
    selectTrack,
    updateTrackSelection,
    handleNavigationSelection,
    disconnectNavigationSelection: () => disconnectNavigationSelection?.(),
    panLabel,
    panAngle,
    renderMixStatus,
    replaceLegacyMixerSurface,
    containControlEvent,
    updateMuteControl,
    updatePanVisuals,
    applyRangeEvent,
    toggleMuteControl,
    centerPan,
    beginPanDrag,
    updateActivePanDrag,
    finishPanDrag,
    startPanDrag,
    movePanDrag,
    endPanDrag,
    findTouch,
    handleMixerTouchStart,
    handleMixerTouchMove,
    handleMixerTouchEnd,
    handleMixerTouchCancel,
    handleMixerInput,
    handleMixerChange,
    handleMixerPointerDown,
    handleMixerPointerMove,
    handleMixerPointerUp,
    handleMixerPointerCancel,
    handleMixerDoubleClick,
    handleMixerKeydown,
    handleMixerClick,
    ensureInputOwner,
    snapshot: diagnosticsSnapshot,
  });
})();