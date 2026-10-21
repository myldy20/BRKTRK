(() => {
  const PROJECT_SCHEMA_VERSION = 5;
  const RETIRED_PREVIEW_EXTENSION_KEYS = Object.freeze([
    "org.myldydesign.brktrk.preview-instruments-v2",
    "org.myldydesign.brktrk.pre-v4-instrument-pool-unknown",
  ]);
  const PROJECT_DOMAINS = Object.freeze([
    "tracks", "song", "chains", "phrases", "instrumentPool", "tables", "grooves", "scales",
    "modulation", "mixer", "master", "effects", "assets", "presets", "mappings",
  ]);
  const WORKSPACES = Object.freeze(["song", "chain", "phrase", "sound", "mix"]);
  const STRUCTURAL_WORKSPACES = Object.freeze(["song", "chain", "phrase"]);
  const CHANGE_OWNERS = Object.freeze(["project", "navigation", "transport", "ui"]);
  const OWNERSHIP = Object.freeze({
    project: Object.freeze([
      "identity", "schema", "tracks", "song", "chains", "phrases", "instrumentPool", "tables",
      "grooves", "scales", "modulation", "mixer", "master", "effects", "assets", "presets",
      "mappings", "sourceEnvelope", "compatibilityReport",
    ]),
    navigation: Object.freeze([
      "activeWorkspace", "trackerCursor", "structuralContext", "occurrenceContext", "mixReturn", "returnStack", "activeSheet",
      "selection", "preparedEntry", "poolBrowsing",
    ]),
    transport: Object.freeze([
      "scope", "plan", "trackPositions", "queue", "followPolicy", "timingContext", "engineStatus",
      "performanceState",
    ]),
  });

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const integerOr = (value, fallback = 0) => Number.isInteger(value) ? value : fallback;
  const freezeList = (value) => Object.freeze([...(Array.isArray(value) ? value : [])]);

  function trackInsertFxDomain() {
    if (globalThis.BRKTRKTrackInsertFxDomain) return globalThis.BRKTRKTrackInsertFxDomain;
    if (typeof require !== "undefined") return require("./track-insert-fx-domain.js");
    throw new Error("Track Insert FX domain is unavailable");
  }

  function productionInstrumentDomain() {
    if (globalThis.BRKTRKProductionInstrumentDomain) return globalThis.BRKTRKProductionInstrumentDomain;
    if (typeof require !== "undefined") return require("./production-instrument-domain.js");
    throw new Error("Production Instrument domain is unavailable");
  }

  function normalizeProjectName(value, fallback = "UNTITLED 01") {
    const trimmed = String(value ?? "").trim();
    return (trimmed || fallback).slice(0, 24).toUpperCase();
  }

  function normalizeWorkspace(value, fallback = "phrase") {
    const candidate = String(value ?? "").toLowerCase();
    return WORKSPACES.includes(candidate) ? candidate : fallback;
  }

  function normalizeTrackerCursor(value, fallback = {}) {
    const candidate = value && typeof value === "object" ? value : {};
    const fallbackPane = STRUCTURAL_WORKSPACES.includes(fallback.pane) ? fallback.pane : "phrase";
    const pane = STRUCTURAL_WORKSPACES.includes(candidate.pane) ? candidate.pane : fallbackPane;
    return {
      pane,
      row: Math.max(0, integerOr(candidate.row, integerOr(fallback.row, 0))),
      col: Math.max(0, integerOr(candidate.col, integerOr(fallback.col, 0))),
    };
  }

  function normalizeNavigationContext(value = {}, fallbackState = {}) {
    const source = value && typeof value === "object" ? value : {};
    const fallbackFocus = normalizeTrackerCursor(fallbackState.focus);
    const focus = normalizeTrackerCursor(source.focus ?? source.trackerCursor, fallbackFocus);
    const fallbackWorkspace = normalizeWorkspace(
      fallbackState.p3?.activeWorkspace ?? fallbackState.view ?? fallbackFocus.pane,
      fallbackFocus.pane,
    );
    const activeWorkspace = normalizeWorkspace(
      source.activeWorkspace ?? source.view ?? source.focus?.pane,
      fallbackWorkspace,
    );
    const view = normalizeWorkspace(source.view ?? activeWorkspace, activeWorkspace);
    return {
      view,
      dock: typeof source.dock === "string" ? source.dock : typeof fallbackState.dock === "string" ? fallbackState.dock : "mix",
      activeWorkspace,
      focus,
      songRow: integerOr(source.songRow, integerOr(fallbackState.songRow, 0)),
      track: integerOr(source.track, integerOr(fallbackState.track, 0)),
      chain: integerOr(source.chain, integerOr(fallbackState.chain, 0)),
      chainRow: integerOr(source.chainRow, integerOr(fallbackState.chainRow, 0)),
      phrase: integerOr(source.phrase, integerOr(fallbackState.phrase, 0)),
      phraseRow: integerOr(source.phraseRow, integerOr(fallbackState.phraseRow, 0)),
      instrument: integerOr(source.instrument, integerOr(fallbackState.instrument, 0)),
      soundParam: integerOr(source.soundParam, integerOr(fallbackState.p3?.soundParam, 0)),
      lastChain: integerOr(source.lastChain, integerOr(fallbackState.lastChain, 0)),
      lastPhrase: integerOr(source.lastPhrase, integerOr(fallbackState.lastPhrase, 0)),
    };
  }

  function ensureObject(target, key) {
    if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) target[key] = {};
    return target[key];
  }

  function stripRetiredPreviewExtensions(model) {
    const source = model?.compatibilityExtensions;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      delete model.compatibilityExtensions;
      return model;
    }
    const extensions = clone(source);
    for (const key of RETIRED_PREVIEW_EXTENSION_KEYS) delete extensions[key];
    if (Object.keys(extensions).length > 0) model.compatibilityExtensions = extensions;
    else delete model.compatibilityExtensions;
    return model;
  }

  function normalizeProjectState(model, trackCount = 8) {
    if (!model || typeof model !== "object") throw new TypeError("ProjectStore requires a project object");
    if (!Number.isInteger(model.schemaVersion) || model.schemaVersion < PROJECT_SCHEMA_VERSION) model.schemaVersion = PROJECT_SCHEMA_VERSION;
    model.projectName = normalizeProjectName(model.projectName);
    if (!Array.isArray(model.tracks)) {
      model.tracks = Array.from({ length: trackCount }, (_, id) => ({ id }));
    } else if (model.tracks.length < trackCount) {
      for (let id = model.tracks.length; id < trackCount; id += 1) model.tracks.push({ id });
    }
    model.instrumentPool = productionInstrumentDomain().normalizeInstrumentPool(model.instrumentPool ?? {});
    const insertFx = trackInsertFxDomain();
    model.tracks = Array.from({ length: trackCount }, (_, id) => {
      const track = model.tracks[id] && typeof model.tracks[id] === "object" ? model.tracks[id] : { id };
      return { ...track, id, insertFx: insertFx.normalizeChain(track.insertFx) };
    });
    for (const key of ["tables", "grooves", "scales", "modulation", "mixer", "master", "effects", "assets", "presets", "mappings"]) ensureObject(model, key);
    if (typeof model.sourceFormat !== "string" || !model.sourceFormat) model.sourceFormat = "brktrk";
    if (!Object.hasOwn(model, "sourceVersion")) model.sourceVersion = null;
    ensureObject(model, "sourceMetadata");
    delete model.instruments;
    delete model.previewInstruments;
    stripRetiredPreviewExtensions(model);
    if (!Array.isArray(model.unknownData)) model.unknownData = [];
    return model;
  }

  function subtypeFromTarget(target, fallback) {
    const parts = String(target || "").split(".").filter(Boolean);
    if (!parts.length) return fallback;
    if (CHANGE_OWNERS.includes(parts[0])) return parts.slice(1).join(".") || fallback;
    return parts.join(".");
  }

  function createStoreChangeSet(input = {}) {
    const owner = CHANGE_OWNERS.includes(input.owner) ? input.owner : "ui";
    const kind = typeof input.kind === "string" && input.kind ? input.kind : owner;
    const target = String(input.target || owner);
    const subtype = typeof input.subtype === "string" && input.subtype ? input.subtype : subtypeFromTarget(target, kind);
    return Object.freeze({
      owner,
      kind,
      subtype,
      target,
      path: freezeList(input.path),
      before: clone(input.before),
      after: clone(input.after),
      affectsPlayback: Boolean(input.affectsPlayback),
      // `affectsPlayback` answers "must audio owners see this change at all".
      // `structuralPlayback` answers the separate question "does this change the
      // program/timeline, so playback must be re-planned and re-prepared".
      // Conflating them made one ordinary live parameter sample mean both a
      // cheap parameter delivery and a structural program refresh. Defaulting to
      // `affectsPlayback` keeps every existing changeSet behaving as before.
      structuralPlayback: typeof input.structuralPlayback === "boolean" ? input.structuralPlayback : Boolean(input.affectsPlayback),
      persistsProject: Boolean(input.persistsProject),
      renderTargets: freezeList(input.renderTargets),
      source: typeof input.source === "string" && input.source ? input.source : null,
      transaction: clone(input.transaction ?? null),
      schemaVersion: Number.isInteger(input.schemaVersion) ? input.schemaVersion : null,
    });
  }

  function createProjectChangeSet(input = {}) {
    return createStoreChangeSet({ ...input, owner: "project", kind: input.kind ?? "project", persistsProject: input.persistsProject !== false, schemaVersion: PROJECT_SCHEMA_VERSION });
  }

  function createNavigationChangeSet(input = {}) {
    return createStoreChangeSet({ ...input, owner: "navigation", kind: input.kind ?? "cursor", affectsPlayback: false, persistsProject: false, schemaVersion: null });
  }

  function createTransportChangeSet(input = {}) {
    return createStoreChangeSet({ ...input, owner: "transport", kind: input.kind ?? "transport", persistsProject: false, schemaVersion: null });
  }

  class ChannelStore {
    constructor(owner, state, ownership) {
      this.owner = owner;
      this.state = state;
      this.ownership = ownership;
      this.listeners = new Map();
    }
    getState() { return this.state; }
    select(selector) {
      if (typeof selector === "function") return selector(this.state);
      return String(selector).split(".").filter(Boolean).reduce((value, key) => value?.[key], this.state);
    }
    subscribe(channel, listener) {
      if (typeof listener !== "function") throw new TypeError("Store subscriber must be a function");
      const key = String(channel);
      if (!this.listeners.has(key)) this.listeners.set(key, new Set());
      this.listeners.get(key).add(listener);
      return () => this.listeners.get(key)?.delete(listener);
    }
    emit(channel, changeSet) {
      const snapshot = [...(this.listeners.get(String(channel)) ?? [])];
      for (const listener of snapshot) listener(changeSet, this.state);
    }
  }

  class ProjectStore extends ChannelStore {
    constructor(model, options = {}) { super("project", normalizeProjectState(model, options.trackCount ?? 8), OWNERSHIP.project); }
    publish(changeSet, channels) { for (const channel of channels) this.emit(channel, changeSet); }

    setTrackInsertFxSlot(trackValue, slotValue, value, metadata = {}) {
      const track = Number(trackValue);
      const slot = Number(slotValue);
      if (!Number.isInteger(track) || track < 0 || track >= this.state.tracks.length) throw new RangeError("Track Insert FX track is out of range");
      if (!Number.isInteger(slot) || slot < 0 || slot >= trackInsertFxDomain().SLOT_COUNT) throw new RangeError("Track Insert FX slot is out of range");
      const chain = trackInsertFxDomain().normalizeChain(this.state.tracks[track].insertFx);
      const before = clone(chain[slot]);
      const after = clone(trackInsertFxDomain().normalizeSlot(value));
      const changeSet = createProjectChangeSet({
        subtype: "track.insert-fx",
        target: `project.tracks.${track}.insertFx.${slot}`,
        path: ["tracks", track, "insertFx", slot],
        before,
        after,
        affectsPlayback: true,
        structuralPlayback: false,
        renderTargets: ["mix.track-insert-fx"],
        source: metadata.source,
        transaction: { track, slot, parameterIndex: metadata.parameterIndex ?? null },
      });
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { value: clone(after), before, after: clone(after), mutated: false, changeSet, metadata: clone(metadata) };
      }
      const next = chain.map((entry, index) => index === slot ? after : clone(entry));
      this.state.tracks[track].insertFx = next;
      this.publish(changeSet, ["project", "persistence", "track-insert-fx", "render"]);
      return { value: clone(after), before, after: clone(after), mutated: true, changeSet, metadata: clone(metadata) };
    }

    selectTrackInsertFxModule(track, slot, moduleId, metadata = {}) {
      const domain = trackInsertFxDomain();
      const spec = domain.descriptor(moduleId);
      return this.setTrackInsertFxSlot(track, slot, {
        module: spec.id,
        bypass: false,
        values: domain.defaultValues(spec.id),
      }, { ...metadata, parameterIndex: null });
    }

    setTrackInsertFxBypass(track, slot, bypass, metadata = {}) {
      const current = trackInsertFxDomain().normalizeChain(this.state.tracks?.[Number(track)]?.insertFx)[Number(slot)];
      return this.setTrackInsertFxSlot(track, slot, { ...current, bypass: Boolean(bypass) }, metadata);
    }

    setTrackInsertFxParameter(track, slot, parameterIndex, value, metadata = {}) {
      const domain = trackInsertFxDomain();
      const chain = domain.normalizeChain(this.state.tracks?.[Number(track)]?.insertFx);
      const current = chain[Number(slot)];
      if (!current) throw new RangeError("Track Insert FX slot is out of range");
      const index = Number(parameterIndex);
      const descriptor = domain.descriptor(current.module);
      if (!Number.isInteger(index) || index < 0 || index >= descriptor.parameters.length) throw new RangeError("Track Insert FX parameter is out of range");
      const values = [...current.values];
      values[index] = domain.clampValue(current.module, index, value);
      return this.setTrackInsertFxSlot(track, slot, { ...current, values }, { ...metadata, parameterIndex: index });
    }

    setTempo(value, metadata = {}) {
      const before = Number(this.state.tempo);
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) throw new TypeError("Tempo must be numeric");
      const after = clamp(Math.round(numeric), 30, 300);
      const changeSet = createProjectChangeSet({ subtype: "tempo", target: "project.tempo", path: ["tempo"], before, after, affectsPlayback: true, persistsProject: true, renderTargets: ["transport.tempo"], source: metadata.source });
      if (before === after) return { value: after, before, after, mutated: false, changeSet, metadata: clone(metadata) };
      this.state.tempo = after;
      this.publish(changeSet, ["project", "persistence", "audio", "render"]);
      return { value: after, before, after, mutated: true, changeSet, metadata: clone(metadata) };
    }

    // Bind the unassigned two-note preview only when it still has the exact
    // virgin-project shape. A user-edited, restored or imported song is never
    // touched by this convenience action.
    assignStarterPhraseInstrument(instrumentId, metadata = {}) {
      const id = productionInstrumentDomain().instrumentId(instrumentId);
      const project = this.state;
      const phrase = project.phrases?.[0];
      if (!project.instrumentPool?.[id] || project.projectName !== "UNTITLED 01"
          || !Array.isArray(phrase) || phrase.length !== 16
          || Object.keys(project.phrases ?? {}).length !== 1
          || project.song?.[0]?.[0] !== 0 || project.chains?.[0]?.[0]?.phrase !== 0) {
        return { mutated: false, reason: "not-virgin-preview" };
      }
      const expectedNotes = new Map([[0, 48], [4, -2], [8, 55], [12, -2]]);
      const untouched = phrase.every((step, row) =>
        step?.note === (expectedNotes.get(row) ?? -1)
        && step?.instrument === -1
        && (!Array.isArray(step?.parameterEvents) || step.parameterEvents.length === 0)
        && (step?.fx ?? []).every((fx) => Number(fx?.command ?? fx ?? 0) === 0));
      if (!untouched) return { mutated: false, reason: "edited-preview" };
      const before = clone(phrase);
      const after = clone(phrase);
      for (const row of expectedNotes.keys()) after[row].instrument = id;
      const changeSet = createProjectChangeSet({
        subtype: "phrase.starter-instrument",
        target: "project.phrases.0",
        path: ["phrases", 0],
        before, after,
        affectsPlayback: true,
        structuralPlayback: true,
        renderTargets: ["phrase.grid", "instrument.context"],
        source: metadata.source,
        transaction: { instrumentId: id },
      });
      project.phrases[0] = after;
      this.publish(changeSet, ["project", "persistence", "audio", "render"]);
      return { mutated: true, before, after: clone(after), changeSet };
    }

    createProductionInstrument(instrumentId, value, metadata = {}) {
      const id = productionInstrumentDomain().instrumentId(instrumentId);
      if (Object.hasOwn(this.state.instrumentPool, id)) throw new Error(`Production Instrument ${id} already exists`);
      const after = productionInstrumentDomain().createInstrument(id, value);
      const changeSet = createProjectChangeSet({ subtype: "instrument.create", target: `project.instrumentPool.${id}`, path: ["instrumentPool", id], before: null, after, affectsPlayback: true, renderTargets: ["instrument.context"], source: metadata.source, transaction: { instrumentId: id } });
      this.state.instrumentPool[id] = clone(after);
      this.publish(changeSet, ["project", "persistence", "audio", "render"]);
      return { value: clone(after), before: null, after: clone(after), mutated: true, changeSet, metadata: clone(metadata) };
    }

    // A different engine cannot inherit the former package's opaque patch,
    // parameter IDs, factory provenance or sample attachment. Replace the
    // complete canonical Instrument in one Project mutation so Undo can restore
    // every previous byte and the audio owner sees one structural boundary.
    replaceProductionInstrumentEngine(instrumentId, value, metadata = {}) {
      const id = productionInstrumentDomain().instrumentId(instrumentId);
      const existing = this.state.instrumentPool[id];
      if (!existing) throw new Error(`Production Instrument ${id} does not exist`);
      const before = clone(existing);
      const after = productionInstrumentDomain().normalizeInstrument(id, { ...value, id, name: existing.name });
      const identity = (ref) => [
        ref?.moduleId, ref?.engineId, ref?.resolvedVersion ?? ref?.requestedVersion,
        ref?.resolvedPackageSha256,
      ].join("\u0000");
      if (identity(before.engineRef) === identity(after.engineRef)) {
        throw new Error("Select a different verified engine to replace this Instrument");
      }
      const changeSet = createProjectChangeSet({
        subtype: "instrument.engine-replace",
        target: `project.instrumentPool.${id}`,
        path: ["instrumentPool", id],
        before, after,
        affectsPlayback: true,
        structuralPlayback: true,
        renderTargets: ["instrument.context"],
        source: metadata.source,
        transaction: { instrumentId: id, safeBoundaryRequired: true, oldPackageSha256: before.engineRef.resolvedPackageSha256 ?? null, newPackageSha256: after.engineRef.resolvedPackageSha256 ?? null },
      });
      this.state.instrumentPool[id] = clone(after);
      this.publish(changeSet, ["project", "persistence", "audio", "render"]);
      return { value: clone(after), before, after: clone(after), mutated: true, changeSet, metadata: clone(metadata) };
    }

    renameProductionInstrument(instrumentId, value, metadata = {}) {
      const id = productionInstrumentDomain().instrumentId(instrumentId);
      const instrument = this.state.instrumentPool[id];
      if (!instrument) throw new Error(`Production Instrument ${id} does not exist`);
      const before = String(instrument.name);
      const raw = String(value ?? "").trim();
      if (!raw) throw new TypeError("Production Instrument name must not be empty");
      const after = raw.slice(0, 48);
      const changeSet = createProjectChangeSet({ subtype: "instrument.rename", target: `project.instrumentPool.${id}`, path: ["instrumentPool", id, "name"], before, after, affectsPlayback: false, renderTargets: ["instrument.context"], source: metadata.source, transaction: { instrumentId: id } });
      if (before === after) return { value: after, before, after, mutated: false, changeSet, metadata: clone(metadata) };
      instrument.name = after;
      this.publish(changeSet, ["project", "persistence", "render"]);
      return { value: after, before, after, mutated: true, changeSet, metadata: clone(metadata) };
    }

    setProductionInstrumentAssetRef(instrumentId, value, metadata = {}) {
      const id = productionInstrumentDomain().instrumentId(instrumentId);
      const instrument = this.state.instrumentPool[id];
      if (!instrument) throw new Error(`Production Instrument ${id} does not exist`);
      const before = clone(Object.hasOwn(instrument, "assetRef") ? instrument.assetRef : null);
      const after = value == null ? null : productionInstrumentDomain().normalizeSampleAssetRef(value);
      const changeSet = createProjectChangeSet({
        subtype: "instrument.asset",
        target: `project.instrumentPool.${id}.assetRef`,
        path: ["instrumentPool", id, "assetRef"],
        before,
        after,
        affectsPlayback: true,
        structuralPlayback: true,
        renderTargets: ["instrument.context"],
        source: metadata.source,
        transaction: { instrumentId: id, safeBoundaryRequired: true },
      });
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { value: clone(after), before, after: clone(after), mutated: false, changeSet, metadata: clone(metadata) };
      }
      if (after == null) delete instrument.assetRef;
      else instrument.assetRef = clone(after);
      this.publish(changeSet, ["project", "persistence", "audio", "render"]);
      return { value: clone(after), before, after: clone(after), mutated: true, changeSet, metadata: clone(metadata) };
    }

    setProductionInstrumentParameter(instrumentId, parameterKey, value, metadata = {}) {
      const id = productionInstrumentDomain().instrumentId(instrumentId);
      const instrument = this.state.instrumentPool[id];
      if (!instrument) throw new Error(`Production Instrument ${id} does not exist`);
      const key = String(parameterKey ?? "").trim();
      if (!key) throw new TypeError("Production Instrument parameter key must not be empty");
      const before = clone(Object.hasOwn(instrument.parameterSnapshot, key) ? instrument.parameterSnapshot[key] : null);
      const after = clone(value);
      // An ordinary Instrument parameter edit is audible and durable, but it is
      // never a structural program change: it is delivered to the running
      // engine through the dedicated production live-parameter path. Marking it
      // structural made every knob sample also request playback refresh →
      // updatePlan → prepareProgram, which then re-asserted retained prepared
      // full-state over the user's newer value.
      const changeSet = createProjectChangeSet({ subtype: "instrument.parameter", target: `project.instrumentPool.${id}.parameterSnapshot.${key}`, path: ["instrumentPool", id, "parameterSnapshot", key], before, after, affectsPlayback: true, structuralPlayback: false, renderTargets: [`production-instrument.parameter.${id}.${key}`], source: metadata.source, transaction: { ...(metadata.transaction && typeof metadata.transaction === "object" ? metadata.transaction : {}), instrumentId: id, parameterKey: key, transient: metadata.transient === true } });
      if (JSON.stringify(before) === JSON.stringify(after)) return { value: clone(after), before, after: clone(after), mutated: false, changeSet, metadata: clone(metadata) };
      instrument.parameterSnapshot[key] = clone(after);
      this.publish(changeSet, ["project", "persistence", "audio", "render"]);
      return { value: clone(after), before, after: clone(after), mutated: true, changeSet, metadata: clone(metadata) };
    }

    replaceProductionInstrumentPatch(instrumentId, patchState, parameterSnapshot = null, metadata = {}) {
      const id = productionInstrumentDomain().instrumentId(instrumentId);
      const instrument = this.state.instrumentPool[id];
      if (!instrument) throw new Error(`Production Instrument ${id} does not exist`);
      const before = { patchState: clone(instrument.patchState), parameterSnapshot: clone(instrument.parameterSnapshot) };
      const after = {
        patchState: productionInstrumentDomain().normalizePatchState(patchState),
        parameterSnapshot: parameterSnapshot == null ? clone(instrument.parameterSnapshot) : productionInstrumentDomain().normalizeParameterSnapshot(parameterSnapshot),
      };
      const changeSet = createProjectChangeSet({ subtype: "instrument.patch", target: `project.instrumentPool.${id}.patch`, path: ["instrumentPool", id], before, after, affectsPlayback: true, renderTargets: ["instrument.context"], source: metadata.source, transaction: { instrumentId: id, safeBoundaryRequired: true } });
      if (JSON.stringify(before) === JSON.stringify(after)) return { value: clone(after), before, after: clone(after), mutated: false, changeSet, metadata: clone(metadata) };
      instrument.patchState = clone(after.patchState);
      instrument.parameterSnapshot = clone(after.parameterSnapshot);
      this.publish(changeSet, ["project", "persistence", "audio", "render"]);
      return { value: clone(after), before, after: clone(after), mutated: true, changeSet, metadata: clone(metadata) };
    }

    renameProject(value, metadata = {}) {
      const raw = String(value ?? "").trim();
      if (!raw) throw new TypeError("Project name must not be empty");
      const before = String(this.state.projectName);
      const after = normalizeProjectName(raw, before || "UNTITLED 01");
      const changeSet = createProjectChangeSet({ subtype: "identity.name", target: "project.identity.name", path: ["projectName"], before, after, affectsPlayback: false, persistsProject: true, renderTargets: ["project.identity.name"], source: metadata.source });
      if (before === after) return { value: after, before, after, mutated: false, changeSet, metadata: clone(metadata) };
      this.state.projectName = after;
      this.publish(changeSet, ["project", "persistence", "render"]);
      return { value: after, before, after, mutated: true, changeSet, metadata: clone(metadata) };
    }
  }

  class NavigationStore extends ChannelStore {
    constructor(state) {
      if (!state || typeof state !== "object") throw new TypeError("NavigationStore requires runtime state");
      state.p3 ??= {};
      const workspace = normalizeWorkspace(state.p3.activeWorkspace ?? state.view ?? state.focus?.pane);
      state.view = workspace;
      state.p3.activeWorkspace = workspace;
      state.focus = normalizeTrackerCursor(state.focus, { pane: STRUCTURAL_WORKSPACES.includes(workspace) ? workspace : "phrase", row: 0, col: 0 });
      state.p3.parents = (Array.isArray(state.p3.parents) ? state.p3.parents : []).map((context) => normalizeNavigationContext(context, state));
      state.p3.mixReturn = state.p3.mixReturn ? normalizeNavigationContext(state.p3.mixReturn, state) : null;
      super("navigation", state, OWNERSHIP.navigation);
    }

    captureContext() { return normalizeNavigationContext({}, this.state); }

    _applyContext(value) {
      const target = normalizeNavigationContext(value, this.state);
      this.state.view = target.view;
      this.state.dock = target.dock;
      this.state.songRow = target.songRow;
      this.state.track = target.track;
      this.state.chain = target.chain;
      this.state.chainRow = target.chainRow;
      this.state.phrase = target.phrase;
      this.state.phraseRow = target.phraseRow;
      this.state.instrument = target.instrument;
      this.state.focus = clone(target.focus);
      this.state.lastChain = target.lastChain;
      this.state.lastPhrase = target.lastPhrase;
      this.state.p3.soundParam = target.soundParam;
      this.state.p3.activeWorkspace = target.activeWorkspace;
      return target;
    }

    _replaceContext(value, metadata = {}) {
      const before = this.captureContext();
      const after = normalizeNavigationContext(value, this.state);
      const changeSet = createNavigationChangeSet({ subtype: metadata.subtype ?? "context.restore", target: metadata.target ?? "navigation.context.restore", path: metadata.path ?? ["structuralContext"], before, after, renderTargets: metadata.renderTargets ?? ["navigation.workspace", "navigation.context", "navigation.focus"], source: metadata.source });
      if (JSON.stringify(before) === JSON.stringify(after)) return { value: after, before, after, mutated: false, navigationChangeSet: changeSet, metadata: clone(metadata) };
      this._applyContext(after);
      this.emit("navigation", changeSet);
      return { value: after, before, after, mutated: true, navigationChangeSet: changeSet, metadata: clone(metadata) };
    }

    selectWorkspace(value, metadata = {}) {
      const candidate = String(value ?? "").toLowerCase();
      if (!WORKSPACES.includes(candidate)) throw new TypeError(`Unknown workspace: ${value}`);
      const before = normalizeWorkspace(this.state.p3?.activeWorkspace ?? this.state.view);
      const after = candidate;
      const changeSet = createNavigationChangeSet({ subtype: "workspace", target: "navigation.workspace", path: ["activeWorkspace"], before, after, renderTargets: ["navigation.workspace"], source: metadata.source });
      if (before === after) return { value: after, before, after, mutated: false, navigationChangeSet: changeSet, metadata: clone(metadata) };
      this.state.view = after;
      this.state.p3.activeWorkspace = after;
      this.emit("navigation", changeSet);
      return { value: after, before, after, mutated: true, navigationChangeSet: changeSet, metadata: clone(metadata) };
    }

    selectTrackerCursor(value, context = {}, metadata = {}) {
      const beforeContext = this.captureContext();
      const cursor = normalizeTrackerCursor(value, beforeContext.focus);
      const afterContext = normalizeNavigationContext({ ...beforeContext, ...(context && typeof context === "object" ? context : {}), focus: cursor }, this.state);
      const before = { cursor: beforeContext.focus, context: beforeContext };
      const after = { cursor: afterContext.focus, context: afterContext };
      const changeSet = createNavigationChangeSet({ subtype: "trackerCursor", target: metadata.target ?? "navigation.trackerCursor", path: ["trackerCursor"], before, after, renderTargets: ["navigation.focus", "navigation.context"], source: metadata.source });
      if (JSON.stringify(before) === JSON.stringify(after)) return { value: afterContext.focus, before, after, contextBefore: beforeContext, contextAfter: afterContext, mutated: false, navigationChangeSet: changeSet, metadata: clone(metadata) };
      this._applyContext(afterContext);
      this.emit("navigation", changeSet);
      return { value: afterContext.focus, before, after, contextBefore: beforeContext, contextAfter: afterContext, mutated: true, navigationChangeSet: changeSet, metadata: clone(metadata) };
    }

    enterContext(value, metadata = {}) {
      const before = this.captureContext();
      const parent = normalizeNavigationContext(metadata.parent ?? before, this.state);
      const after = normalizeNavigationContext(value, this.state);
      const depthBefore = this.state.p3.parents.length;
      this.state.p3.parents.push(parent);
      this._applyContext(after);
      const depthAfter = this.state.p3.parents.length;
      const changeSet = createNavigationChangeSet({ subtype: "hierarchy.enter", target: metadata.target ?? "navigation.hierarchy.enter", path: ["returnStack"], before: { context: before, depth: depthBefore }, after: { context: after, depth: depthAfter }, renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"], source: metadata.source });
      this.emit("navigation", changeSet);
      return { value: after, before, after, mutated: true, depthBefore, depthAfter, navigationChangeSet: changeSet, metadata: clone(metadata) };
    }

    returnToParent(metadata = {}) {
      const before = this.captureContext();
      const depthBefore = this.state.p3.parents.length;
      const parent = this.state.p3.parents.pop();
      if (!parent) {
        const changeSet = createNavigationChangeSet({ subtype: "hierarchy.return", target: metadata.target ?? "navigation.hierarchy.return", path: ["returnStack"], before: { context: before, depth: depthBefore }, after: { context: before, depth: depthBefore }, renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"], source: metadata.source });
        return { value: before, before, after: before, mutated: false, depthBefore, depthAfter: depthBefore, navigationChangeSet: changeSet, metadata: clone(metadata) };
      }
      const after = this._applyContext(parent);
      const depthAfter = this.state.p3.parents.length;
      const changeSet = createNavigationChangeSet({ subtype: "hierarchy.return", target: metadata.target ?? "navigation.hierarchy.return", path: ["returnStack"], before: { context: before, depth: depthBefore }, after: { context: after, depth: depthAfter }, renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"], source: metadata.source });
      this.emit("navigation", changeSet);
      return { value: after, before, after, mutated: true, depthBefore, depthAfter, navigationChangeSet: changeSet, metadata: clone(metadata) };
    }

    openMix(metadata = {}) {
      const contextBefore = this.captureContext();
      const existingReturn = this.state.p3.mixReturn ? normalizeNavigationContext(this.state.p3.mixReturn, this.state) : null;
      if (contextBefore.activeWorkspace === "mix") {
        const before = { context: contextBefore, returnContext: existingReturn };
        const changeSet = createNavigationChangeSet({ subtype: "mix.open", target: metadata.target ?? "navigation.mix.open", path: ["mixReturn"], before, after: before, renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"], source: metadata.source });
        return { value: contextBefore, before, after: before, contextBefore, contextAfter: contextBefore, returnContext: existingReturn, mutated: false, navigationChangeSet: changeSet, metadata: clone(metadata) };
      }
      const returnContext = normalizeNavigationContext(metadata.returnContext ?? contextBefore, this.state);
      const contextAfter = normalizeNavigationContext({ ...contextBefore, view: "mix", dock: "mix", activeWorkspace: "mix" }, this.state);
      const before = { context: contextBefore, returnContext: existingReturn };
      const after = { context: contextAfter, returnContext };
      const changeSet = createNavigationChangeSet({ subtype: "mix.open", target: metadata.target ?? "navigation.mix.open", path: ["mixReturn"], before, after, renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"], source: metadata.source });
      this.state.p3.mixReturn = clone(returnContext);
      this._applyContext(contextAfter);
      this.emit("navigation", changeSet);
      return { value: contextAfter, before, after, contextBefore, contextAfter, returnContext, mutated: true, navigationChangeSet: changeSet, metadata: clone(metadata) };
    }

    returnFromMix(metadata = {}) {
      const contextBefore = this.captureContext();
      const returnContext = this.state.p3.mixReturn ? normalizeNavigationContext(this.state.p3.mixReturn, this.state) : null;
      const before = { context: contextBefore, returnContext };
      if (contextBefore.activeWorkspace !== "mix" || !returnContext) {
        const changeSet = createNavigationChangeSet({ subtype: "mix.return", target: metadata.target ?? "navigation.mix.return", path: ["mixReturn"], before, after: before, renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"], source: metadata.source });
        return { value: contextBefore, before, after: before, contextBefore, contextAfter: contextBefore, returnContext, mutated: false, navigationChangeSet: changeSet, metadata: clone(metadata) };
      }
      this.state.p3.mixReturn = null;
      const contextAfter = this._applyContext(returnContext);
      const after = { context: contextAfter, returnContext: null };
      const changeSet = createNavigationChangeSet({ subtype: "mix.return", target: metadata.target ?? "navigation.mix.return", path: ["mixReturn"], before, after, renderTargets: ["navigation.workspace", "navigation.context", "navigation.focus"], source: metadata.source });
      this.emit("navigation", changeSet);
      return { value: contextAfter, before, after, contextBefore, contextAfter, returnContext: null, mutated: true, navigationChangeSet: changeSet, metadata: clone(metadata) };
    }

    navigateOccurrence(value, metadata = {}) {
      return this._replaceContext(value, { ...metadata, subtype: "occurrence", target: "navigation.occurrence", path: ["occurrenceContext"], renderTargets: ["navigation.context", "navigation.focus"] });
    }

    restoreContext(value, metadata = {}) { return this._replaceContext(value, metadata); }
  }

  class TransportStore extends ChannelStore {
    constructor(state) { super("transport", state, OWNERSHIP.transport); }
  }

  function createStores({ model, state, trackCount = 8 }) {
    return Object.freeze({ project: new ProjectStore(model, { trackCount }), navigation: new NavigationStore(state), transport: new TransportStore(state), ownership: OWNERSHIP });
  }

  function connectProjectSubscribers(projectStore, subscribers = {}) {
    const unsubscribers = [];
    for (const channel of ["persistence", "audio", "render"]) {
      if (typeof subscribers[channel] === "function") unsubscribers.push(projectStore.subscribe(channel, subscribers[channel]));
    }
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }

  const selectors = Object.freeze({
    projectName: (project) => project.projectName,
    tempo: (project) => project.tempo,
    instrumentPool: (project) => project.instrumentPool,
    productionInstrument: (project, id) => project.instrumentPool?.[Number(id)] ?? null,
    activeWorkspace: (navigation) => normalizeWorkspace(navigation.p3?.activeWorkspace ?? navigation.view),
    trackerCursor: (navigation) => normalizeTrackerCursor(navigation.focus),
    navigationContext: (navigation) => normalizeNavigationContext({}, navigation),
    mixReturnContext: (navigation) => navigation.p3?.mixReturn ? normalizeNavigationContext(navigation.p3.mixReturn, navigation) : null,
    returnDepth: (navigation) => Array.isArray(navigation.p3?.parents) ? navigation.p3.parents.length : 0,
    sourceEnvelope: (project) => ({ schemaVersion: project.schemaVersion, sourceFormat: project.sourceFormat, sourceVersion: project.sourceVersion, sourceMetadata: project.sourceMetadata, unknownData: project.unknownData }),
  });

  const api = Object.freeze({
    PROJECT_SCHEMA_VERSION,
    RETIRED_PREVIEW_EXTENSION_KEYS,
    PROJECT_DOMAINS,
    WORKSPACES,
    STRUCTURAL_WORKSPACES,
    CHANGE_OWNERS,
    OWNERSHIP,
    ProjectStore,
    NavigationStore,
    TransportStore,
    createStores,
    connectProjectSubscribers,
    createStoreChangeSet,
    createProjectChangeSet,
    createNavigationChangeSet,
    createTransportChangeSet,
    normalizeProjectName,
    normalizeProjectState,
    normalizeWorkspace,
    normalizeTrackerCursor,
    normalizeNavigationContext,
    stripRetiredPreviewExtensions,
    selectors,
  });

  globalThis.BRKTRKStoreTypes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();