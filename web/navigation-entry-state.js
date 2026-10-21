(() => {
  const root = globalThis;
  if (root.BRKTRKNavigationEntryState) {
    if (typeof module !== "undefined" && module.exports) module.exports = root.BRKTRKNavigationEntryState;
    return;
  }

  const types = root.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  if (!types?.createNavigationChangeSet) throw new Error("Navigation entry state requires Store types");

  const SHEETS = Object.freeze(["note", "value", "context", "follow-scope"]);
  const STRUCTURAL_PANES = Object.freeze(["song", "chain", "phrase"]);
  const EDIT_STEPS = Object.freeze([0, 1, 2, 4]);
  const PREPARED_FIELDS = Object.freeze(["velocity", "instrument", "octave", "editStep", "preview", "applying", "locked"]);
  const COMPATIBILITY_ALIASES = Object.freeze({
    noteOctave: "octave",
    editStep: "editStep",
  });
  const RETIRED_COMPATIBILITY_ALIASES = Object.freeze([
    "nextVelocity",
    "nextInstrument",
    "notePreview",
    "applyPreparedEntry",
  ]);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const integerOr = (value, fallback) => Number.isInteger(value) ? value : fallback;

  function normalizeSheet(value, fallback = null) {
    if (value == null || value === "" || value === "none") return null;
    const candidate = String(value).toLowerCase();
    if (SHEETS.includes(candidate)) return candidate;
    if (fallback == null) return null;
    const normalizedFallback = String(fallback).toLowerCase();
    return SHEETS.includes(normalizedFallback) ? normalizedFallback : null;
  }

  function normalizeCursor(value) {
    if (!value || typeof value !== "object" || !STRUCTURAL_PANES.includes(value.pane)) return null;
    const row = Number(value.row);
    const col = Number(value.col);
    if (!Number.isInteger(row) || row < 0 || !Number.isInteger(col) || col < 0) return null;
    return { pane: value.pane, row, col };
  }

  function normalizeValueReturn(value = {}) {
    const source = value && typeof value === "object" ? value : {};
    const returnSheet = normalizeSheet(source.returnSheet);
    return {
      originCursor: normalizeCursor(source.originCursor),
      returnSheet: returnSheet === "value" ? null : returnSheet,
      returnCursor: normalizeCursor(source.returnCursor),
    };
  }

  function normalizePreparedEntry(value = {}, state = {}) {
    const source = value && typeof value === "object" ? value : {};
    const p3 = state.p3 && typeof state.p3 === "object" ? state.p3 : {};
    const fallbackInstrument = integerOr(state.instrument, 0);
    const rawEditStep = integerOr(source.editStep, integerOr(p3.editStep, 1));
    return {
      velocity: clamp(integerOr(source.velocity, integerOr(p3.nextVelocity, 100)), 1, 127),
      instrument: clamp(integerOr(source.instrument, integerOr(p3.nextInstrument, fallbackInstrument)), -1, 15),
      octave: clamp(integerOr(source.octave, integerOr(p3.noteOctave, 4)), -1, 9),
      editStep: EDIT_STEPS.includes(rawEditStep) ? rawEditStep : 1,
      preview: Object.hasOwn(source, "preview") ? Boolean(source.preview)
        : Object.hasOwn(p3, "notePreview") ? Boolean(p3.notePreview) : true,
      applying: Object.hasOwn(source, "applying") ? Boolean(source.applying)
        : Boolean(p3.applyPreparedEntry),
      locked: Boolean(source.locked),
    };
  }

  function preparedPairFromStep(step = {}) {
    const source = step && typeof step === "object" ? step : {};
    return Object.freeze({
      velocity: clamp(integerOr(source.velocity, 100), 1, 127),
      instrument: clamp(integerOr(source.instrument, -1), -1, 15),
    });
  }

  function transitionPreparedLock(prepared, step, nextLocked) {
    const current = normalizePreparedEntry(prepared ?? {}, {});
    if (Boolean(nextLocked)) return Object.freeze({ ...current, locked: true });
    return Object.freeze({ ...current, ...preparedPairFromStep(step), locked: false });
  }

  function transitionLockedFieldEdit(prepared, step, field, delta) {
    if (!["velocity", "instrument"].includes(field)) throw new TypeError(`Unknown locked prepared field: ${field}`);
    const current = normalizePreparedEntry(prepared ?? {}, {});
    const rowPair = preparedPairFromStep(step);
    const min = field === "velocity" ? 1 : -1;
    const max = field === "velocity" ? 127 : 15;
    const value = clamp(Math.round(Number(current[field]) + Number(delta || 0)), min, max);
    return Object.freeze({
      field,
      value,
      prepared: Object.freeze({ ...current, ...rowPair, [field]: value, locked: false }),
    });
  }

  function transitionLockedExactCommit(prepared, step) {
    const current = normalizePreparedEntry(prepared ?? {}, {});
    return Object.freeze({ ...current, ...preparedPairFromStep(step), locked: false });
  }

  function initialSheet(state) {
    const p3 = state.p3 ?? {};
    if (p3.activeSheet != null) return normalizeSheet(p3.activeSheet);
    if (p3.noteDockOpen) return "note";
    return null;
  }

  function install(navigationStore) {
    if (!navigationStore?.state || typeof navigationStore.emit !== "function") {
      throw new TypeError("Navigation entry state requires a NavigationStore instance");
    }
    if (navigationStore.entryState) return navigationStore.entryState;

    const state = navigationStore.state;
    state.p3 ??= {};
    const legacyPrepared = normalizePreparedEntry(state.p3.preparedEntry, state);
    const legacySheet = initialSheet(state);
    state.p3.activeSheet = legacySheet;
    state.p3.preparedEntry = legacyPrepared;
    state.p3.valueReturn = normalizeValueReturn(state.p3.valueReturn);
    for (const retiredKey of RETIRED_COMPATIBILITY_ALIASES) delete state.p3[retiredKey];

    function navigationChange(subtype, target, path, before, after, renderTargets, metadata = {}) {
      return types.createNavigationChangeSet({
        subtype,
        target,
        path,
        before,
        after,
        renderTargets,
        source: metadata.source,
        transaction: metadata.transaction ?? null,
      });
    }

    function setPreparedEntry(value, metadata = {}) {
      const before = clone(state.p3.preparedEntry);
      const patch = value && typeof value === "object" ? value : {};
      const after = normalizePreparedEntry({ ...before, ...patch }, state);
      const navigationChangeSet = navigationChange(
        "preparedEntry", "navigation.preparedEntry", ["preparedEntry"], before, after,
        ["navigation.preparedEntry"], metadata,
      );
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { value: after, before, after, mutated: false, navigationChangeSet, metadata: clone(metadata) };
      }
      state.p3.preparedEntry = after;
      navigationStore.emit("navigation", navigationChangeSet);
      return { value: after, before, after, mutated: true, navigationChangeSet, metadata: clone(metadata) };
    }

    function setPreparedValue(key, value, metadata = {}) {
      if (!PREPARED_FIELDS.includes(key)) throw new TypeError(`Unknown prepared-entry field: ${key}`);
      return setPreparedEntry({ [key]: value }, metadata);
    }

    function setPreparedLock(value, metadata = {}) {
      return setPreparedValue("locked", Boolean(value), metadata);
    }

    function setValueReturn(value, metadata = {}) {
      const before = clone(state.p3.valueReturn);
      const after = normalizeValueReturn(value);
      const navigationChangeSet = navigationChange(
        "valueReturn", "navigation.valueReturn", ["valueReturn"], before, after,
        ["navigation.valueReturn"], metadata,
      );
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { value: after, before, after, mutated: false, navigationChangeSet, metadata: clone(metadata) };
      }
      state.p3.valueReturn = after;
      navigationStore.emit("navigation", navigationChangeSet);
      return { value: after, before, after, mutated: true, navigationChangeSet, metadata: clone(metadata) };
    }

    function setActiveSheet(value, metadata = {}) {
      const before = normalizeSheet(state.p3.activeSheet);
      const after = normalizeSheet(value);
      if (value != null && after == null) throw new TypeError(`Unknown active sheet: ${value}`);

      const valueReturnMutation = before === "value" && after !== "value" && metadata.preserveValueReturn !== true
        ? setValueReturn(null, {
          ...metadata,
          source: metadata.returnSource ?? `${metadata.source ?? "sheet-change"}.return-clear`,
        })
        : null;
      const navigationChangeSet = navigationChange(
        "activeSheet", "navigation.activeSheet", ["activeSheet"], before, after,
        ["navigation.activeSheet"], metadata,
      );
      if (before === after) {
        return {
          value: after,
          before,
          after,
          mutated: Boolean(valueReturnMutation?.mutated),
          valueReturnMutation,
          navigationChangeSet,
          metadata: clone(metadata),
        };
      }
      state.p3.activeSheet = after;
      navigationStore.emit("navigation", navigationChangeSet);
      return {
        value: after,
        before,
        after,
        mutated: true,
        valueReturnMutation,
        navigationChangeSet,
        metadata: clone(metadata),
      };
    }

    function closeSheet(sheet = null, metadata = {}) {
      const current = normalizeSheet(state.p3.activeSheet);
      if (sheet != null && normalizeSheet(sheet) !== current) {
        const navigationChangeSet = navigationChange(
          "activeSheet", "navigation.activeSheet", ["activeSheet"], current, current,
          ["navigation.activeSheet"], metadata,
        );
        return { value: current, before: current, after: current, mutated: false, navigationChangeSet, metadata: clone(metadata) };
      }
      return setActiveSheet(null, metadata);
    }

    function openValueSheet(valueReturn = {}, metadata = {}) {
      const valueReturnMutation = setValueReturn(valueReturn, {
        ...metadata,
        source: metadata.returnSource ?? `${metadata.source ?? "value-sheet-open"}.return`,
      });
      const sheetMutation = setActiveSheet("value", metadata);
      return {
        value: "value",
        returnTarget: clone(state.p3.valueReturn),
        before: sheetMutation.before,
        after: sheetMutation.after,
        mutated: valueReturnMutation.mutated || sheetMutation.mutated,
        valueReturnMutation,
        sheetMutation,
        navigationChangeSet: sheetMutation.navigationChangeSet,
        metadata: clone(metadata),
      };
    }

    function closeValueSheet(metadata = {}) {
      const returnTarget = clone(state.p3.valueReturn);
      const sheetMutation = closeSheet("value", { ...metadata, preserveValueReturn: true });
      const valueReturnMutation = setValueReturn(null, {
        ...metadata,
        source: metadata.returnSource ?? `${metadata.source ?? "value-sheet-close"}.return-clear`,
      });
      return {
        value: sheetMutation.after,
        returnTarget,
        before: sheetMutation.before,
        after: sheetMutation.after,
        mutated: sheetMutation.mutated || valueReturnMutation.mutated,
        valueReturnMutation,
        sheetMutation,
        navigationChangeSet: sheetMutation.navigationChangeSet,
        metadata: clone(metadata),
      };
    }

    const domain = Object.freeze({
      getActiveSheet: () => normalizeSheet(state.p3.activeSheet),
      getPreparedEntry: () => clone(state.p3.preparedEntry),
      getValueReturn: () => clone(state.p3.valueReturn),
      setActiveSheet,
      openSheet: setActiveSheet,
      closeSheet,
      closeAll: (metadata = {}) => setActiveSheet(null, metadata),
      setPreparedEntry,
      setPreparedValue,
      setPreparedLock,
      setValueReturn,
      openValueSheet,
      closeValueSheet,
      compatibilityAliases: COMPATIBILITY_ALIASES,
      retiredCompatibilityAliases: RETIRED_COMPATIBILITY_ALIASES,
    });

    Object.defineProperty(navigationStore, "entryState", {
      value: domain,
      enumerable: true,
      configurable: false,
      writable: false,
    });

    for (const [legacyKey, preparedKey] of Object.entries(COMPATIBILITY_ALIASES)) {
      Object.defineProperty(state.p3, legacyKey, {
        enumerable: true,
        configurable: true,
        get: () => state.p3.preparedEntry[preparedKey],
        set: (value) => domain.setPreparedValue(preparedKey, value, { source: `compatibility.${legacyKey}` }),
      });
    }
    Object.defineProperty(state.p3, "noteDockOpen", {
      enumerable: true,
      configurable: true,
      get: () => state.p3.activeSheet === "note",
      set: (value) => {
        if (Boolean(value)) domain.openSheet("note", { source: "compatibility.noteDockOpen" });
        else domain.closeSheet("note", { source: "compatibility.noteDockOpen" });
      },
    });

    return domain;
  }

  const api = Object.freeze({
    SHEETS,
    STRUCTURAL_PANES,
    EDIT_STEPS,
    PREPARED_FIELDS,
    COMPATIBILITY_ALIASES,
    RETIRED_COMPATIBILITY_ALIASES,
    normalizeSheet,
    normalizeCursor,
    normalizeValueReturn,
    normalizePreparedEntry,
    preparedPairFromStep,
    transitionPreparedLock,
    transitionLockedFieldEdit,
    transitionLockedExactCommit,
    install,
  });
  root.BRKTRKNavigationEntryState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
