const C3_RENDER_BUDGETS = Object.freeze({
  fullRenderWarnMs: 50,
  targetedCursorWarnMs: 16,
});
const c3RenderHooks = new Map([
  ["all", new Map()],
  ["mixer", new Map()],
  ["transport", new Map()],
]);
const c3RenderMetrics = {
  full: { count: 0, totalMs: 0, lastMs: 0, maxMs: 0 },
  targetedCursor: { count: 0, totalMs: 0, lastMs: 0, maxMs: 0 },
};

function c3RecordRender(bucket, durationMs) {
  const metric = c3RenderMetrics[bucket];
  if (!metric) return;
  metric.count += 1;
  metric.totalMs += durationMs;
  metric.lastMs = durationMs;
  metric.maxMs = Math.max(metric.maxMs, durationMs);
}

function c3RegisterRenderHook(stage, name, callback) {
  const hooks = c3RenderHooks.get(stage);
  const key = String(name ?? "").trim();
  if (!hooks) throw new TypeError(`Unknown render hook stage: ${stage}`);
  if (!key) throw new TypeError("Render hook name is required");
  if (typeof callback !== "function") throw new TypeError(`Render hook ${key} must be a function`);
  hooks.set(key, callback);
  return () => hooks.delete(key);
}

function c3RunRenderHooks(stage) {
  const hooks = c3RenderHooks.get(stage);
  if (!hooks) return;
  for (const callback of hooks.values()) callback();
}

function c3RenderSnapshot() {
  const summarize = (metric) => Object.freeze({
    count: metric.count,
    lastMs: Number(metric.lastMs.toFixed(3)),
    maxMs: Number(metric.maxMs.toFixed(3)),
    averageMs: metric.count ? Number((metric.totalMs / metric.count).toFixed(3)) : 0,
  });
  return Object.freeze({
    version: 1,
    owner: "app-render",
    budgets: C3_RENDER_BUDGETS,
    full: summarize(c3RenderMetrics.full),
    targetedCursor: summarize(c3RenderMetrics.targetedCursor),
    hooks: Object.freeze(Object.fromEntries([...c3RenderHooks.entries()].map(([stage, hooks]) => [stage, Object.freeze([...hooks.keys()])]))),
  });
}

globalThis.BRKTRKRenderRuntime = Object.freeze({
  version: 1,
  budgets: C3_RENDER_BUDGETS,
  registerAfterRender: (name, callback) => c3RegisterRenderHook("all", name, callback),
  registerAfterMixer: (name, callback) => c3RegisterRenderHook("mixer", name, callback),
  registerAfterTransport: (name, callback) => c3RegisterRenderHook("transport", name, callback),
  snapshot: c3RenderSnapshot,
});

function makeCell({ pane, row, col, text, classes = "", title = "", badge = "", badgeClass = "", badgeTitle = "", badgeData = null }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `grid-cell clickable ${classes}`.trim();
  button.dataset.pane = pane;
  button.dataset.row = row;
  button.dataset.col = col;
  button.setAttribute("role", "gridcell");
  const active = state.focus.pane === pane && state.focus.row === row && state.focus.col === col;
  button.setAttribute("aria-selected", String(active));
  button.tabIndex = active ? 0 : -1;
  button.textContent = text;
  button.title = title;
  button.addEventListener("click", () => setFocus(pane, row, col, false));
  if (badge) {
    const marker = document.createElement("span");
    marker.className = `badge ${badgeClass}`.trim();
    marker.textContent = badge;
    if (badgeTitle) marker.title = badgeTitle;
    if (badgeData && typeof badgeData === "object") {
      for (const [key, value] of Object.entries(badgeData)) marker.dataset[key] = String(value);
    }
    button.append(marker);
  }
  return button;
}

function headerRow(labels, activeTrack = -1) {
  const header = document.createElement("div");
  header.className = "grid-header";
  header.setAttribute("role", "row");
  labels.forEach((label, index) => {
    const cell = document.createElement("span");
    cell.textContent = label;
    cell.setAttribute("role", "columnheader");
    if (index > 0 && index - 1 === activeTrack) cell.classList.add("active-track");
    header.append(cell);
  });
  return header;
}

// UX0-02 (#373): reusable Chain/Phrase identity is intentional, but the
// surface never said which objects are actually reused, so editing a shared
// object silently changed every other occurrence. The context line now says
// so, next to the object it is talking about, and says how many places reach
// it - a count is the difference between "careful" and "careful, four times".
function sharedMarker(kind, id) {
  const graph = globalThis.BRKTRKStructuralReferenceGraph;
  if (!graph || !Number.isInteger(id) || id < 0) return null;
  const count = graph.referenceCount(model, kind, id);
  if (count <= 1) return null;
  const marker = document.createElement("span");
  marker.className = "shared-marker";
  marker.dataset.sharedKind = kind;
  marker.dataset.sharedCount = String(count);
  marker.textContent = ` SHARED\u00d7${count}`;
  marker.title = kind === "chain"
    ? `This Chain is used in ${count} Song cells \u00b7 editing it changes all of them`
    : `This Phrase is used in ${count} Chain rows \u00b7 editing it changes all of them`;
  return marker;
}

function renderContextLine(element, parts) {
  if (!element) return false;
  const nodes = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(document.createTextNode(" \u00b7 "));
    nodes.push(document.createTextNode(part.text));
    const marker = part.shared ? sharedMarker(part.shared.kind, part.shared.id) : null;
    if (marker) nodes.push(marker);
  });
  element.replaceChildren(...nodes);
  return true;
}

function renderSongContextLine() {
  const chainId = model.song[state.songRow][state.track];
  renderContextLine($("#songContext"), [
    { text: `ROW ${hex(state.songRow)}` },
    { text: `T${state.track + 1}` },
    { text: `C${chainId < 0 ? "--" : hex(chainId)}`, shared: { kind: "chain", id: chainId } },
  ]);
}

function renderPatternContextLine() {
  renderContextLine($("#patternContext"), [
    { text: `T${state.track + 1}` },
    { text: `C${hex(state.chain)}`, shared: { kind: "chain", id: state.chain } },
    { text: `P${hex(state.phrase)}`, shared: { kind: "phrase", id: state.phrase } },
  ]);
}

function rowClasses(pane, row) {
  const classes = ["grid-row"];
  if (row % 4 === 0) classes.push("beat-row");
  if (state.focus.pane === pane && state.focus.row === row) classes.push("active-row");
  return classes.join(" ");
}

function renderSong() {
  const grid = $("#songGrid");
  grid.replaceChildren(headerRow(["ROW", ...Array.from({ length: TRACKS }, (_, index) => `T${index + 1}`)], state.track));
  for (let row = 0; row < SONG_ROWS; row += 1) {
    const rowEl = document.createElement("div");
    rowEl.className = rowClasses("song", row);
    rowEl.dataset.rowPane = "song";
    rowEl.dataset.row = row;
    rowEl.setAttribute("role", "row");
    const index = document.createElement("button");
    index.type = "button";
    index.className = "grid-cell index";
    index.textContent = hex(row);
    index.tabIndex = -1;
    index.addEventListener("click", () => setFocus("song", row, state.track));
    rowEl.append(index);
    for (let track = 0; track < TRACKS; track += 1) {
      const value = model.song[row][track];
      const selected = state.focus.pane === "song" && state.focus.row === row && state.focus.col === track;
      const linked = !selected && row === state.songRow && track === state.track && state.focus.pane !== "song";
      rowEl.append(makeCell({
        pane: "song",
        row,
        col: track,
        text: value < 0 ? "--" : hex(value),
        classes: [value < 0 ? "empty" : "value", selected ? "selected" : "", linked ? "linked" : ""].join(" "),
        title: value < 0 ? "Empty — double click or double Edit to allocate a Chain" : `Chain ${hex(value)}`,
      }));
    }
    grid.append(rowEl);
  }
  renderSongContextLine();
}

function renderChain() {
  const grid = $("#chainGrid");
  grid.replaceChildren(headerRow(["ROW", "PHRASE", "TRANSPOSE"]));
  const source = chain(state.chain);
  for (let row = 0; row < CHAIN_ROWS; row += 1) {
    const entry = source[row];
    const rowEl = document.createElement("div");
    rowEl.className = rowClasses("chain", row);
    rowEl.dataset.rowPane = "chain";
    rowEl.dataset.row = row;
    rowEl.setAttribute("role", "row");
    const index = document.createElement("span");
    index.className = "grid-cell index";
    index.textContent = hex(row);
    rowEl.append(index);
    const linkedPhrase = state.focus.pane === "phrase" && row === state.chainRow;
    rowEl.append(makeCell({ pane: "chain", row, col: 0, text: entry.phrase < 0 ? "--" : hex(entry.phrase), classes: `${entry.phrase < 0 ? "empty" : "value"} ${state.focus.pane === "chain" && state.focus.row === row && state.focus.col === 0 ? "selected" : ""} ${linkedPhrase ? "linked" : ""}`, title: entry.phrase < 0 ? "Empty — double click or double Edit to allocate a Phrase" : `Phrase ${hex(entry.phrase)}` }));
    rowEl.append(makeCell({ pane: "chain", row, col: 1, text: entry.transpose >= 0 ? `+${entry.transpose}` : String(entry.transpose), classes: `${entry.transpose === 0 ? "empty" : "value"} ${state.focus.pane === "chain" && state.focus.row === row && state.focus.col === 1 ? "selected" : ""}`, title: "Transpose in semitones" }));
    grid.append(rowEl);
  }
  $("#chainTitle").textContent = hex(state.chain);
}

function renderPhrase() {
  const grid = $("#phraseGrid");
  grid.replaceChildren(headerRow(["ROW", "NOTE", "VEL", "INST", "FX1", "FX2", "FX3"]));
  const source = phrase(state.phrase);
  for (let row = 0; row < PHRASE_ROWS; row += 1) {
    const step = source[row];
    const rowEl = document.createElement("div");
    rowEl.className = rowClasses("phrase", row);
    rowEl.dataset.rowPane = "phrase";
    rowEl.dataset.row = row;
    rowEl.setAttribute("role", "row");
    const index = document.createElement("span");
    index.className = "grid-cell index";
    index.textContent = hex(row);
    rowEl.append(index);
    const instrument = instrumentReferencePresentation(step.instrument, model.instrumentPool);
    // UX0-07 (#374): a row's velocity and Instrument belong to its note. With
    // no note they are stored settings that nothing is applying, and drawing
    // them like live values made an empty Phrase read as active parameter
    // data. The values themselves are untouched and stay editable.
    const rowPresentation = globalThis.BRKTRKPhraseRowPresentation;
    const presentation = rowPresentation?.phraseRowPresentation(step);
    const inert = rowPresentation?.INOPERATIVE_CLASS ?? "inoperative";
    const inertIf = (operative) => (presentation && operative === false ? inert : "");
    const conditionPresentation = globalThis.BRKTRKPhraseConditionPresentation;
    const conditionBadge = conditionPresentation?.badge(step.condition) ?? "";
    const values = [
      {
        text: noteName(step.note),
        className: step.note < 0 ? "empty" : "value",
        title: "Note",
        badge: conditionBadge,
        badgeClass: "condition-badge",
        badgeTitle: conditionPresentation?.title(step.condition) ?? "",
        badgeData: conditionBadge ? { phraseConditionRow: row } : null,
      },
      {
        text: String(step.velocity),
        className: inertIf(presentation?.velocityOperative),
        title: rowPresentation?.velocityTitle(presentation) ?? "Velocity",
      },
      {
        text: instrument.text,
        className: `${instrument.state === "empty" ? "empty" : `instrument ${instrument.state}`} ${inertIf(presentation?.instrumentOperative)}`.trim(),
        title: rowPresentation?.instrumentTitle(presentation, instrument.title) ?? instrument.title,
      },
      ...step.fx.map((slot) => {
        const command = fxCommandCode(slot);
        const value = fxValueByte(slot);
        return { text: fxName(slot), className: command === 0 ? "empty" : "fx", title: command === 0 ? "Empty effect slot" : `Effect ${fxName(slot)} · value ${hex(value)}` };
      }),
    ];
    values.forEach((value, col) => {
      const selected = state.focus.pane === "phrase" && state.focus.row === row && state.focus.col === col;
      rowEl.append(makeCell({
        pane: "phrase", row, col, text: value.text,
        classes: `${value.className} ${selected ? "selected" : ""}`,
        title: value.title,
        badge: value.badge,
        badgeClass: value.badgeClass,
        badgeTitle: value.badgeTitle,
        badgeData: value.badgeData,
      }));
    });
    grid.append(rowEl);
  }
  $("#phraseTitle").textContent = hex(state.phrase);
}

function renderMixer() {
  const mixer = $("#mixer");
  if (!mixer) return false;
  if (!mixer.dataset.trackMixerInstalled) {
    mixer.replaceChildren();
    mixer.dataset.routingState = "track-owned-bootstrap";
  }
  c3RunRenderHooks("mixer");
  return true;
}

function renderInspectorIdentity() {
  $("#selectionBreadcrumb").textContent = `T${state.track + 1} · S${hex(state.songRow)} · C${hex(state.chain)}:${hex(state.chainRow)} · P${hex(state.phrase)}:${hex(state.phraseRow)} · I${hex(state.instrument)}`;
  $("#inspectorTitle").textContent = `INST ${hex(state.instrument)}`;
}

function renderInstrumentParameters() {
  const inspector = $("#instrumentInspector");
  if (!inspector) return false;
  if (globalThis.BRKTRKSoundEditRenderer?.renderProductionSurface) return globalThis.BRKTRKSoundEditRenderer.renderProductionSurface();
  inspector.replaceChildren();
  const status = document.createElement("div");
  status.className = "a4a-create-panel";
  status.textContent = "PRODUCTION SOUND INITIALIZING…";
  inspector.append(status);
  return true;
}

function renderInspector() {
  renderInspectorIdentity();
  renderInstrumentParameters();
  renderMixer();
  const dock = state.dock ?? "mix";
  $("#inspectorPane").dataset.dock = dock;
  $$("#dockTabs button").forEach((button) => button.classList.toggle("active", button.dataset.dock === dock));
  $("#soundDock").hidden = dock !== "sound";
  $("#mixerSection").hidden = dock !== "mix";
  $("#placeholderDock").hidden = dock === "sound" || dock === "mix";
}

function renderTransport() {
  $("#tempoValue").textContent = model.tempo;
  $("#projectName").textContent = model.projectName;
  $("#playLabel").textContent = "PLAY";
  $("#playButton").setAttribute("aria-pressed", String(state.playing));
  $$("#scopeSwitch button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.scope === state.scope)));
  renderPatternContextLine();
  const engineButton = $("#bootButton");
  engineButton.setAttribute("aria-pressed", String(audio.ready));
  engineButton.querySelector("small").textContent = audio.ready ? "AUDIO READY" : "ENABLE AUDIO";
  c3RunRenderHooks("transport");
}

function renderFocusState() {
  const pane = state.focus.pane;
  $("#songPane").classList.toggle("active-pane", pane === "song");
  $("#patternPane").classList.toggle("active-pane", pane === "chain" || pane === "phrase");
  $(".chain-subpane").classList.toggle("active-subpane", pane === "chain");
  $(".phrase-subpane").classList.toggle("active-subpane", pane === "phrase");
  $("#activeEditorLabel").textContent = `EDITING ${pane.toUpperCase()}`;
  const value = currentValue();
  let field = "CELL";
  if (pane === "song") field = `T${state.track + 1}`;
  else if (pane === "chain") field = state.focus.col === 0 ? "PHRASE" : "TRANSPOSE";
  else field = ["NOTE", "VEL", "INST", "FX1", "FX2", "FX3"][state.focus.col] ?? "CELL";
  const instrument = pane === "phrase" && state.focus.col === 2 ? instrumentReferencePresentation(value, model.instrumentPool) : null;
  const display = pane === "phrase" && state.focus.col === 0
    ? noteName(value)
    : pane === "phrase" && state.focus.col >= 3
      ? fxName(value)
      : instrument?.text ?? (value < 0 ? "--" : String(value));
  $("#editBreadcrumb").textContent = `EDIT · TRACK ${state.track + 1} · SONG ${hex(state.songRow)} · CHAIN ${hex(state.chain)} · PHRASE ${hex(state.phrase)} · ROW ${hex(state.focus.row)} · ${field} ${display}`;
}

function renderMobileView() {
  const normalizedView = state.view === "pattern" ? "phrase" : state.view;
  $("#workspace").dataset.view = normalizedView;
  $$("#mobileTabs button").forEach((button) => button.classList.toggle("active", button.dataset.view === normalizedView));
}

function renderPlayheads() {
  $$(".grid-cell.playing").forEach((cell) => cell.classList.remove("playing"));
  $$(".grid-row.playing-row").forEach((row) => row.classList.remove("playing-row"));
  const playhead = state.playhead;
  if (playhead.step < 0) return;
  [["song", playhead.songRow], ["chain", playhead.chainRow], ["phrase", playhead.phraseRow]].forEach(([pane, row]) => {
    if (row < 0) return;
    $$(`[data-pane="${pane}"][data-row="${row}"]`).forEach((cell) => cell.classList.add("playing"));
    $(`[data-row-pane="${pane}"][data-row="${row}"]`)?.classList.add("playing-row");
  });
}

function renderTrackerCursor(mutation = {}) {
  const startedAt = performance.now();
  const beforeContext = mutation.contextBefore ?? mutation.before?.context ?? mutation.before ?? {};
  const afterContext = mutation.contextAfter ?? mutation.after?.context ?? mutation.after ?? {};
  const chainChanged = beforeContext.chain !== afterContext.chain;
  const phraseChanged = beforeContext.phrase !== afterContext.phrase;
  const instrumentChanged = beforeContext.instrument !== afterContext.instrument;
  if (chainChanged) renderChain();
  if (phraseChanged) renderPhrase();
  if (instrumentChanged) renderInstrumentParameters();
  $$("[data-pane][data-row][data-col]").forEach((cell) => {
    const active = cell.dataset.pane === state.focus.pane && Number(cell.dataset.row) === state.focus.row && Number(cell.dataset.col) === state.focus.col;
    cell.classList.toggle("selected", active);
    cell.setAttribute("aria-selected", String(active));
    cell.tabIndex = active ? 0 : -1;
  });
  $$("[data-row-pane][data-row]").forEach((row) => row.classList.toggle("active-row", row.dataset.rowPane === state.focus.pane && Number(row.dataset.row) === state.focus.row));
  $$("#songGrid .grid-header [role=columnheader]").forEach((header, index) => header.classList.toggle("active-track", index > 0 && index - 1 === state.track));
  $$('#songGrid [data-pane="song"]').forEach((cell) => {
    const selected = cell.classList.contains("selected");
    const linked = !selected && state.focus.pane !== "song" && Number(cell.dataset.row) === state.songRow && Number(cell.dataset.col) === state.track;
    cell.classList.toggle("linked", linked);
  });
  $$('#chainGrid [data-pane="chain"][data-col="0"]').forEach((cell) => cell.classList.toggle("linked", state.focus.pane === "phrase" && Number(cell.dataset.row) === state.chainRow));
  renderSongContextLine();
  $("#chainTitle").textContent = hex(state.chain);
  $("#phraseTitle").textContent = hex(state.phrase);
  renderPatternContextLine();
  renderInspectorIdentity();
  renderFocusState();
  renderPlayheads();
  const count = Number(document.body.dataset.targetedCursorRenders || 0) + 1;
  document.body.dataset.targetedCursorRenders = String(count);
  document.body.dataset.targetedCursorPane = state.focus.pane;
  document.body.dataset.targetedCursorCell = `${state.focus.row}:${state.focus.col}`;
  document.body.dataset.targetedCursorDependencies = `${chainChanged ? "chain" : ""}:${phraseChanged ? "phrase" : ""}:${instrumentChanged ? "instrument" : ""}`;
  c3RecordRender("targetedCursor", performance.now() - startedAt);
  return Object.freeze({ chainChanged, phraseChanged, instrumentChanged, count });
}

function renderAll() {
  const startedAt = performance.now();
  renderTransport();
  renderSong();
  renderChain();
  renderPhrase();
  renderInspector();
  renderFocusState();
  renderMobileView();
  renderPlayheads();
  c3RunRenderHooks("all");
  c3RecordRender("full", performance.now() - startedAt);
}