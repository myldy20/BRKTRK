(() => {
  "use strict";

  let presetDomainPromise = null;
  let userPresetDomainPromise = null;
  let livePolicyPromise = null;

  function transportPlaying() {
    return globalThis.BRKTRKStores?.transport?.runtime?.snapshot?.()?.playing === true;
  }

  async function ensurePresetMutationDomain() {
    const store = globalThis.BRKTRKStores?.project;
    if (!store) throw new Error("ProjectStore is unavailable");
    if (store.instrumentPresets) return store.instrumentPresets;
    if (!presetDomainPromise) {
      presetDomainPromise = import("./project-instrument-preset.js").then(() => {
        const api = globalThis.BRKTRKProjectInstrumentPreset;
        if (!api?.install) throw new Error("Production Instrument preset mutation domain did not register");
        return api.install(store);
      }).catch((error) => {
        presetDomainPromise = null;
        throw error;
      });
    }
    return presetDomainPromise;
  }

  async function ensureUserPresetDomain() {
    const store = globalThis.BRKTRKStores?.project;
    if (!store) throw new Error("ProjectStore is unavailable");
    if (store.userPresets) return store.userPresets;
    if (!userPresetDomainPromise) {
      userPresetDomainPromise = import("./project-user-preset.js").then(() => {
        const api = globalThis.BRKTRKProjectUserPreset;
        if (!api?.install) throw new Error("Project user preset domain did not register");
        return api.install(store);
      }).catch((error) => {
        userPresetDomainPromise = null;
        throw error;
      });
    }
    return userPresetDomainPromise;
  }

  async function ensureLivePreparedPolicy() {
    if (globalThis.BRKTRKSoundPresetLivePreparedPolicy) return globalThis.BRKTRKSoundPresetLivePreparedPolicy;
    if (!livePolicyPromise) {
      livePolicyPromise = import("./sound-preset-live-prepared-policy.js").then(() => {
        const api = globalThis.BRKTRKSoundPresetLivePreparedPolicy;
        if (!api?.context) throw new Error("Live prepared preset policy did not register");
        return api;
      }).catch((error) => {
        livePolicyPromise = null;
        throw error;
      });
    }
    return livePolicyPromise;
  }

  function packageIdentity(view) {
    return Object.freeze({
      moduleId: view?.entry?.moduleId ?? null,
      engineId: view?.entry?.engineId ?? null,
      version: view?.entry?.version ?? null,
      packageSha256: view?.entry?.packageSha256 ?? null,
    });
  }

  function provenancePresetId(instrument, view) {
    const ref = instrument?.presetRef;
    if (!ref?.id) return null;
    const identity = packageIdentity(view);
    if (ref.moduleId && ref.moduleId !== identity.moduleId) return null;
    if (ref.engineId && ref.engineId !== identity.engineId) return null;
    if (ref.version && ref.version !== identity.version) return null;
    if (ref.packageSha256 && String(ref.packageSha256).toLowerCase() !== String(identity.packageSha256 ?? "").toLowerCase()) return null;
    return String(ref.id);
  }

  function currentPresetId(instrument, view) {
    return provenancePresetId(instrument, view);
  }

  function presetMatchesRef(preset, ref) {
    if (!preset?.id || !ref?.id || String(preset.id) !== String(ref.id)) return false;
    if (ref.origin != null && preset.origin != null && String(ref.origin) !== String(preset.origin)) return false;
    if (ref.bank != null && preset.bank != null && String(ref.bank) !== String(preset.bank)) return false;
    if (typeof ref.readOnly === "boolean" && typeof preset.readOnly === "boolean" && ref.readOnly !== preset.readOnly) return false;
    return true;
  }

  // Categories a musician is likely to want before they have invented their
  // own. They are suggestions in the save form, never a closed list, and never
  // written to a preset that does not choose one.
  const CATEGORY_SUGGESTIONS = Object.freeze(["Bass", "Kick", "Snare", "Hat", "Perc", "Lead", "Pad", "Chord", "FX"]);

  function selectorGroupLabel(row) {
    const bank = String(row?.preset?.bank || "Factory");
    // A category subdivides its own bank. optgroups cannot nest, so the label
    // carries the path rather than pretending to a depth HTML does not have.
    const category = row?.projectUserOwned === true ? String(row?.preset?.category ?? "").trim() : "";
    return category ? `${bank} · ${category}` : bank;
  }

  // Banks in the order the library declares them, each keeping its own order.
  // A preset that names no bank belongs to Factory, which is what the flat
  // label already said.
  function presetSelectorGroups(selectorRows = []) {
    const order = [];
    const byBank = new Map();
    for (const row of selectorRows) {
      const label = selectorGroupLabel(row);
      if (!byBank.has(label)) {
        byBank.set(label, []);
        order.push(label);
      }
      byBank.get(label).push(row);
    }
    return Object.freeze(order.map((label) => Object.freeze({ label, rows: Object.freeze(byBank.get(label)) })));
  }

  // Every mounted preset panel, with the panel-local rebuild that keeps the
  // verified Instrument shell and its native controls in place. A user-preset
  // library edit published from anywhere - this panel, another one, undo/redo,
  // a project load - redraws them where they stand.
  const mountedPresetPanels = new Map();

  // HARD-03 (#376). A panel detached by whoever owns the inspector - the
  // Instrument renderer calls replaceChildren - had no way to learn it was
  // gone. It kept a ProjectStore and a TransportStore subscription until some
  // later, unrelated event happened to fire and the listener noticed its own
  // node was disconnected. Measured before the fix: thirteen render cycles with
  // the transport idle took the render listeners from 4 to 16 and 2 to 14, one
  // of each per detached panel, released by nothing.
  function disposeDetachedPanels() {
    let disposed = 0;
    for (const [panel, entry] of [...mountedPresetPanels]) {
      if (panel?.isConnected) continue;
      // dispose() removes its own registry entry; deleting without it is what
      // left the subscriptions behind while the map looked clean.
      entry?.dispose?.();
      mountedPresetPanels.delete(panel);
      disposed += 1;
    }
    return disposed;
  }

  function refreshMountedPresetPanels() {
    let refreshed = 0;
    disposeDetachedPanels();
    for (const [panel, entry] of [...mountedPresetPanels]) {
      if (entry?.redraw?.()) refreshed += 1;
    }
    return refreshed;
  }

  function mountedPanelCount() {
    return mountedPresetPanels.size;
  }

  const detachWatchers = new WeakMap();

  // The panel does not sit directly in the inspector: renderVerifiedInstrument
  // puts it inside `.a4a-sound-shell`, and renderProductionSurface detaches it
  // by calling inspector.replaceChildren(...) - which mutates the INSPECTOR's
  // child list, not the shell's. An observer on the panel's immediate parent
  // therefore never fires for the production detach path. A panel is detached
  // when any link in its ancestor chain is cut, so every link is watched;
  // childList only, no subtree, so this stays cheap on a surface that redraws
  // parameter controls constantly.
  function watchForDetach(panel, dispose) {
    if (!panel?.parentNode || typeof MutationObserver !== "function") return null;
    const release = () => {
      stopWatchingForDetach(panel);
      dispose();
      mountedPresetPanels.delete(panel);
    };
    const observer = new MutationObserver(() => {
      if (panel.isConnected) return;
      release();
    });
    let node = panel.parentNode;
    let links = 0;
    while (node && links < 12) {
      observer.observe(node, { childList: true });
      links += 1;
      if (node === document.body || node === document.documentElement) break;
      node = node.parentNode;
    }
    if (!links) return null;
    detachWatchers.set(panel, observer);
    return observer;
  }

  function stopWatchingForDetach(panel) {
    const observer = detachWatchers.get(panel);
    if (!observer) return false;
    observer.disconnect();
    detachWatchers.delete(panel);
    return true;
  }

  function renderPresetPanel({ slot, instrument, view, rerender } = {}) {
    const store = globalThis.BRKTRKStores?.project;
    const factoryPresets = Array.isArray(view?.presets?.presets) ? view.presets.presets : [];
    const current = store?.getState?.()?.instrumentPool?.[Number(slot)] ?? instrument;
    const userPresets = store?.userPresets?.libraryFor?.(current?.engineRef)?.presets ?? [];
    const library = Object.freeze({ presets: Object.freeze([...factoryPresets, ...userPresets]) });
    const idCounts = new Map();
    for (const preset of library.presets) {
      const id = String(preset?.id ?? "");
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    const selectorValue = (preset, index = 0) => {
      const id = String(preset?.id ?? "");
      if ((idCounts.get(id) ?? 0) <= 1) return id;
      const source = String(preset?.origin ?? preset?.bank ?? "preset").replace(/[^A-Za-z0-9_-]+/g, "_");
      return `${source}:${id}:${index}`;
    };
    const selectorRows = Object.freeze([
      ...factoryPresets.map((preset, index) => Object.freeze({
        preset,
        value: selectorValue(preset, index),
        projectUserOwned: false,
      })),
      ...userPresets.map((preset, index) => Object.freeze({
        preset,
        value: selectorValue(preset, factoryPresets.length + index),
        projectUserOwned: true,
      })),
    ]);
    const bankGroups = presetSelectorGroups(selectorRows);
    const panel = document.createElement("section");
    panel.className = "a4b-preset-panel";
    panel.dataset.presetCount = String(library.presets.length);
    panel.dataset.factoryPresetCount = String(factoryPresets.length);
    panel.dataset.userPresetCount = String(userPresets.length);
    panel.dataset.presetBankCount = String(bankGroups.length);

    const heading = document.createElement("div");
    heading.className = "a4b-preset-heading";
    const title = document.createElement("strong");
    title.textContent = "PRESET";
    const state = document.createElement("small");
    state.className = "a4b-preset-state";
    state.setAttribute("role", "status");
    state.setAttribute("aria-live", "polite");
    heading.append(title, state);

    const row = document.createElement("div");
    row.className = "a4b-preset-row";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Production Instrument preset");
    select.dataset.presetLoadAction = "true";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    // A MODEL selector changes the engine synthesis model; it is not a bank
    // of factory patches. Engines with no shipped presets still offer SAVE.
    placeholder.textContent = library.presets.length ? "SELECT PRESET…" : "NO PRESETS · USE SAVE";
    if (!library.presets.length) select.title = "This engine ships no factory presets. MODEL is a sound parameter, not a preset. Use SAVE to store the current sound.";
    select.append(placeholder);
    // The bank was repeated into every row's text, so a library of any size read
    // as one flat list with the same word down its left edge. It is the group's
    // label now, and the row is the preset.
    const optionsByValue = new Map();
    for (const group of bankGroups) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const row of group.rows) {
        const option = document.createElement("option");
        option.value = row.value;
        const baseText = `${row.preset.name}${row.preset.applicable ? "" : " · unavailable"}`;
        option.textContent = baseText;
        optionsByValue.set(row.value, { option, baseText });
        optgroup.append(option);
      }
      select.append(optgroup);
    }

    // The selector is where a musician looks to see which sound is loaded, so
    // it is also where it has to say the sound is no longer that preset. The
    // asterisk survives a collapsed select, which a colour alone does not on
    // every platform, so both are used.
    const markSelectorModified = (modified) => {
      select.dataset.presetModified = String(modified === true);
      for (const [value, entry] of optionsByValue) {
        const text = modified === true && value === select.value ? `${entry.baseText} *` : entry.baseText;
        if (entry.option.textContent !== text) entry.option.textContent = text;
      }
    };
    const initialRef = instrument?.presetRef ?? null;
    const initialRow = selectorRows.find((row) => presetMatchesRef(row.preset, initialRef)) ?? null;
    select.value = initialRow?.value ?? "";

    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "RESET";
    reset.dataset.presetLoadAction = "true";
    reset.hidden = true;

    const blocked = document.createElement("small");
    blocked.className = "a4b-preset-blocked";
    blocked.hidden = true;

    const selectedPresetRow = () => selectorRows.find((row) => row.value === select.value) ?? null;
    const selectedPreset = () => selectedPresetRow()?.preset ?? null;
    const currentInstrument = () => globalThis.BRKTRKStores?.project?.getState?.()?.instrumentPool?.[Number(slot)] ?? instrument;
    const loadedPresetId = () => provenancePresetId(currentInstrument(), view);

    const manageRow = document.createElement("div");
    manageRow.className = "a4b-preset-manage-row";
    manageRow.hidden = true;
    const manageName = document.createElement("input");
    manageName.type = "text";
    manageName.maxLength = 64;
    manageName.placeholder = "User preset name";
    manageName.setAttribute("aria-label", "Selected user preset name");
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.textContent = "RENAME";
    renameButton.dataset.presetLibraryAction = "rename";
    const overwriteButton = document.createElement("button");
    overwriteButton.type = "button";
    overwriteButton.textContent = "UPDATE SOUND";
    overwriteButton.dataset.presetLibraryAction = "overwrite";
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "DELETE";
    deleteButton.dataset.presetLibraryAction = "delete";
    manageRow.append(manageName, renameButton, overwriteButton, deleteButton);

    let managedSelectorValue = null;
    let deleteArmedFor = null;
    const managedUserPreset = () => {
      const row = selectedPresetRow();
      return row?.projectUserOwned === true ? row.preset : null;
    };
    // The preset that keeping the name would replace: the selected row, when it
    // is this project's own, still loadable by this exact package, and the
    // sound currently loaded. Anything else is a new preset, not a
    // replacement - a factory row included, since it is read-only.
    const overwriteTarget = () => {
      const managed = managedUserPreset();
      if (!managed || managed.applicable !== true) return null;
      return presetMatchesRef(managed, currentInstrument()?.presetRef) ? managed : null;
    };
    const projectUserOwnedPreset = (preset) => selectorRows.some(
      (row) => row.projectUserOwned === true && row.preset === preset,
    );
    const loadedPresetRow = () => {
      const ref = currentInstrument()?.presetRef ?? null;
      return selectorRows.find((row) => presetMatchesRef(row.preset, ref)) ?? null;
    };
    const revertSelection = () => {
      select.value = loadedPresetRow()?.value ?? "";
    };

    const legacyPresentation = (preset, selected, playing) => {
      if (!preset?.applicable) {
        const reason = preset?.unavailableReason === "parameter-snapshot-incomplete"
          ? `PACKAGE PRESET METADATA INCOMPLETE · ${preset.missingParameters?.length ?? 0} PARAMS MISSING`
          : "PACKAGE PRESET METADATA DOES NOT INCLUDE HOST PARAMETER SNAPSHOT";
        return Object.freeze({ disabled: true, text: reason, error: false });
      }
      if (selected === preset.id) {
        return Object.freeze({ disabled: playing, text: "CHECKING FACTORY STATE…", error: false });
      }
      if (playing) return Object.freeze({ disabled: true, text: "STOP PLAYBACK TO APPLY PRESET", error: false });
      return Object.freeze({ disabled: false, text: preset.readOnly ? "READ-ONLY FACTORY PRESET" : "PRESET READY", error: false });
    };

    let applying = false;
    let pendingPreset = null;
    let saveButton = null;
    let disconnectTransport = null;
    let disconnectProject = null;

    const refresh = (attempted = null) => {
      const preset = attempted ?? pendingPreset ?? selectedPreset();
      const playing = transportPlaying();
      const selected = preset && presetMatchesRef(preset, currentInstrument()?.presetRef) ? String(preset.id) : null;
      const policy = globalThis.BRKTRKSoundPresetLivePreparedPolicy;
      const presentation = !preset
        ? Object.freeze({ disabled: true, text: library.presets.length ? "SELECT PRESET" : "NO FACTORY PRESETS · USE SAVE", error: false, live: false })
        : policy?.context
          ? policy.context({ slot, instrument: currentInstrument(), preset, view, selectedPresetId: selected, playing }).presentation
          : legacyPresentation(preset, selected, playing);
      const modifiedCurrent = selected === preset?.id && String(presentation.text ?? "").startsWith("MODIFIED");
      select.disabled = applying || library.presets.length === 0;
      markSelectorModified(modifiedCurrent);
      reset.hidden = !modifiedCurrent;
      reset.disabled = applying || presentation.disabled === true;
      // saveButton is assigned when the save controls are built, which is after
      // the first refresh of a freshly constructed panel. It gates the whole
      // group rather than each control repeating the same check.
      if (saveButton) {
        saveButton.disabled = applying || pendingPreset !== null;
        saveButton.title = pendingPreset ? "Stop playback to apply the pending preset before saving" : "";
        confirmSave.disabled = applying || pendingPreset !== null;
        cancelSave.disabled = applying;
        saveCategory.disabled = applying;
        saveName.disabled = applying;
      }

      const managed = managedUserPreset();
      const managedValue = managed ? select.value : null;
      manageRow.hidden = !managed;
      if (managedValue !== managedSelectorValue) {
        managedSelectorValue = managedValue;
        manageName.value = managed?.name ?? "";
        deleteArmedFor = null;
        deleteButton.textContent = "DELETE";
      }
      const managedLoaded = Boolean(
        managed?.applicable === true && presetMatchesRef(managed, currentInstrument()?.presetRef),
      );
      renameButton.disabled = applying || pendingPreset !== null || !managed;
      deleteButton.disabled = applying || pendingPreset !== null || !managed;
      overwriteButton.disabled = applying || pendingPreset !== null || !managed || !managedLoaded;
      overwriteButton.title = managed && !managedLoaded ? "Load this User preset before updating its sound" : "";

      state.textContent = presentation.text;
      state.classList.toggle("a4a-error", presentation.error === true);
      const blockedCode = presentation.blockedCode ?? null;
      const blockedReason = presentation.blockedReason ? String(presentation.blockedReason) : "";
      blocked.hidden = !blockedCode;
      // Show the musician words, not the machine code. The code was the
      // visible text with the human reason hidden in a title tooltip, which a
      // phone has no way to reveal - so a phone user saw only
      // STRUCTURAL-RECONCILIATION-PENDING and no explanation. The code stays
      // on the panel dataset for diagnostics and tests.
      blocked.textContent = blockedCode ? (blockedReason || String(blockedCode).toUpperCase()) : "";
      blocked.title = blockedReason;
      panel.dataset.presetBlockedCode = blockedCode ?? "";
      panel.dataset.presetBlockedReason = blockedReason;
      panel.dataset.presetLoadedId = loadedPresetId() ?? "";
      panel.dataset.presetLoadedSelectorValue = loadedPresetRow()?.value ?? "";
      panel.dataset.presetLoadable = String(presentation.disabled !== true);
      panel.dataset.livePrepared = String(Boolean(policy?.context && playing));
      panel.dataset.factoryTruth = presentation.text === "CURRENT FACTORY PRESET"
        ? "current"
        : String(presentation.text ?? "").startsWith("MODIFIED")
          ? "modified"
          : "other";
      return presentation;
    };

    const disconnectAll = () => {
      disconnectTransport?.();
      disconnectTransport = null;
      disconnectProject?.();
      disconnectProject = null;
      stopWatchingForDetach(panel);
      mountedPresetPanels.delete(panel);
    };

    let libraryMutationInFlight = false;
    const withLibraryMutation = async (work) => {
      libraryMutationInFlight = true;
      try {
        return await work();
      } finally {
        libraryMutationInFlight = false;
      }
    };

    const rerenderPanelOnly = () => {
      // Library-only changes must not remount the verified Instrument shell or
      // its native controls. They replace just this preset panel and transfer
      // subscriptions to the replacement.
      if (!panel.isConnected) {
        disconnectAll();
        return false;
      }
      if (typeof panel.replaceWith !== "function") {
        disconnectAll();
        if (typeof rerender === "function") rerender();
        else refresh();
        return false;
      }
      const next = renderPresetPanel({
        slot,
        instrument: currentInstrument(),
        view,
        rerender,
      });
      disconnectAll();
      panel.replaceWith(next);
      return true;
    };

    const refuse = (attempted) => {
      pendingPreset = null;
      revertSelection();
      refresh(attempted);
      return false;
    };

    const applyPreset = async (preset, source) => {
      if (applying) return false;
      if (!preset?.applicable) {
        // An incompatible User preset cannot be loaded, but it must remain
        // manageable after a manual engine/package update. Keep it selected so
        // the musician can rename or delete the stale library entry; factory
        // package failures still revert to the actually loaded preset.
        if (projectUserOwnedPreset(preset)) {
          pendingPreset = null;
          refresh(preset);
          return false;
        }
        return refuse(preset);
      }

      const playing = transportPlaying();
      if (playing) {
        let policy = globalThis.BRKTRKSoundPresetLivePreparedPolicy;
        if (!policy?.context) {
          try { policy = await ensureLivePreparedPolicy(); }
          catch (error) {
            console.warn("Live prepared preset policy unavailable", error);
            return refuse(preset);
          }
        }
        const live = policy.context({
          slot,
          instrument: currentInstrument(),
          preset,
          view,
          selectedPresetId: loadedPresetId(),
          playing: true,
        });
        if (!live?.availability?.eligible) {
          pendingPreset = preset;
          select.value = selectorRows.find((row) => row.preset === preset)?.value ?? "";
          refresh(preset);
          return false;
        }
      }

      applying = true;
      select.disabled = true;
      reset.disabled = true;
      state.classList.remove("a4a-error");
      state.textContent = playing ? "REQUESTING LIVE PRESET…" : "APPLYING PRESET…";
      try {
        const domain = await ensurePresetMutationDomain();
        domain.apply(slot, preset, { source });
        pendingPreset = null;
        applying = false;
        disconnectAll();
        if (typeof rerender === "function") rerender();
        else refresh();
        return true;
      } catch (error) {
        pendingPreset = null;
        applying = false;
        console.error(error);
        state.textContent = `PRESET FAILED · ${String(error?.message ?? error)}`;
        state.classList.add("a4a-error");
        revertSelection();
        select.disabled = false;
        reset.disabled = false;
        return false;
      }
    };

    select.addEventListener("change", () => {
      pendingPreset = null;
      void applyPreset(selectedPreset(), "a4b1-sound-preset-select");
    });
    reset.addEventListener("click", () => {
      pendingPreset = null;
      void applyPreset(selectedPreset(), "a4b1-sound-preset-reset");
    });

    refresh();
    ensureLivePreparedPolicy().then(() => refresh()).catch((error) => {
      console.warn("Live prepared preset policy unavailable", error);
      refresh();
    });

    const refreshConnected = () => {
      if (!panel.isConnected) {
        disconnectAll();
        return;
      }
      if (pendingPreset && !transportPlaying() && !applying) {
        void applyPreset(pendingPreset, "a4b1-sound-preset-after-stop");
        return;
      }
      refresh();
    };
    if (globalThis.BRKTRKStores?.transport?.subscribe) {
      disconnectTransport = globalThis.BRKTRKStores.transport.subscribe("render", refreshConnected);
    }
    if (globalThis.BRKTRKStores?.project?.subscribe) {
      disconnectProject = globalThis.BRKTRKStores.project.subscribe("render", refreshConnected);
    }

    // SAVE belongs with the thing it saves, so it sits in the selector row. The
    // name field was a permanent second row a musician had to look at and step
    // over even when they were only browsing; it appears now when SAVE is
    // pressed, already carrying the selected preset's name.
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "SAVE";
    save.dataset.presetLibraryAction = "save";
    saveButton = save;
    save.disabled = applying || pendingPreset !== null;
    save.title = pendingPreset ? "Stop playback to apply the pending preset before saving" : "";

    const saveRow = document.createElement("div");
    saveRow.className = "a4b-preset-save-row";
    saveRow.hidden = true;
    const saveName = document.createElement("input");
    saveName.type = "text";
    saveName.maxLength = 64;
    saveName.placeholder = "Preset name";
    saveName.setAttribute("aria-label", "User preset name");
    const saveCategory = document.createElement("select");
    saveCategory.setAttribute("aria-label", "User preset category");
    saveCategory.dataset.presetLibraryAction = "category";
    const noCategory = document.createElement("option");
    noCategory.value = "";
    noCategory.textContent = "No category";
    saveCategory.append(noCategory);
    // Suggestions first, then whatever this project's own library already uses,
    // so a musician's own filing keeps working without being pre-declared here.
    const offeredCategories = [...CATEGORY_SUGGESTIONS];
    for (const preset of userPresets) {
      const category = String(preset?.category ?? "").trim();
      if (category && !offeredCategories.includes(category)) offeredCategories.push(category);
    }
    for (const category of offeredCategories) {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      saveCategory.append(option);
    }
    const confirmSave = document.createElement("button");
    confirmSave.type = "button";
    confirmSave.textContent = "SAVE";
    confirmSave.dataset.presetLibraryAction = "save-confirm";
    const cancelSave = document.createElement("button");
    cancelSave.type = "button";
    cancelSave.textContent = "CANCEL";
    cancelSave.dataset.presetLibraryAction = "save-cancel";
    saveRow.append(saveName, saveCategory, confirmSave, cancelSave);

    const closeSaveForm = () => {
      saveRow.hidden = true;
      refresh();
    };

    save.addEventListener("click", () => {
      if (applying || pendingPreset) return;
      if (!saveRow.hidden) {
        closeSaveForm();
        return;
      }
      // Prefilled with what is selected: keep the name to replace that sound,
      // change it to keep both. Nothing is written until SAVE is confirmed.
      const preset = selectedPreset();
      saveName.value = preset?.name ?? "";
      saveCategory.value = String(preset?.category ?? "");
      saveRow.hidden = false;
      state.classList.remove("a4a-error");
      state.textContent = overwriteTarget()
        ? `KEEP THE NAME TO REPLACE · ${preset.name}`
        : "NAME THIS SOUND";
      saveName.focus?.();
      saveName.select?.();
    });

    cancelSave.addEventListener("click", () => {
      if (applying) return;
      closeSaveForm();
    });

    confirmSave.addEventListener("click", async () => {
      if (applying || pendingPreset) return;
      const requestedName = String(saveName.value ?? "").trim();
      const category = String(saveCategory.value ?? "");
      const target = overwriteTarget();
      const replacing = Boolean(target) && requestedName === String(target.name);
      // A factory preset is read-only, so keeping its name cannot overwrite it.
      // The sound is filed under that name in the musician's own bank instead,
      // and the status says so rather than implying the factory row changed.
      const shadowingFactory = !replacing
        && Boolean(selectedPreset())
        && requestedName === String(selectedPreset().name);
      confirmSave.disabled = true;
      state.classList.remove("a4a-error");
      state.textContent = replacing ? "REPLACING PRESET SOUND…" : "SAVING PRESET…";
      try {
        const domain = await ensureUserPresetDomain();
        const result = await withLibraryMutation(() => (replacing
          ? domain.overwrite(target.id, slot, { category, source: "sound-preset-save-replace" })
          : domain.save(slot, { name: requestedName, category, source: "sound-preset-save" })));
        saveRow.hidden = true;
        finishLibraryMutation(replacing
          ? `REPLACED · ${result.value.name}`
          : shadowingFactory
            ? `SAVED AS USER COPY · ${result.value.name}`
            : `SAVED · ${result.value.name}`);
      } catch (error) {
        failLibraryMutation(replacing ? "REPLACE" : "SAVE", error);
        confirmSave.disabled = false;
      }
    });

    const finishLibraryMutation = (message) => {
      state.textContent = message;
      rerenderPanelOnly();
    };
    const failLibraryMutation = (label, error) => {
      console.error(error);
      // Refresh first so controls are re-enabled, then preserve the operation
      // failure as the visible status instead of immediately overwriting it with
      // the ordinary preset presentation.
      refresh();
      state.textContent = `${label} FAILED · ${String(error?.message ?? error)}`;
      state.classList.add("a4a-error");
    };

    renameButton.addEventListener("click", async () => {
      const preset = managedUserPreset();
      if (!preset || applying || pendingPreset) return;
      renameButton.disabled = true;
      state.classList.remove("a4a-error");
      state.textContent = "RENAMING USER PRESET…";
      try {
        const domain = await ensureUserPresetDomain();
        const result = await withLibraryMutation(() => domain.rename(preset.id, manageName.value, { source: "sound-preset-rename" }));
        finishLibraryMutation(result.mutated ? `RENAMED · ${result.value.name}` : `UNCHANGED · ${result.value.name}`);
      } catch (error) {
        failLibraryMutation("RENAME", error);
      }
    });

    overwriteButton.addEventListener("click", async () => {
      const preset = managedUserPreset();
      if (!preset || applying || pendingPreset || !presetMatchesRef(preset, currentInstrument()?.presetRef)) return;
      overwriteButton.disabled = true;
      state.classList.remove("a4a-error");
      state.textContent = "UPDATING USER PRESET…";
      try {
        const domain = await ensureUserPresetDomain();
        const result = await withLibraryMutation(() => domain.overwrite(preset.id, slot, { source: "sound-preset-overwrite" }));
        finishLibraryMutation(`UPDATED · ${result.value.name}`);
      } catch (error) {
        failLibraryMutation("UPDATE", error);
      }
    });

    deleteButton.addEventListener("click", async () => {
      const preset = managedUserPreset();
      if (!preset || applying || pendingPreset) return;
      if (deleteArmedFor !== preset.id) {
        deleteArmedFor = preset.id;
        deleteButton.textContent = "CONFIRM DELETE";
        state.textContent = `DELETE ${preset.name}? SOUND STAYS LOADED`;
        return;
      }
      deleteButton.disabled = true;
      state.classList.remove("a4a-error");
      state.textContent = "DELETING USER PRESET…";
      try {
        const domain = await ensureUserPresetDomain();
        const result = await withLibraryMutation(() => domain.remove(preset.id, { source: "sound-preset-delete" }));
        deleteArmedFor = null;
        finishLibraryMutation(`DELETED · ${result.value.name}`);
      } catch (error) {
        deleteArmedFor = null;
        deleteButton.textContent = "DELETE";
        failLibraryMutation("DELETE", error);
      }
    });

    // Existing projects may already contain user presets before this module has
    // ever been needed in the current page. Install the ProjectStore-owned
    // domain lazily, then redraw the same panel so those presets join the one
    // ordinary selector. No separate user-preset load path is introduced.
    if (store && !store.userPresets) {
      ensureUserPresetDomain().then(() => {
        if (panel.isConnected) rerenderPanelOnly();
      }).catch((error) => {
        console.warn("Project user preset library unavailable", error);
      });
    }

    row.append(select, save, reset, blocked);
    panel.append(heading, row, saveRow, manageRow);
    // Every mount is also the moment a previous panel was replaced, so this is
    // where a detached one is released - immediately, rather than whenever the
    // transport next happens to move.
    disposeDetachedPanels();
    mountedPresetPanels.set(panel, Object.freeze({
      redraw: () => (libraryMutationInFlight ? false : rerenderPanelOnly()),
      dispose: disconnectAll,
    }));
    // A sweep at the next mount still leaves one panel holding two
    // subscriptions, and leaving Sound mounts nothing at all, so that one
    // would hold them for the rest of the session. Watching the node's own
    // parent releases it at the detach itself. One observer per live panel,
    // disconnected by the same disposer, so this is bounded by what is on
    // screen rather than by what has ever been drawn.
    //
    // This function returns a detached node and its caller appends it, so
    // there is no parent to watch yet. The watch is armed on the next frame,
    // by which time the panel is where it is going to live. A panel mounted
    // and dropped inside one frame was never on screen and is picked up by
    // the sweep at the next mount instead.
    // A panel attached and dropped again inside one frame is already gone by
    // the time this runs. Watching it would be pointless, but doing nothing
    // leaves it registered and subscribed with no later event to sweep it, so
    // it is released here instead.
    const armDetachWatch = () => {
      if (panel.isConnected) watchForDetach(panel, disconnectAll);
      else disconnectAll();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(armDetachWatch);
    else armDetachWatch();
    return panel;
  }

  function renderRecoveryPanel({ inspector, instrument, error, retry } = {}) {
    if (!inspector) return null;
    const panel = document.createElement("section");
    panel.className = "a4a-create-panel a4b-recovery-panel";
    panel.dataset.productionRecovery = "package";
    const title = document.createElement("strong");
    title.textContent = "PRODUCTION ENGINE UNAVAILABLE";
    const identity = document.createElement("div");
    identity.className = "a4a-engine-id";
    const ref = instrument?.engineRef ?? {};
    identity.textContent = `${ref.moduleId ?? "?"}/${ref.engineId ?? "?"}@${ref.resolvedVersion ?? ref.requestedVersion ?? "?"}`;
    const hash = document.createElement("small");
    hash.textContent = ref.resolvedPackageSha256 ? `Pinned package ${ref.resolvedPackageSha256}` : "Package version is preserved in the project";
    const message = document.createElement("div");
    message.className = "a4a-sound-state a4a-error";
    message.textContent = String(error?.message ?? error ?? "Engine package could not be verified");
    const note = document.createElement("small");
    note.textContent = "Instrument state is preserved. BRKTRK will not silently substitute another package version.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "RETRY PACKAGE";
    button.addEventListener("click", async () => {
      button.disabled = true;
      message.textContent = "RETRYING VERIFIED PACKAGE…";
      try { await retry?.(); }
      catch (nextError) {
        message.textContent = String(nextError?.message ?? nextError);
        button.disabled = false;
      }
    });
    panel.append(title, identity, hash, message, note, button);
    inspector.replaceChildren(panel);
    return panel;
  }

  const api = Object.freeze({ transportPlaying, packageIdentity, provenancePresetId, currentPresetId, presetSelectorGroups, renderPresetPanel, refreshMountedPresetPanels, disposeDetachedPanels, mountedPanelCount, renderRecoveryPanel, ensurePresetMutationDomain, ensureLivePreparedPolicy });
  globalThis.BRKTRKSoundPresetSurface = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
