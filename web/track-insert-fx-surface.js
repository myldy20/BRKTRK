(() => {
  "use strict";

  const projectStore = globalThis.BRKTRKStores?.project;
  const navigationStore = globalThis.BRKTRKStores?.navigation;
  const domain = globalThis.BRKTRKTrackInsertFxDomain;
  if (!projectStore || !navigationStore || !domain) throw new Error("Track Insert FX surface requires ProjectStore, NavigationStore and FX domain");
  if (globalThis.BRKTRKTrackInsertFxSurface?.installed) return;

  const clampTrack = (value) => Math.max(0, Math.min((projectStore.getState()?.tracks?.length ?? 8) - 1, Math.round(Number(value) || 0)));

  function selectedTrack() {
    return clampTrack(navigationStore.captureContext?.().track ?? 0);
  }

  function ensurePanel() {
    const section = document.querySelector("#mixerSection");
    const mixer = document.querySelector("#mixer");
    if (!section || !mixer) return null;
    let panel = section.querySelector(".track-insert-fx-panel");
    if (panel) return panel;
    panel = document.createElement("section");
    panel.className = "track-insert-fx-panel";
    panel.setAttribute("aria-label", "Track insert effects");
    mixer.after(panel);
    return panel;
  }

  function parameterControl(track, slotIndex, slot, descriptor, parameter, parameterIndex) {
    const row = document.createElement("label");
    row.className = "track-insert-fx-parameter";
    row.dataset.parameter = parameter.id;

    const heading = document.createElement("span");
    heading.textContent = parameter.label;

    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = String(parameter.mapping === domain.MAPPING.DISCRETE ? parameter.maximum : 255);
    input.step = "1";
    input.value = String(slot.values[parameterIndex]);
    input.setAttribute("aria-label", `Track ${track + 1} FX ${slotIndex + 1} ${descriptor.label} ${parameter.label}`);

    const output = document.createElement("output");
    output.textContent = domain.describeValue(slot.module, parameterIndex, input.value);

    input.addEventListener("input", () => {
      output.textContent = domain.describeValue(slot.module, parameterIndex, input.value);
      projectStore.setTrackInsertFxParameter(track, slotIndex, parameterIndex, Number(input.value), {
        source: "track-insert-fx-parameter",
      });
    });

    row.append(heading, input, output);
    return row;
  }

  function slotCard(track, slotIndex, slot) {
    const descriptor = domain.descriptor(slot.module);
    const card = document.createElement("div");
    card.className = "track-insert-fx-slot";
    card.dataset.slot = String(slotIndex);
    card.dataset.module = descriptor.id;
    card.dataset.bypass = String(slot.bypass);

    const toolbar = document.createElement("div");
    toolbar.className = "track-insert-fx-slot-toolbar";

    const title = document.createElement("strong");
    title.textContent = `FX${slotIndex + 1}`;

    const select = document.createElement("select");
    select.className = "track-insert-fx-module";
    select.setAttribute("aria-label", `Track ${track + 1} insert FX slot ${slotIndex + 1} module`);
    for (const module of domain.MODULES) {
      const option = document.createElement("option");
      option.value = module.id;
      option.textContent = module.label;
      option.selected = module.id === descriptor.id;
      select.append(option);
    }
    select.addEventListener("change", () => {
      projectStore.selectTrackInsertFxModule(track, slotIndex, select.value, {
        source: "track-insert-fx-module",
      });
    });

    const bypass = document.createElement("button");
    bypass.type = "button";
    bypass.className = "track-insert-fx-bypass";
    bypass.textContent = slot.bypass ? "BYPASS ON" : "BYPASS";
    bypass.disabled = descriptor.id === "off";
    bypass.setAttribute("aria-pressed", String(slot.bypass));
    bypass.setAttribute("aria-label", `Bypass Track ${track + 1} insert FX slot ${slotIndex + 1}`);
    bypass.addEventListener("click", () => {
      projectStore.setTrackInsertFxBypass(track, slotIndex, !slot.bypass, {
        source: "track-insert-fx-bypass",
      });
    });

    toolbar.append(title, select, bypass);
    card.append(toolbar);

    const parameters = document.createElement("div");
    parameters.className = "track-insert-fx-parameters";
    if (!descriptor.parameters.length) {
      const empty = document.createElement("small");
      empty.className = "track-insert-fx-empty";
      empty.textContent = "OFF · no DSP parameters";
      parameters.append(empty);
    } else {
      descriptor.parameters.forEach((parameter, parameterIndex) => {
        parameters.append(parameterControl(track, slotIndex, slot, descriptor, parameter, parameterIndex));
      });
    }
    card.append(parameters);
    return card;
  }

  function render(trackValue = selectedTrack()) {
    const panel = ensurePanel();
    if (!panel) return false;
    const track = clampTrack(trackValue);
    const projectTrack = projectStore.getState()?.tracks?.[track] ?? {};
    const chain = domain.normalizeChain(projectTrack.insertFx);

    panel.replaceChildren();
    panel.dataset.track = String(track);

    const header = document.createElement("header");
    header.className = "track-insert-fx-header";
    const title = document.createElement("strong");
    title.textContent = `T${track + 1} · INSERT FX`;
    const note = document.createElement("small");
    note.textContent = "2 serial slots · pre gain/pan/mute · 5 ms click-safe switching";
    header.append(title, note);

    const rack = document.createElement("div");
    rack.className = "track-insert-fx-rack";
    chain.forEach((slot, slotIndex) => rack.append(slotCard(track, slotIndex, slot)));
    panel.append(header, rack);
    return true;
  }

  const unsubscribeNavigation = navigationStore.subscribe("navigation", (changeSet) => {
    if (!changeSet?.renderTargets?.some((target) => [
      "navigation.track-selection",
      "navigation.context",
      "navigation.workspace",
    ].includes(target))) return;
    render();
  });
  const unsubscribeProject = projectStore.subscribe("track-insert-fx", (changeSet) => {
    if (Number(changeSet?.transaction?.track) !== selectedTrack()) return;
    // Parameter inputs already paint their own value. Replacing the complete
    // rack synchronously during an input drag would destroy the active slider
    // node under the pointer. Module selection and bypass are structural to the
    // rack shape/state and deliberately rerender.
    if (Number.isInteger(changeSet?.transaction?.parameterIndex)) return;
    render();
  });

  const api = Object.freeze({
    installed: true,
    render,
    ensurePanel,
    selectedTrack,
    disconnect() {
      unsubscribeNavigation();
      unsubscribeProject();
    },
  });
  globalThis.BRKTRKTrackInsertFxSurface = api;
  render();
})();
