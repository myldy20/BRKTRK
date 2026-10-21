(() => {
  const SETTINGS_KEY = "brktrk-web-v2-settings-1";
  const defaultSettings = {
    autosave: true,
    density: "compact",
    showKeyHints: true,
    followPlayhead: true,
  };

  function restoreSettings() {
    try {
      return { ...defaultSettings, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}) };
    } catch (error) {
      console.warn("Could not restore BRKTRK settings", error);
      return { ...defaultSettings };
    }
  }

  const settings = restoreSettings();
  state.queued ??= null;
  let queuedTimer = 0;
  let queuedSequence = null;

  function persistSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function syncFollowPlayhead(value) {
    settings.followPlayhead = Boolean(value);
    persistSettings();
    const control = $("#followSetting");
    if (control && control.checked !== settings.followPlayhead) control.checked = settings.followPlayhead;
    return settings.followPlayhead;
  }

  globalThis.BRKTRKApplicationSettings = Object.freeze({
    getFollowPlayhead: () => Boolean(settings.followPlayhead),
    setFollowPlayhead: syncFollowPlayhead,
  });

  function applySettings() {
    document.body.dataset.density = settings.density;
    document.body.classList.toggle("hide-key-hints", !settings.showKeyHints);
    globalThis.BRKTRKProjectPersistence?.setLocalAutosaveEnabled?.(settings.autosave);
    persistSettings();
  }

  function injectP2Ui() {
    const topbarStatus = $(".topbar-status");
    const helpButton = $("#helpButton");
    const settingsButton = document.createElement("button");
    settingsButton.id = "settingsButton";
    settingsButton.className = "icon-button settings-button";
    settingsButton.type = "button";
    settingsButton.setAttribute("aria-label", "Application settings");
    settingsButton.title = "Settings";
    settingsButton.textContent = "⚙";
    topbarStatus.insertBefore(settingsButton, helpButton);

    const songLabel = document.createElement("span");
    songLabel.id = "songActiveLabel";
    songLabel.className = "pane-active-label";
    songLabel.textContent = "EDITING SONG";
    $("#songPane .pane-header").append(songLabel);

    const dockHeader = $(".dock-tabs-row");
    const mobileSoundTabs = document.createElement("nav");
    mobileSoundTabs.id = "mobileSoundTabs";
    mobileSoundTabs.className = "mobile-sound-tabs";
    mobileSoundTabs.setAttribute("aria-label", "Sound workspace");
    mobileSoundTabs.innerHTML = `
      <button type="button" data-dock="sound">ENGINE</button>
      <button type="button" data-dock="mod">MOD</button>
      <button type="button" data-dock="fx">FX</button>`;
    dockHeader.insertBefore(mobileSoundTabs, $("#selectionBreadcrumb"));

    const mobileDockTitle = document.createElement("strong");
    mobileDockTitle.id = "mobileDockTitle";
    mobileDockTitle.className = "mobile-dock-title";
    dockHeader.insertBefore(mobileDockTitle, $("#previewButton"));

    const stateLegend = document.createElement("div");
    stateLegend.className = "state-legend";
    stateLegend.setAttribute("aria-label", "Editor state legend");
    stateLegend.innerHTML = `
      <span class="legend-edit">EDIT</span>
      <span class="legend-link">LINK</span>
      <span class="legend-play">PLAY</span>
      <span class="legend-queue">QUEUE</span>`;
    $(".command-bar").insertBefore(stateLegend, $(".key-legend"));

    const settingsDialog = document.createElement("dialog");
    settingsDialog.id = "settingsDialog";
    settingsDialog.className = "settings-dialog";
    settingsDialog.innerHTML = `
      <form method="dialog">
        <header class="settings-header">
          <div><span class="eyebrow">APPLICATION</span><h2>SETTINGS</h2></div>
          <button class="icon-button" value="close" aria-label="Close settings">×</button>
        </header>
        <div class="settings-grid">
          <section class="settings-section">
            <h3>INTERFACE</h3>
            <label class="settings-control"><span>Density<small>Changes tracker row and dock density.</small></span>
              <select id="densitySetting"><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select>
            </label>
            <label class="settings-control"><span>Keyboard hints<small>Show the permanent keyboard legend on desktop.</small></span><input id="keyHintsSetting" type="checkbox"></label>
            <label class="settings-control"><span>Follow playhead<small>Keep the playing row visible without moving the edit cursor.</small></span><input id="followSetting" type="checkbox"></label>
          </section>
          <section class="settings-section">
            <h3>PROJECT & SAVES</h3>
            <label class="settings-control"><span>Local autosave<small>Maintain a browser-only safety copy of Project edits.</small></span><input id="autosaveSetting" type="checkbox"></label>
            <div id="storageStatus" class="storage-status"></div>
            <div class="settings-actions" aria-label="Project file actions"></div>
          </section>
          <section class="settings-section settings-about">
            <h3>AUDIO</h3>
            <p><b>ENGINE PACKAGES</b> play every Instrument. Each Instrument is pinned to one exact, verified engine package; a Project whose engine is missing says so instead of playing a substitute.</p>
          </section>
          <section class="settings-section settings-release">
            <h3>RELEASE</h3>
            <p>BRKTRK WEB <b id="settingsReleaseVersion">—</b></p>
          </section>
        </div>
      </form>`;
    // The phone top bar cannot hold the release marker beside project identity,
    // so Settings is the surface that always reports the running release.
    const releaseSlot = settingsDialog.querySelector("#settingsReleaseVersion");
    if (releaseSlot) releaseSlot.textContent = String(globalThis.BRKTRK_VERSION ?? "unknown");
    document.body.append(settingsDialog);

    settingsButton.addEventListener("click", () => {
      syncSettingsControls();
      settingsDialog.showModal();
    });

    mobileSoundTabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-dock]");
      if (!button) return;
      state.dock = button.dataset.dock;
      renderInspector();
      renderMobileView();
    });

    $("#densitySetting").addEventListener("change", (event) => {
      settings.density = event.target.value === "comfortable" ? "comfortable" : "compact";
      applySettings();
    });
    $("#keyHintsSetting").addEventListener("change", (event) => {
      settings.showKeyHints = event.target.checked;
      applySettings();
    });
    $("#followSetting").addEventListener("change", (event) => {
      const enabled = event.target.checked;
      if (globalThis.BRKTRKPlaybackContext?.setFollow) globalThis.BRKTRKPlaybackContext.setFollow(enabled);
      else syncFollowPlayhead(enabled);
    });
    $("#autosaveSetting").addEventListener("change", (event) => {
      settings.autosave = event.target.checked;
      applySettings();
      if (settings.autosave) globalThis.BRKTRKProjectPersistence?.save?.({ source: "settings-autosave-enabled" });
      updateStorageStatus();
    });
  }

  function syncSettingsControls() {
    $("#densitySetting").value = settings.density;
    $("#keyHintsSetting").checked = settings.showKeyHints;
    $("#followSetting").checked = globalThis.BRKTRKPlaybackContext
      ? Boolean(state.p35?.followPlayhead)
      : settings.followPlayhead;
    $("#autosaveSetting").checked = settings.autosave;
    globalThis.BRKTRKProjectPersistence?.setLocalAutosaveEnabled?.(settings.autosave);
    updateStorageStatus();
  }

  function updateStorageStatus() {
    const target = $("#storageStatus");
    if (!target) return;
    const bytes = new Blob([localStorage.getItem(STORAGE_KEY) ?? ""]).size;
    target.textContent = settings.autosave
      ? `LOCAL AUTOSAVE ON · BROWSER SAFETY COPY ${Math.max(1, Math.round(bytes / 1024))} KB`
      : "LOCAL AUTOSAVE OFF · PROJECT FILE SAVE AND RECOVERY REMAIN ACTIVE";
  }

  const baseRowClasses = rowClasses;
  rowClasses = function p2RowClasses(pane, row) {
    const classes = baseRowClasses(pane, row).split(" ");
    if (state.queued?.pane === pane && state.queued.row === row) classes.push("queued-row");
    return [...new Set(classes)].join(" ");
  };

  const baseRenderFocusState = renderFocusState;
  renderFocusState = function p2RenderFocusState() {
    baseRenderFocusState();
    const pane = state.focus.pane;
    const songActive = pane === "song";
    $("#songActiveLabel").classList.toggle("visible", songActive);
    $("#activeEditorLabel").textContent = songActive ? "LINKED CONTEXT" : `EDITING ${pane.toUpperCase()}`;

    const value = currentValue();
    let field = "CELL";
    let display = value < 0 ? "--" : String(value);
    if (pane === "song") {
      field = `T${state.track + 1} / CHAIN`;
      display = value < 0 ? "--" : hex(value);
    } else if (pane === "chain") {
      field = state.focus.col === 0 ? "PHRASE" : "TRANSPOSE";
      display = state.focus.col === 0 ? (value < 0 ? "--" : hex(value)) : `${value >= 0 ? "+" : ""}${value}`;
    } else {
      field = ["NOTE", "VEL", "INST", "FX1", "FX2", "FX3"][state.focus.col] ?? "CELL";
      if (state.focus.col === 0) display = noteName(value);
      else if (state.focus.col === 2) display = instrumentReferencePresentation(value, model.instrumentPool).text;
      else if (state.focus.col >= 3) display = fxName(value);
    }
    $("#editBreadcrumb").innerHTML = `EDIT · TRACK ${state.track + 1} · SONG ${hex(state.songRow)} · CHAIN ${hex(state.chain)} · PHRASE ${hex(state.phrase)} · ROW ${hex(state.focus.row)} · ${field} <b>${display}</b>`;
  };

  const baseRenderMobileView = renderMobileView;
  renderMobileView = function p2RenderMobileView() {
    baseRenderMobileView();
    const view = state.view === "pattern" ? "phrase" : state.view;
    document.body.dataset.mobileWorkspace = view;
    const patternTitle = $("#patternTitle");
    if (window.matchMedia("(max-width: 760px)").matches && ["chain", "phrase"].includes(view)) {
      patternTitle.textContent = `${view.toUpperCase()} ${hex(view === "chain" ? state.chain : state.phrase)}`;
      $("#patternContext").textContent = view === "chain"
        ? `TRACK ${state.track + 1} · SONG ${hex(state.songRow)} · CHAIN ${hex(state.chain)}`
        : `TRACK ${state.track + 1} · CHAIN ${hex(state.chain)} · PHRASE ${hex(state.phrase)}`;
    } else {
      patternTitle.textContent = "PATTERN";
      $("#patternContext").textContent = `T${state.track + 1} · C${hex(state.chain)} · P${hex(state.phrase)}`;
    }

    const mobileDockTitle = $("#mobileDockTitle");
    if (mobileDockTitle) {
      mobileDockTitle.textContent = view === "mix"
        ? `MIX · T${state.track + 1}`
        : `SOUND · INST ${hex(state.instrument)}`;
    }
    $$("#mobileSoundTabs button").forEach((button) => button.classList.toggle("active", button.dataset.dock === state.dock));
  };

  const baseStopPlayback = stopPlayback;
  stopPlayback = function p2StopPlayback() {
    window.clearTimeout(queuedTimer);
    queuedTimer = 0;
    queuedSequence = null;
    state.queued = null;
    baseStopPlayback();
    renderAll();
  };

  togglePlayback = async function p2TogglePlayback(forceSong = false) {
    await audio.init();
    if (state.playing && forceSong) {
      const sequence = buildSequence("song");
      if (!sequence.steps.length) {
        setStatus("NOTHING TO QUEUE", "amber");
        return;
      }
      queuedSequence = sequence;
      state.queued = { pane: "song", row: state.songRow };
      const stepMs = 60000 / model.tempo / 4;
      const currentPhraseRow = state.playhead.phraseRow >= 0 ? state.playhead.phraseRow : 0;
      const stepsUntilBoundary = Math.max(1, PHRASE_ROWS - currentPhraseRow);
      const waitMs = stepsUntilBoundary * stepMs;
      window.clearTimeout(queuedTimer);
      queuedTimer = window.setTimeout(() => {
        if (!queuedSequence || !state.playing) return;
        state.currentSequence = queuedSequence;
        queuedSequence = null;
        state.queued = null;
        audio.play(state.currentSequence.steps, model.tempo);
        setStatus(`PLAY SONG ${hex(state.songRow)} · QUEUE COMMITTED`);
        renderAll();
      }, waitMs);
      setStatus(`QUEUED SONG ${hex(state.songRow)} · NEXT PHRASE`, "amber");
      renderAll();
      return;
    }
    if (state.playing) {
      stopPlayback();
      return;
    }
    const scope = forceSong ? "song" : state.scope;
    const sequence = buildSequence(scope);
    if (!sequence.steps.length) {
      setStatus("NOTHING TO PLAY", "amber");
      return;
    }
    state.currentSequence = sequence;
    state.playing = true;
    state.queued = null;
    $("#playButton").setAttribute("aria-pressed", "true");
    audio.play(sequence.steps, model.tempo);
    setStatus(`PLAY ${scope.toUpperCase()}`);
  };

  const baseOnStep = audio.onStep;
  audio.onStep = (index) => {
    baseOnStep(index);
    if (index < 0 || !settings.followPlayhead) return;
    requestAnimationFrame(() => {
      const view = state.view === "pattern" ? "phrase" : state.view;
      const pane = ["song", "chain", "phrase"].includes(view) ? view : state.focus.pane;
      const row = pane === "song" ? state.playhead.songRow : pane === "chain" ? state.playhead.chainRow : state.playhead.phraseRow;
      if (row < 0) return;
      $(`[data-row-pane="${pane}"][data-row="${row}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };

  injectP2Ui();
  applySettings();
  syncSettingsControls();
  renderAll();
})();
