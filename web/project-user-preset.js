(() => {
  "use strict";

  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  const instrumentDomain = globalThis.BRKTRKProductionInstrumentDomain
    ?? (typeof require === "function" ? require("./production-instrument-domain.js") : null);
  if (!storeTypes || !instrumentDomain) throw new Error("User preset domain requires Store + Instrument domains");

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  const USER_BANK = "User";
  const USER_ORIGIN = "brktrk-user";
  const USER_PRESET_SCHEMA = "brktrk-user-preset-v1";
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
  const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);
  // Bounded like every other project collection: a preset carries opaque engine
  // state, so an unbounded library is an unbounded project file.
  const MAX_USER_PRESETS = 512;
  const MAX_NAME_LENGTH = 64;
  const MAX_CATEGORY_LENGTH = 24;

  // Owner decision (#474): a user preset is pinned to the exact engine package
  // it was captured from, and engines are updated manually. patchState is
  // opaque bytes whose meaning is defined by that build, so a preset saved on
  // another package is not silently reinterpreted - it is reported as
  // unavailable, naming the version it belongs to.
  function engineIdentity(engineRef) {
    if (!isObject(engineRef)) return null;
    const moduleId = String(engineRef.moduleId ?? "").trim();
    const engineId = String(engineRef.engineId ?? "").trim();
    const version = String(engineRef.resolvedVersion ?? engineRef.version ?? "").trim();
    const packageSha256 = String(engineRef.resolvedPackageSha256 ?? engineRef.packageSha256 ?? "").trim().toLowerCase();
    if (!moduleId || !engineId || !version || !/^[0-9a-f]{64}$/.test(packageSha256)) return null;
    return Object.freeze({ moduleId, engineId, version, packageSha256 });
  }

  function sameEngine(left, right) {
    if (!left || !right) return false;
    return left.moduleId === right.moduleId
      && left.engineId === right.engineId
      && left.version === right.version
      && left.packageSha256 === right.packageSha256;
  }

  function normalizeId(value) {
    const id = String(value ?? "").trim();
    if (!id || !SAFE_ID.test(id) || RESERVED_IDS.has(id)) {
      throw new TypeError("user preset id must be a safe 1-96 character identifier");
    }
    return id;
  }

  function normalizeName(value, fallback) {
    const text = String(value ?? "").trim().replace(/\s+/g, " ");
    if (!text) return fallback;
    return text.length > MAX_NAME_LENGTH ? text.slice(0, MAX_NAME_LENGTH) : text;
  }

  // What a musician calls this kind of sound - Bass, Kick, Lead. It groups the
  // row in the preset selector and does nothing else: it takes no part in
  // engine identity, provenance, or the preset's durable id, so renaming or
  // recategorising a preset can never break an Instrument's presetRef. Absent
  // is a real state, and older records simply do not carry one.
  function normalizeCategory(value) {
    const text = String(value ?? "").trim().replace(/\s+/g, " ");
    if (!text) return null;
    return text.length > MAX_CATEGORY_LENGTH ? text.slice(0, MAX_CATEGORY_LENGTH) : text;
  }

  // Deterministic, content-derived and independent of the display name, so
  // renaming never breaks an Instrument's presetRef and a deleted ordinal can
  // never be handed to different content.
  function contentTag(patchState, parameterSnapshot, engine) {
    const text = JSON.stringify([patchState, parameterSnapshot, engine]);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function createDomain(projectStore) {
    if (!projectStore || projectStore.owner !== "project") throw new TypeError("User preset domain requires ProjectStore");
    const project = projectStore.getState();

    const presets = () => {
      if (!isObject(project.presets)) project.presets = {};
      return project.presets;
    };

    function occupied(id) {
      return Object.hasOwn(presets(), String(id));
    }

    function record(id) {
      const key = String(id);
      if (!Object.hasOwn(presets(), key)) return null;
      const stored = presets()[key];
      return isObject(stored) && stored.schema === USER_PRESET_SCHEMA ? stored : null;
    }

    function userRows() {
      return Object.values(presets()).filter((entry) => isObject(entry) && entry.schema === USER_PRESET_SCHEMA);
    }

    function nextId(patchState, parameterSnapshot, engine) {
      const tag = contentTag(patchState, parameterSnapshot, engine);
      const base = `user-${tag}`;
      if (!occupied(base)) return base;
      // Identical content saved twice is a real thing a musician may do, so the
      // second one gets its own id rather than overwriting the first. Foreign
      // records sharing project.presets also count as occupied keys.
      for (let suffix = 2; suffix <= MAX_USER_PRESETS + 1; suffix += 1) {
        const candidate = `${base}-${suffix}`;
        if (!occupied(candidate)) return candidate;
      }
      throw new RangeError("user preset id space for this exact state is exhausted");
    }

    // The shape package presets already have, so the existing preset surface
    // and the canonical instrumentPresets.apply() consume a user preset
    // unchanged - no second load path.
    function present(stored, engine) {
      const applicable = sameEngine(stored.engine, engine);
      return Object.freeze({
        id: stored.id,
        name: stored.name,
        category: stored.category ?? null,
        bank: USER_BANK,
        origin: USER_ORIGIN,
        readOnly: false,
        applicable,
        unavailableReason: applicable ? null : "engine-version-mismatch",
        missingParameters: Object.freeze([]),
        savedForEngine: Object.freeze({ ...stored.engine }),
        sourcePresetRef: isObject(stored.sourcePresetRef) ? Object.freeze(clone(stored.sourcePresetRef)) : null,
        stateSchemaVersion: stored.stateSchemaVersion,
        patchState: Object.freeze(clone(stored.patchState)),
        parameterSnapshot: Object.freeze(clone(stored.parameterSnapshot)),
      });
    }

    function save(instrumentIdValue, metadata = {}) {
      const instrumentId = instrumentDomain.instrumentId(instrumentIdValue);
      const instrument = project.instrumentPool?.[instrumentId];
      if (!instrument) throw new Error(`Production Instrument ${instrumentId} does not exist`);
      const engine = engineIdentity(instrument.engineRef);
      if (!engine) throw new TypeError("Production Instrument must carry exact resolved version + package SHA before a preset can be saved");

      const library = presets();
      if (userRows().length >= MAX_USER_PRESETS) {
        throw new RangeError(`project user preset library is limited to ${MAX_USER_PRESETS} presets`);
      }

      const patchState = instrumentDomain.normalizePatchState(instrument.patchState);
      const parameterSnapshot = instrumentDomain.normalizeParameterSnapshot(instrument.parameterSnapshot);
      const requestedId = String(metadata.id ?? "").trim();
      const id = requestedId ? normalizeId(requestedId) : nextId(patchState, parameterSnapshot, engine);
      if (occupied(id)) throw new Error(`project preset key ${id} already exists`);
      const name = normalizeName(metadata.name, instrument.name ? `${instrument.name} ${id.slice(-4)}` : id);
      const category = normalizeCategory(metadata.category);

      const stored = {
        schema: USER_PRESET_SCHEMA,
        id,
        name,
        category,
        bank: USER_BANK,
        origin: USER_ORIGIN,
        engine: { ...engine },
        sourcePresetRef: isObject(instrument.presetRef) ? clone(instrument.presetRef) : null,
        // Recorded even though the pin is exact: it is what a later
        // compatibility policy would need, and it costs nothing now.
        stateSchemaVersion: Number(patchState.schemaVersion ?? 0),
        patchState: clone(patchState),
        parameterSnapshot: clone(parameterSnapshot),
      };

      const changeSet = storeTypes.createProjectChangeSet({
        subtype: "presets.user.save",
        target: `project.presets.${id}`,
        path: ["presets", id],
        before: null,
        after: clone(stored),
        // Saving captures what is already sounding. It adds nothing to the
        // program, so it must not re-issue the transport: a structural change
        // here would restart playback mid-performance.
        affectsPlayback: false,
        structuralPlayback: false,
        persistsProject: true,
        // The library, not the Instrument. instrument.context drives the full
        // Instrument render, which replaces the inspector and re-verifies the
        // engine package - far too much for a metadata edit that leaves the
        // sounding Instrument untouched, and it destroys the preset panel
        // mid-mutation.
        renderTargets: ["instrument.presets"],
        source: metadata.source,
        transaction: { instrumentId, presetId: id },
      });

      library[id] = clone(stored);
      projectStore.publish(changeSet, ["project", "persistence", "render"]);
      return Object.freeze({ value: Object.freeze(clone(stored)), mutated: true, changeSet });
    }

    function remove(presetIdValue, metadata = {}) {
      const id = normalizeId(presetIdValue);
      const stored = record(id);
      if (!stored) throw new Error(`user preset ${id || "(empty)"} does not exist`);
      const before = clone(stored);
      const changeSet = storeTypes.createProjectChangeSet({
        subtype: "presets.user.remove",
        target: `project.presets.${id}`,
        path: ["presets", id],
        before,
        after: null,
        affectsPlayback: false,
        structuralPlayback: false,
        persistsProject: true,
        renderTargets: ["instrument.presets"],
        source: metadata.source,
        transaction: { presetId: id },
      });
      delete presets()[id];
      projectStore.publish(changeSet, ["project", "persistence", "render"]);
      return Object.freeze({ value: Object.freeze(before), mutated: true, changeSet });
    }

    function rename(presetIdValue, nextName, metadata = {}) {
      const id = normalizeId(presetIdValue);
      const stored = record(id);
      if (!stored) throw new Error(`user preset ${id || "(empty)"} does not exist`);
      const name = normalizeName(nextName, stored.name);
      if (name === stored.name) {
        return Object.freeze({ value: Object.freeze(clone(stored)), mutated: false, changeSet: null });
      }
      const before = clone(stored);
      const after = { ...clone(stored), name };
      const changeSet = storeTypes.createProjectChangeSet({
        subtype: "presets.user.rename",
        target: `project.presets.${id}.name`,
        path: ["presets", id, "name"],
        before: before.name,
        after: name,
        affectsPlayback: false,
        structuralPlayback: false,
        persistsProject: true,
        renderTargets: ["instrument.presets"],
        source: metadata.source,
        transaction: { presetId: id },
      });
      presets()[id].name = name;
      projectStore.publish(changeSet, ["project", "persistence", "render"]);
      return Object.freeze({ value: Object.freeze(after), mutated: true, changeSet });
    }

    function overwrite(presetIdValue, instrumentIdValue, metadata = {}) {
      const id = normalizeId(presetIdValue);
      const stored = record(id);
      if (!stored) throw new Error(`user preset ${id || "(empty)"} does not exist`);

      const instrumentId = instrumentDomain.instrumentId(instrumentIdValue);
      const instrument = project.instrumentPool?.[instrumentId];
      if (!instrument) throw new Error(`Production Instrument ${instrumentId} does not exist`);

      const engine = engineIdentity(instrument.engineRef);
      if (!engine) throw new TypeError("Production Instrument must carry exact resolved version + package SHA before a preset can be overwritten");
      if (!sameEngine(stored.engine, engine)) {
        throw new Error(`user preset ${id} belongs to a different exact engine package; save a new preset instead`);
      }

      const patchState = instrumentDomain.normalizePatchState(instrument.patchState);
      const parameterSnapshot = instrumentDomain.normalizeParameterSnapshot(instrument.parameterSnapshot);
      const before = clone(stored);
      // Overwriting recaptures the sound. The category is the musician's own
      // filing label, so it is carried over untouched unless this call names
      // one - an absent key is "leave it alone", not "clear it".
      const category = Object.prototype.hasOwnProperty.call(metadata, "category")
        ? normalizeCategory(metadata.category)
        : (stored.category ?? null);
      const after = {
        ...clone(stored),
        category,
        engine: { ...engine },
        // Preserve the preset's original source provenance. A loaded user
        // preset points instrument.presetRef back to itself, which is not useful
        // source metadata and must not replace the original factory/source ref.
        sourcePresetRef: isObject(stored.sourcePresetRef) ? clone(stored.sourcePresetRef) : null,
        stateSchemaVersion: Number(patchState.schemaVersion ?? 0),
        patchState: clone(patchState),
        parameterSnapshot: clone(parameterSnapshot),
      };
      const changeSet = storeTypes.createProjectChangeSet({
        subtype: "presets.user.overwrite",
        target: `project.presets.${id}`,
        path: ["presets", id],
        before,
        after: clone(after),
        affectsPlayback: false,
        structuralPlayback: false,
        persistsProject: true,
        renderTargets: ["instrument.presets"],
        source: metadata.source,
        transaction: { instrumentId, presetId: id },
      });

      presets()[id] = clone(after);
      projectStore.publish(changeSet, ["project", "persistence", "render"]);
      return Object.freeze({ value: Object.freeze(clone(after)), mutated: true, changeSet });
    }

    // Every stored preset, in stable name order, each carrying whether this
    // engine can load it. The caller decides how to present a mismatch; this
    // domain never hides one.
    function libraryFor(engineRef) {
      const engine = engineIdentity(engineRef);
      const stored = userRows();
      const rows = stored
        .filter((entry) => typeof entry.id === "string" && SAFE_ID.test(entry.id) && !RESERVED_IDS.has(entry.id))
        .map((entry) => present(entry, engine))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : 1));
      return Object.freeze({
        schema: "brktrk-user-preset-library-v1",
        bank: USER_BANK,
        presetCount: rows.length,
        applicableCount: rows.filter((row) => row.applicable).length,
        presets: Object.freeze(rows),
      });
    }

    function snapshot() {
      const rows = userRows();
      return Object.freeze({
        version: 1,
        owner: "project-user-preset",
        bank: USER_BANK,
        limit: MAX_USER_PRESETS,
        presetCount: rows.length,
        engines: Object.freeze([...new Set(rows.map((row) => `${row.engine?.moduleId}/${row.engine?.engineId}@${row.engine?.version}`))]),
      });
    }

    return Object.freeze({ save, remove, rename, overwrite, libraryFor, snapshot });
  }

  function install(projectStore) {
    if (projectStore.userPresets) return projectStore.userPresets;
    const domain = createDomain(projectStore);
    Object.defineProperty(projectStore, "userPresets", { value: domain, configurable: false, enumerable: true, writable: false });
    return domain;
  }

  const api = Object.freeze({ install, createDomain, engineIdentity, sameEngine, USER_BANK, USER_ORIGIN, USER_PRESET_SCHEMA, MAX_USER_PRESETS });
  globalThis.BRKTRKProjectUserPreset = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
