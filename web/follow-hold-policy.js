(() => {
  const base = globalThis.BRKTRKPlaybackContext;
  const transportStore = globalThis.BRKTRKStores?.transport;
  const runtime = transportStore?.runtime;
  if (!base || !transportStore?.subscribe || !runtime) {
    throw new Error("Follow hold requires P3.5 playback context and TransportStore runtime");
  }
  if (globalThis.BRKTRKFollowHoldPolicy?.installed) return;

  state.p35.followHeld = false;
  state.p35.followHoldSource = null;

  function isPlaying() {
    return runtime.isPlaying?.() === true;
  }

  function followState() {
    if (!state.p35.followPlayhead) return "off";
    return state.p35.followHeld ? "held" : "following";
  }

  function updateButton() {
    const button = document.querySelector("#p35FollowButton");
    if (!button) return;
    const mode = followState();
    button.dataset.followState = mode;
    button.setAttribute("aria-pressed", String(mode !== "off"));
    if (mode === "held") {
      button.textContent = "VIEW HOLD";
      button.title = "Manual browsing is protected. Press to resume view following.";
    } else if (mode === "following") {
      button.textContent = "VIEW FOLLOW";
      button.title = "The visible editor follows playback context until you browse manually";
    } else {
      button.textContent = "VIEW FIXED";
      button.title = "The visible editor stays where you browse while playback continues";
    }
    globalThis.BRKTRKTransport?.refreshPolicyUi?.();
    globalThis.BRKTRKTransportStateUI?.renderStatus?.();
  }

  function holdFollow(source = "manual-navigation") {
    if (!isPlaying() || !state.p35.followPlayhead || state.p35.followHeld) return false;
    state.p35.followHeld = true;
    state.p35.followHoldSource = source;
    state.p35.pauseUntil = Number.POSITIVE_INFINITY;
    updateButton();
    setStatus("VIEW HOLD · MANUAL BROWSING", "muted");
    return true;
  }

  function resumeFollow(source = "explicit-resume") {
    if (!state.p35.followPlayhead) {
      base.setFollow(true);
    }
    const changed = state.p35.followHeld === true;
    state.p35.followHeld = false;
    state.p35.followHoldSource = source;
    state.p35.pauseUntil = performance.now();
    updateButton();
    if (changed) setStatus("VIEW FOLLOW RESUMED");
    return changed;
  }

  function beginFollowSession(source = "transport-start") {
    state.p35.followHeld = false;
    state.p35.followHoldSource = source;
    if (!state.p35.editHeld) state.p35.pauseUntil = 0;
    updateButton();
  }

  function endFollowSession(source = "transport-stop") {
    state.p35.followHeld = false;
    state.p35.followHoldSource = source;
    if (!state.p35.editHeld) state.p35.pauseUntil = 0;
    updateButton();
  }

  function shouldFollow() {
    return state.p35.followPlayhead === true
      && state.p35.followHeld !== true
      && !base.isEditing();
  }

  function manualNavigationRecord(record) {
    if (!record?.ok || !isPlaying()) return false;
    const owner = record.changeSet?.owner;
    const target = String(record.changeSet?.target ?? "");
    const source = String(record.command?.source ?? record.changeSet?.source ?? "");
    if (source.startsWith("playback-") || source.startsWith("follow-")) return false;
    return owner === "navigation" || target.startsWith("navigation.");
  }

  globalThis.BRKTRKCommands?.subscribe?.((record) => {
    if (manualNavigationRecord(record)) holdFollow(record.command?.source ?? "navigation-command");
    queueMicrotask(updateButton);
  });

  const pointerBrowseSelector = [
    "[data-pane][data-row][data-col]",
    "#mobileTabs button[data-view]",
    "#chainPrev",
    "#chainNext",
    "#phrasePrev",
    "#phraseNext",
    "#p34Back",
    "#p34Open",
    "#p3ChainIdButton",
    "#p3PhraseIdButton",
  ].join(",");

  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest?.(pointerBrowseSelector)) holdFollow("pointer-navigation");
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      holdFollow("keyboard-navigation");
    }
  }, true);

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("#p35FollowButton");
    if (!button || !state.p35.followHeld) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    resumeFollow("follow-button");
  }, true);

  document.addEventListener("change", (event) => {
    if (!event.target.closest?.("#followSetting")) return;
    queueMicrotask(() => {
      if (!state.p35.followPlayhead) endFollowSession("follow-disabled");
      else updateButton();
    });
  }, true);

  transportStore.subscribe("transport", (changeSet) => {
    if (changeSet.target === "transport.program.start") beginFollowSession("transport-start");
    if (changeSet.target === "transport.program.stopped") endFollowSession("transport-stopped");
  });

  globalThis.BRKTRKPlaybackContext = Object.freeze({
    ...base,
    isEditing: () => state.p35.followHeld === true || base.isEditing(),
    shouldFollow,
    holdFollow,
    resumeFollow,
    beginFollowSession,
    endFollowSession,
    followState,
  });

  globalThis.BRKTRKFollowHoldPolicy = Object.freeze({
    installed: true,
    holdFollow,
    resumeFollow,
    beginFollowSession,
    endFollowSession,
    shouldFollow,
    followState,
    updateButton,
  });

  updateButton();
  document.body.dataset.followBrowsePolicy = "manual-hold-until-resume";
})();
