(() => {
  const storeTypes = globalThis.BRKTRKStoreTypes
    ?? (typeof require === "function" ? require("./stores.js") : null);
  const fxTypes = globalThis.BRKTRKPhraseFxDomain
    ?? (typeof require === "function" ? require("./phrase-fx-domain.js") : null);
  const parameterEventTypes = globalThis.BRKTRKParameterEventDomain
    ?? (typeof require === "function" ? require("./parameter-event-domain.js") : null);
  if (!storeTypes) throw new Error("ProjectStore types are required for Phrase-step ownership");
  if (!fxTypes) throw new Error("Phrase FX domain is required for Phrase-step ownership");
  if (!parameterEventTypes) throw new Error("ParameterEvent domain is required for Phrase-step ownership");

  const EMPTY = -1;
  const NOTE_OFF = -2;
  const PHRASE_ROWS = 16;
  const MAX_PHRASE_ID = 255;
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const integer = (value, label) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new TypeError(`${label} must be numeric`);
    return Math.round(numeric);
  };

  function normalizePhraseId(value) {
    return clamp(integer(value, "Phrase ID"), 0, MAX_PHRASE_ID);
  }

  function normalizeRow(value) {
    return clamp(integer(value, "Phrase row"), 0, PHRASE_ROWS - 1);
  }

  function normalizeFxIndex(value) {
    return clamp(integer(value, "FX slot"), 0, fxTypes.SLOT_COUNT - 1);
  }

  function normalizeNote(value) {
    const numeric = integer(value, "Note");
    if (numeric < 0) return clamp(numeric, NOTE_OFF, EMPTY);
    return clamp(numeric, 0, 127);
  }

  function normalizeVelocity(value) {
    return clamp(integer(value, "Velocity"), 1, 127);
  }

  function normalizeInstrument(value, project) {
    const numeric = integer(value, "Instrument");
    if (numeric < 0) return EMPTY;
    const max = Math.max(0, (project.instruments?.length ?? 16) - 1);
    return clamp(numeric, 0, Math.min(255, max));
  }

  function normalizeStoredInstrument(value) {
    const numeric = integer(value, "Stored Instrument");
    if (numeric < 0) return EMPTY;
    return clamp(numeric, 0, 255);
  }

  function normalizeCondition(value = {}) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const probability = clamp(integer(source.probability ?? 100, "Condition probability"), 0, 100);
    const every = clamp(integer(source.every ?? 1, "Condition every"), 1, 16);
    const offset = clamp(integer(source.offset ?? 0, "Condition offset"), 0, every - 1);
    return { probability, every, offset };
  }

  function normalizeStep(step = {}, project) {
    return {
      note: normalizeNote(step.note ?? EMPTY),
      velocity: normalizeVelocity(step.velocity ?? 100),
      instrument: normalizeInstrument(step.instrument ?? EMPTY, project),
    };
  }

  function fullStepSnapshot(step = {}) {
    return {
      note: normalizeNote(step.note ?? EMPTY),
      velocity: normalizeVelocity(step.velocity ?? 100),
      instrument: normalizeStoredInstrument(step.instrument ?? EMPTY),
      fx: fxTypes.serializeSlots(step.fx ?? []),
      condition: normalizeCondition(step.condition),
      parameterEvents: parameterEventTypes.serializeParameterEvents(step.parameterEvents ?? []),
    };
  }

  function emptyStepSnapshot() {
    return fullStepSnapshot({
      note: EMPTY,
      velocity: 100,
      instrument: EMPTY,
      fx: Array.from({ length: fxTypes.SLOT_COUNT }, () => ({ command: 0, value: 0 })),
      condition: normalizeCondition(),
      parameterEvents: [],
    });
  }

  function phraseStep(project, phraseId, row) {
    const phrase = project.phrases?.[phraseId];
    if (!Array.isArray(phrase)) throw new RangeError(`Phrase ${phraseId} does not exist`);
    const step = phrase[row];
    if (!step || typeof step !== "object") throw new RangeError(`Phrase ${phraseId} row ${row} does not exist`);
    return step;
  }

  function renderTargets(phraseId, row, instrumentChanged = false) {
    const targets = [`phrase.row.${phraseId}.${row}`, "note.editor"];
    if (instrumentChanged) targets.push("instrument.context");
    return targets;
  }

  function rowRangeRenderTargets(phraseId, startRow, beforeRows, afterRows) {
    const targets = new Set(["note.editor", "value.dock"]);
    for (let index = 0; index < afterRows.length; index += 1) {
      targets.add(`phrase.row.${phraseId}.${startRow + index}`);
      if (beforeRows[index]?.instrument !== afterRows[index]?.instrument) targets.add("instrument.context");
    }
    return [...targets];
  }

  function fxRenderTargets(phraseId, row) {
    return [`phrase.row.${phraseId}.${row}`, "value.dock"];
  }

  function conditionRenderTargets(phraseId, row) {
    return [`phrase.row.${phraseId}.${row}`, "value.dock"];
  }

  function parameterEventRenderTargets(phraseId, row) {
    return [`phrase.row.${phraseId}.${row}`, "value.dock"];
  }

  function publish(projectStore, changeSet, channels = ["project", "persistence", "audio", "render"]) {
    projectStore.publish(changeSet, channels);
  }

  function createDomain(projectStore) {
    if (!projectStore || projectStore.owner !== "project") throw new TypeError("Phrase-step domain requires ProjectStore");
    const project = projectStore.getState();

    function read(phraseIdValue, rowValue) {
      const phraseId = normalizePhraseId(phraseIdValue);
      const row = normalizeRow(rowValue);
      return fullStepSnapshot(phraseStep(project, phraseId, row));
    }

    function readFxSlot(phraseIdValue, rowValue, slotValue) {
      const phraseId = normalizePhraseId(phraseIdValue);
      const row = normalizeRow(rowValue);
      const slot = normalizeFxIndex(slotValue);
      return fxTypes.serializeSlot(phraseStep(project, phraseId, row).fx?.[slot] ?? 0);
    }

    function setField(phraseIdValue, rowValue, field, value, metadata = {}) {
      const phraseId = normalizePhraseId(phraseIdValue);
      const row = normalizeRow(rowValue);
      if (!["note", "velocity", "instrument"].includes(field)) throw new TypeError(`Unsupported Phrase-step field: ${field}`);
      const step = phraseStep(project, phraseId, row);
      const before = step[field];
      const after = field === "note"
        ? normalizeNote(value)
        : field === "velocity"
          ? normalizeVelocity(value)
          : normalizeInstrument(value, project);
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "note",
        subtype: `phrase.${field}`,
        target: `phrase.${field}`,
        path: ["phrases", phraseId, row, field],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: renderTargets(phraseId, row, field === "instrument" && before !== after),
        source: metadata.source,
        transaction: metadata.transaction,
      });
      if (before === after) {
        return { value: after, before, after, mutated: false, changeSet, metadata: clone(metadata), phraseId, row, field };
      }
      step[field] = after;
      publish(projectStore, changeSet);
      return { value: after, before, after, mutated: true, changeSet, metadata: clone(metadata), phraseId, row, field };
    }

    function ensureFxArray(step) {
      if (!Array.isArray(step.fx)) step.fx = [];
      while (step.fx.length < fxTypes.SLOT_COUNT) step.fx.push({ command: 0, value: 0 });
      return step.fx;
    }

    function applyFxMutation({ phraseId, row, slot, beforeSlot, afterSlot, changeSet, metadata, value }) {
      const mutated = beforeSlot.command !== afterSlot.command || beforeSlot.value !== afterSlot.value;
      if (mutated) {
        const step = phraseStep(project, phraseId, row);
        ensureFxArray(step)[slot] = { ...afterSlot };
        publish(projectStore, changeSet);
      }
      return {
        value,
        before: changeSet.before,
        after: changeSet.after,
        slotValue: afterSlot,
        mutated,
        changeSet,
        metadata: clone(metadata),
        phraseId,
        row,
        slot,
      };
    }

    function setCondition(phraseIdValue, rowValue, value, metadata = {}) {
      const phraseId = normalizePhraseId(phraseIdValue);
      const row = normalizeRow(rowValue);
      const step = phraseStep(project, phraseId, row);
      const before = normalizeCondition(step.condition);
      const after = normalizeCondition(value);
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "parameter",
        subtype: "phrase.condition",
        target: "phrase.condition",
        path: ["phrases", phraseId, row, "condition"],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: conditionRenderTargets(phraseId, row),
        source: metadata.source,
        transaction: metadata.transaction ?? null,
      });
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { value: after, before, after, mutated: false, changeSet, metadata: clone(metadata), phraseId, row };
      }
      step.condition = { ...after };
      publish(projectStore, changeSet);
      return { value: after, before, after, mutated: true, changeSet, metadata: clone(metadata), phraseId, row };
    }

    function readParameterEvents(phraseIdValue, rowValue) {
      const phraseId = normalizePhraseId(phraseIdValue);
      const row = normalizeRow(rowValue);
      return parameterEventTypes.serializeParameterEvents(phraseStep(project, phraseId, row).parameterEvents ?? []);
    }

    function setParameterEvents(phraseIdValue, rowValue, value, metadata = {}) {
      const phraseId = normalizePhraseId(phraseIdValue);
      const row = normalizeRow(rowValue);
      const step = phraseStep(project, phraseId, row);
      const before = readParameterEvents(phraseId, row);
      const after = parameterEventTypes.serializeParameterEvents(value);
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "parameter",
        subtype: "phrase.parameterEvents",
        target: "phrase.parameterEvents",
        path: ["phrases", phraseId, row, "parameterEvents"],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: parameterEventRenderTargets(phraseId, row),
        source: metadata.source,
        transaction: metadata.transaction ?? null,
      });
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { value: after, before, after, mutated: false, changeSet, metadata: clone(metadata), phraseId, row };
      }
      step.parameterEvents = after.map((event) => ({ ...event }));
      publish(projectStore, changeSet);
      return { value: after, before, after, mutated: true, changeSet, metadata: clone(metadata), phraseId, row };
    }

    function setFxSlot(phraseIdValue, rowValue, slotValue, value, metadata = {}) {
      const phraseId = normalizePhraseId(phraseIdValue);
      const row = normalizeRow(rowValue);
      const slot = normalizeFxIndex(slotValue);
      const beforeSlot = readFxSlot(phraseId, row, slot);
      const afterSlot = fxTypes.serializeSlot(value);
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "parameter",
        subtype: "phrase.fx.slot",
        target: "phrase.fx",
        path: ["phrases", phraseId, row, "fx", slot],
        before: beforeSlot,
        after: afterSlot,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: fxRenderTargets(phraseId, row),
        source: metadata.source,
        transaction: metadata.transaction ?? null,
      });
      return applyFxMutation({
        phraseId,
        row,
        slot,
        beforeSlot,
        afterSlot,
        changeSet,
        metadata,
        value: afterSlot,
      });
    }

    function setFxComponent(phraseIdValue, rowValue, slotValue, component, value, metadata = {}) {
      if (!["command", "value"].includes(component)) throw new TypeError(`Unsupported Phrase FX component: ${component}`);
      const phraseId = normalizePhraseId(phraseIdValue);
      const row = normalizeRow(rowValue);
      const slot = normalizeFxIndex(slotValue);
      const beforeSlot = readFxSlot(phraseId, row, slot);
      const requested = component === "command"
        ? { command: integer(value, "FX command"), value: beforeSlot.value }
        : { command: beforeSlot.command, value: integer(value, "FX value") };
      const afterSlot = fxTypes.serializeSlot(requested);
      const before = beforeSlot[component];
      const after = afterSlot[component];
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "parameter",
        subtype: `phrase.fx.${component}`,
        target: `phrase.fx.${component}`,
        path: ["phrases", phraseId, row, "fx", slot, component],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: fxRenderTargets(phraseId, row),
        source: metadata.source,
        transaction: metadata.transaction ?? null,
      });
      return {
        ...applyFxMutation({
          phraseId,
          row,
          slot,
          beforeSlot,
          afterSlot,
          changeSet,
          metadata,
          value: after,
        }),
        component,
      };
    }

    function writeStep(phraseIdValue, rowValue, patch = {}, metadata = {}) {
      const phraseId = normalizePhraseId(phraseIdValue);
      const row = normalizeRow(rowValue);
      const step = phraseStep(project, phraseId, row);
      const before = normalizeStep(step, project);
      const candidate = normalizeStep({
        note: Object.hasOwn(patch, "note") ? patch.note : before.note,
        velocity: Object.hasOwn(patch, "velocity") ? patch.velocity : before.velocity,
        instrument: Object.hasOwn(patch, "instrument") ? patch.instrument : before.instrument,
      }, project);
      const after = candidate;
      const instrumentChanged = before.instrument !== after.instrument;
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "note",
        subtype: "phrase.step",
        target: "phrase.step",
        path: ["phrases", phraseId, row],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: renderTargets(phraseId, row, instrumentChanged),
        source: metadata.source,
        transaction: metadata.transaction ?? null,
      });
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return { value: after, before, after, mutated: false, changeSet, metadata: clone(metadata), phraseId, row };
      }
      step.note = after.note;
      step.velocity = after.velocity;
      step.instrument = after.instrument;
      publish(projectStore, changeSet);
      return { value: after, before, after, mutated: true, changeSet, metadata: clone(metadata), phraseId, row };
    }

    function replaceRows(phraseIdValue, startRowValue, rowsValue, metadata = {}) {
      const phraseId = normalizePhraseId(phraseIdValue);
      const startRow = normalizeRow(startRowValue);
      if (!Array.isArray(rowsValue) || rowsValue.length === 0) {
        throw new TypeError("Phrase row replacement requires at least one row");
      }
      const rowCount = Math.min(rowsValue.length, PHRASE_ROWS - startRow);
      const before = [];
      const after = [];
      for (let index = 0; index < rowCount; index += 1) {
        before.push(read(phraseId, startRow + index));
        after.push(fullStepSnapshot(rowsValue[index]));
      }
      const changeSet = storeTypes.createProjectChangeSet({
        kind: "note",
        subtype: "phrase.rows",
        target: "phrase.rows",
        path: ["phrases", phraseId, startRow, rowCount],
        before,
        after,
        affectsPlayback: true,
        persistsProject: true,
        renderTargets: rowRangeRenderTargets(phraseId, startRow, before, after),
        source: metadata.source,
        transaction: metadata.transaction ?? null,
      });
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return {
          value: clone(after), before, after, mutated: false, changeSet, metadata: clone(metadata),
          phraseId, startRow, rowCount, requestedRowCount: rowsValue.length, clipped: rowsValue.length !== rowCount,
        };
      }
      for (let index = 0; index < rowCount; index += 1) {
        const step = phraseStep(project, phraseId, startRow + index);
        const next = after[index];
        step.note = next.note;
        step.velocity = next.velocity;
        step.instrument = next.instrument;
        step.fx = next.fx.map((slot) => ({ ...slot }));
        step.condition = { ...next.condition };
        step.parameterEvents = next.parameterEvents.map((event) => ({ ...event }));
      }
      publish(projectStore, changeSet);
      return {
        value: clone(after), before, after, mutated: true, changeSet, metadata: clone(metadata),
        phraseId, startRow, rowCount, requestedRowCount: rowsValue.length, clipped: rowsValue.length !== rowCount,
      };
    }

    function replaceStep(phraseIdValue, rowValue, value, metadata = {}) {
      const result = replaceRows(phraseIdValue, rowValue, [value], metadata);
      return {
        ...result,
        value: result.value[0],
        before: result.before[0],
        after: result.after[0],
        row: result.startRow,
      };
    }

    function clearRows(phraseIdValue, startRowValue, countValue, metadata = {}) {
      const count = Math.max(1, integer(countValue, "Phrase row count"));
      const rows = Array.from({ length: count }, () => emptyStepSnapshot());
      return replaceRows(phraseIdValue, startRowValue, rows, metadata);
    }

    return Object.freeze({
      read,
      readFxSlot,
      readParameterEvents,
      setField,
      setCondition,
      setParameterEvents,
      setFxSlot,
      setFxComponent,
      writeStep,
      replaceStep,
      replaceRows,
      clearRows,
      emptyStep: () => emptyStepSnapshot(),
      constants: Object.freeze({
        EMPTY,
        NOTE_OFF,
        PHRASE_ROWS,
        MAX_PHRASE_ID,
        FX_SLOTS: fxTypes.SLOT_COUNT,
        MAX_PARAMETER_EVENTS_PER_ROW: parameterEventTypes.DEFAULT_MAX_PARAMETER_EVENTS_PER_ROW,
      }),
    });
  }

  function install(projectStore) {
    if (projectStore.phraseSteps) return projectStore.phraseSteps;
    const domain = createDomain(projectStore);
    Object.defineProperty(projectStore, "phraseSteps", {
      value: domain,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    return domain;
  }

  const api = Object.freeze({
    install,
    createDomain,
    normalizeNote,
    normalizeVelocity,
    normalizeInstrument,
    normalizeStoredInstrument,
    normalizeCondition,
    normalizeParameterEvents: parameterEventTypes.serializeParameterEvents,
    normalizeStep,
    fullStepSnapshot,
  });

  globalThis.BRKTRKProjectPhraseStep = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
