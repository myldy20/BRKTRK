(() => {
  const timingDomain = globalThis.BRKTRKTimingDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./timing-domain.js") : null);
  if (!timingDomain) throw new Error("BRKTRK Table sources require the K0 timing domain");

  const TABLE_ROWS = 16;
  const TABLE_ID_MAX = 0xff;
  const TABLE_TIC = Object.freeze({
    TRIGGER: 0x00,
    MUSICAL_MIN: 0x01,
    MUSICAL_MAX: 0xfb,
    OCTAVE_MAP: 0xfc,
    VELOCITY_MAP: 0xfd,
    NOTE_MAP: 0xfe,
    DETACHED: 0xff,
  });
  const CLOCK_CLASSES = Object.freeze({
    TRIGGER: "trigger",
    MUSICAL: "musical",
    OCTAVE_MAP: "octave-map",
    VELOCITY_MAP: "velocity-map",
    NOTE_MAP: "note-map",
    DETACHED: "detached",
  });
  const SOURCE_KINDS = Object.freeze({ INSTRUMENT: "instrument", AUXILIARY: "auxiliary" });
  const TABLE_COLUMNS = Object.freeze(["noteVolume", "fx1", "fx2", "fx3"]);
  const COLUMN_ORDER = Object.freeze({ noteVolume: 1, fx1: 2, fx2: 3, fx3: 4 });
  const EMISSION_POLICIES = Object.freeze({
    EMIT_THEN_ADVANCE: "emit-then-advance",
    ADVANCE_THEN_EMIT: "advance-then-emit",
  });
  const ANCHOR_POLICIES = Object.freeze({ AT_START: "at-start", AFTER_INTERVAL: "after-interval" });
  const MAPPED_CURSOR_POLICIES = Object.freeze({ PRESERVE: "preserve", EXPLICIT: "explicit" });

  const isPlainObject = (value) => value !== null
    && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

  function assertSafeInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
      throw new RangeError(`${name} must be a safe integer between ${min} and ${max}`);
    }
    return numeric;
  }

  function normalizeHexByte(value, name = "byte") {
    let numeric;
    if (typeof value === "string") {
      const text = value.trim();
      if (/^0x[0-9a-f]{1,2}$/i.test(text)) numeric = Number.parseInt(text.slice(2), 16);
      else if (/^[0-9a-f]{2}$/i.test(text)) numeric = Number.parseInt(text, 16);
      else if (/^\d+$/.test(text)) numeric = Number(text);
      else throw new TypeError(`${name} must be a byte number or two-digit hexadecimal string`);
    } else numeric = Number(value);
    return assertSafeInteger(numeric, name, { min: 0, max: 0xff });
  }

  function ticClass(value) {
    if (value === TABLE_TIC.TRIGGER) return CLOCK_CLASSES.TRIGGER;
    if (value >= TABLE_TIC.MUSICAL_MIN && value <= TABLE_TIC.MUSICAL_MAX) return CLOCK_CLASSES.MUSICAL;
    if (value === TABLE_TIC.OCTAVE_MAP) return CLOCK_CLASSES.OCTAVE_MAP;
    if (value === TABLE_TIC.VELOCITY_MAP) return CLOCK_CLASSES.VELOCITY_MAP;
    if (value === TABLE_TIC.NOTE_MAP) return CLOCK_CLASSES.NOTE_MAP;
    return CLOCK_CLASSES.DETACHED;
  }

  function normalizeTic(value, name = "tic") {
    const numeric = normalizeHexByte(value, name);
    return Object.freeze({
      value: numeric,
      hex: numeric.toString(16).toUpperCase().padStart(2, "0"),
      clockClass: ticClass(numeric),
      ticksPerRow: numeric >= TABLE_TIC.MUSICAL_MIN && numeric <= TABLE_TIC.MUSICAL_MAX ? numeric : null,
    });
  }

  function normalizeSourceKind(value) {
    if (value === SOURCE_KINDS.INSTRUMENT || value === SOURCE_KINDS.AUXILIARY) return value;
    throw new RangeError(`sourceKind must be ${SOURCE_KINDS.INSTRUMENT} or ${SOURCE_KINDS.AUXILIARY}`);
  }

  function normalizeColumn(value) {
    if (TABLE_COLUMNS.includes(value)) return value;
    throw new RangeError(`column must be one of ${TABLE_COLUMNS.join(", ")}`);
  }

  function normalizeCursorRows(value, name = "cursorRows") {
    const rows = value === undefined ? Array.from({ length: TABLE_ROWS }, (_, row) => row) : value;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 256) {
      throw new RangeError(`${name} must contain between 1 and 256 explicit table rows`);
    }
    return Object.freeze(rows.map((row, index) => assertSafeInteger(row, `${name}[${index}]`, { min: 0, max: TABLE_ROWS - 1 })));
  }

  function normalizeFrameArray(value, name) {
    if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
    const frames = value.map((frame, index) => assertSafeInteger(frame, `${name}[${index}]`, { min: 0 }));
    for (let index = 1; index < frames.length; index += 1) {
      if (frames[index] < frames[index - 1]) throw new RangeError(`${name} must be non-decreasing`);
    }
    return Object.freeze(frames);
  }

  function normalizeMappedEvents(value, name, cursorPolicy, cursorRows) {
    if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
    let previousFrame = -1;
    return Object.freeze(value.map((event, index) => {
      if (!isPlainObject(event)) throw new TypeError(`${name}[${index}] must be an object`);
      const frame = assertSafeInteger(event.frame, `${name}[${index}].frame`, { min: 0 });
      if (frame < previousFrame) throw new RangeError(`${name} must be non-decreasing by frame`);
      previousFrame = frame;
      const row = assertSafeInteger(event.row, `${name}[${index}].row`, { min: 0, max: TABLE_ROWS - 1 });
      let cursor = null;
      if (cursorPolicy === MAPPED_CURSOR_POLICIES.EXPLICIT) {
        cursor = assertSafeInteger(event.cursor, `${name}[${index}].cursor`, { min: 0, max: cursorRows.length - 1 });
      } else if (Object.hasOwn(event, "cursor")) {
        throw new RangeError(`${name}[${index}].cursor requires mappedCursorPolicy=explicit`);
      }
      const carrierValue = Object.hasOwn(event, "carrierValue")
        ? assertSafeInteger(event.carrierValue, `${name}[${index}].carrierValue`, { min: 0 })
        : null;
      return Object.freeze({ frame, row, cursor, carrierValue });
    }));
  }

  function normalizeEmissionPolicy(value, name) {
    if (value === EMISSION_POLICIES.EMIT_THEN_ADVANCE || value === EMISSION_POLICIES.ADVANCE_THEN_EMIT) return value;
    throw new RangeError(`${name} must be emit-then-advance or advance-then-emit`);
  }

  function normalizeAnchorPolicy(value, name) {
    if (value === ANCHOR_POLICIES.AT_START || value === ANCHOR_POLICIES.AFTER_INTERVAL) return value;
    throw new RangeError(`${name} must be at-start or after-interval`);
  }

  function normalizeMappedCursorPolicy(value, name) {
    if (value === MAPPED_CURSOR_POLICIES.PRESERVE || value === MAPPED_CURSOR_POLICIES.EXPLICIT) return value;
    throw new RangeError(`${name} must be preserve or explicit`);
  }

  function isMappedClass(clockClass) {
    return clockClass === CLOCK_CLASSES.OCTAVE_MAP
      || clockClass === CLOCK_CLASSES.VELOCITY_MAP
      || clockClass === CLOCK_CLASSES.NOTE_MAP;
  }

  function compileCarrierEvents({
    tic,
    sampleRate,
    tempo,
    ppqn,
    startFrame,
    endFrame,
    eventCount,
    anchorPolicy,
    triggerFrames,
    mappedEvents,
    mappedCursorPolicy,
    cursorRows,
    name,
  }) {
    if (tic.clockClass === CLOCK_CLASSES.TRIGGER) {
      const frames = normalizeFrameArray(triggerFrames, `${name}.triggerFrames`);
      for (const frame of frames) {
        if (frame < startFrame || frame >= endFrame) throw new RangeError(`${name}.triggerFrames must stay inside the source lifetime [startFrame, endFrame)`);
      }
      return Object.freeze(frames.map((frame, ordinal) => Object.freeze({ frame, ordinal, mappedRow: null, mappedCursor: null, carrierValue: null })));
    }

    if (isMappedClass(tic.clockClass)) {
      const policy = normalizeMappedCursorPolicy(mappedCursorPolicy, `${name}.mappedCursorPolicy`);
      const events = normalizeMappedEvents(mappedEvents, `${name}.mappedEvents`, policy, cursorRows);
      for (const event of events) {
        if (event.frame < startFrame || event.frame >= endFrame) throw new RangeError(`${name}.mappedEvents must stay inside the source lifetime [startFrame, endFrame)`);
      }
      return Object.freeze(events.map((event, ordinal) => Object.freeze({
        frame: event.frame,
        ordinal,
        mappedRow: event.row,
        mappedCursor: event.cursor,
        carrierValue: event.carrierValue,
      })));
    }

    const count = assertSafeInteger(eventCount, `${name}.eventCount`, { min: 1 });
    const anchor = normalizeAnchorPolicy(anchorPolicy, `${name}.anchorPolicy`);
    const firstStep = anchor === ANCHOR_POLICIES.AT_START ? 0 : 1;
    const carriers = [];

    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const step = firstStep + ordinal;
      let frame;
      if (tic.clockClass === CLOCK_CLASSES.MUSICAL) {
        const resolution = assertSafeInteger(ppqn, `${name}.ppqn`, { min: 1 });
        if (!timingDomain.SUPPORTED_M8_GROOVE_PPQN.includes(resolution)) {
          throw new RangeError(`${name}.ppqn must be one of ${timingDomain.SUPPORTED_M8_GROOVE_PPQN.join(", ")}`);
        }
        const intervalUnits = tic.ticksPerRow * timingDomain.unitsPerTick(resolution);
        frame = startFrame + timingDomain.musicalPositionToFrame({
          positionUnits: step * intervalUnits,
          sampleRate,
          tempo,
        });
      } else {
        frame = startFrame + timingDomain.detachedRateStepToFrame({
          step,
          sampleRate,
          rate: timingDomain.TABLE_DETACHED_HZ,
        });
      }
      if (frame >= endFrame) break;
      carriers.push(Object.freeze({ frame, ordinal, mappedRow: null, mappedCursor: null, carrierValue: null }));
    }
    return Object.freeze(carriers);
  }

  function compileTableColumnMap({
    sampleRate,
    tempo = 120,
    ppqn = 24,
    track = 0,
    sourceKind,
    sourceId,
    table,
    instance = 0,
    sourceOrder = 0,
    startFrame,
    endFrame,
    column,
    tic,
    cursorRows,
    initialCursor = 0,
    emissionPolicy,
    anchorPolicy,
    triggerFrames,
    mappedEvents,
    mappedCursorPolicy,
    eventCount,
  } = {}) {
    const rate = assertSafeInteger(sampleRate, "sampleRate", { min: 1 });
    const trackId = assertSafeInteger(track, "track", { min: 0 });
    const kind = normalizeSourceKind(sourceKind);
    const id = assertSafeInteger(sourceId, "sourceId", { min: 0, max: TABLE_ID_MAX });
    const tableId = assertSafeInteger(table, "table", { min: 0, max: TABLE_ID_MAX });
    const instanceId = assertSafeInteger(instance, "instance", { min: 0 });
    const order = assertSafeInteger(sourceOrder, "sourceOrder", { min: 0, max: Math.floor(Number.MAX_SAFE_INTEGER / 8) });
    const start = assertSafeInteger(startFrame, "startFrame", { min: 0 });
    const end = assertSafeInteger(endFrame, "endFrame", { min: start + 1 });
    const columnId = normalizeColumn(column);
    const clock = normalizeTic(tic, `${columnId}.tic`);
    const rows = normalizeCursorRows(cursorRows, `${columnId}.cursorRows`);
    let cursor = assertSafeInteger(initialCursor, `${columnId}.initialCursor`, { min: 0, max: rows.length - 1 });
    const name = `columns.${columnId}`;
    const mappedPolicy = isMappedClass(clock.clockClass)
      ? normalizeMappedCursorPolicy(mappedCursorPolicy, `${name}.mappedCursorPolicy`)
      : null;
    const sequentialPolicy = isMappedClass(clock.clockClass)
      ? null
      : normalizeEmissionPolicy(emissionPolicy, `${name}.emissionPolicy`);
    const carriers = compileCarrierEvents({
      tic: clock,
      sampleRate: rate,
      tempo,
      ppqn,
      startFrame: start,
      endFrame: end,
      eventCount,
      anchorPolicy,
      triggerFrames,
      mappedEvents,
      mappedCursorPolicy: mappedPolicy,
      cursorRows: rows,
      name,
    });
    const events = [];
    let loopCount = 0;

    for (const carrier of carriers) {
      const cursorBefore = cursor;
      let tableRow;
      let cursorAfter;
      if (isMappedClass(clock.clockClass)) {
        tableRow = carrier.mappedRow;
        if (mappedPolicy === MAPPED_CURSOR_POLICIES.EXPLICIT) cursor = carrier.mappedCursor;
        cursorAfter = cursor;
      } else if (sequentialPolicy === EMISSION_POLICIES.ADVANCE_THEN_EMIT) {
        cursor = (cursor + 1) % rows.length;
        if (cursor === 0) loopCount += 1;
        tableRow = rows[cursor];
        cursorAfter = cursor;
      } else {
        tableRow = rows[cursor];
        cursor = (cursor + 1) % rows.length;
        if (cursor === 0) loopCount += 1;
        cursorAfter = cursor;
      }
      events.push(Object.freeze({
        frame: carrier.frame,
        ordinal: carrier.ordinal,
        track: trackId,
        sourceKind: kind,
        sourceId: id,
        table: tableId,
        instance: instanceId,
        sourceOrder: order,
        column: columnId,
        columnOrder: COLUMN_ORDER[columnId],
        tic: clock,
        tableRow,
        cursorBefore,
        cursorAfter,
        loopCount,
        carrierValue: carrier.carrierValue,
      }));
    }

    return Object.freeze({
      version: 1,
      sampleRate: rate,
      tempo,
      ppqn,
      track: trackId,
      sourceKind: kind,
      sourceId: id,
      table: tableId,
      instance: instanceId,
      sourceOrder: order,
      startFrame: start,
      endFrame: end,
      lifetime: Object.freeze({ startInclusive: true, endExclusive: true }),
      column: columnId,
      columnOrder: COLUMN_ORDER[columnId],
      tic: clock,
      cursorRows: rows,
      initialCursor: assertSafeInteger(initialCursor, `${columnId}.initialCursor`, { min: 0, max: rows.length - 1 }),
      emissionPolicy: sequentialPolicy,
      anchorPolicy: clock.clockClass === CLOCK_CLASSES.MUSICAL || clock.clockClass === CLOCK_CLASSES.DETACHED
        ? normalizeAnchorPolicy(anchorPolicy, `${name}.anchorPolicy`)
        : null,
      mappedCursorPolicy: mappedPolicy,
      events: Object.freeze(events),
      finalCursor: cursor,
    });
  }

  function rejectUnresolvedControls(spec, name) {
    for (const key of ["segments", "ticChanges", "sameRowTic", "hop", "tho", "tbl", "tbx", "restartPolicy", "resetPolicy", "carrierMapper"]) {
      if (Object.hasOwn(spec, key)) {
        throw new RangeError(`${name}.${key} is unresolved and must not be inferred by K3B`);
      }
    }
  }

  function compileTableSourceMap({
    sampleRate,
    tempo = 120,
    ppqn = 24,
    track = 0,
    sourceKind,
    sourceId,
    table,
    instance = 0,
    sourceOrder = 0,
    startFrame,
    endFrame,
    columns = {},
  } = {}) {
    if (!isPlainObject(columns)) throw new TypeError("columns must be an object");
    const columnNames = TABLE_COLUMNS.filter((column) => Object.hasOwn(columns, column));
    if (columnNames.length === 0) throw new RangeError("at least one Table column map is required");
    const compiled = columnNames.map((column) => {
      if (!isPlainObject(columns[column])) throw new TypeError(`columns.${column} must be an object`);
      rejectUnresolvedControls(columns[column], `columns.${column}`);
      return compileTableColumnMap({
        ...columns[column],
        sampleRate,
        tempo: columns[column].tempo ?? tempo,
        ppqn: columns[column].ppqn ?? ppqn,
        track,
        sourceKind,
        sourceId,
        table,
        instance,
        sourceOrder,
        startFrame,
        endFrame,
        column,
      });
    });
    const events = compiled.flatMap((columnMap) => columnMap.events)
      .sort((left, right) => left.frame - right.frame
        || left.columnOrder - right.columnOrder
        || left.ordinal - right.ordinal);
    const first = compiled[0];
    return Object.freeze({
      version: 1,
      sampleRate: first.sampleRate,
      track: first.track,
      sourceKind: first.sourceKind,
      sourceId: first.sourceId,
      table: first.table,
      instance: first.instance,
      sourceOrder: first.sourceOrder,
      startFrame: first.startFrame,
      endFrame: first.endFrame,
      lifetime: first.lifetime,
      columns: Object.freeze(Object.fromEntries(compiled.map((map) => [map.column, map]))),
      events: Object.freeze(events),
    });
  }

  function compileTableSourceMaps({ sampleRate, sources = [] } = {}) {
    if (!Array.isArray(sources)) throw new TypeError("sources must be an array");
    const maps = sources.map((source, index) => {
      if (!isPlainObject(source)) throw new TypeError(`sources[${index}] must be an object`);
      return compileTableSourceMap({ ...source, sampleRate, sourceOrder: source.sourceOrder ?? index });
    }).sort((left, right) => left.track - right.track
      || left.sourceOrder - right.sourceOrder
      || left.sourceKind.localeCompare(right.sourceKind)
      || left.sourceId - right.sourceId
      || left.instance - right.instance);
    const identities = new Set();
    const orders = new Set();
    for (const map of maps) {
      const identity = `${map.track}:${map.sourceKind}:${map.sourceId}:${map.instance}`;
      if (identities.has(identity)) throw new RangeError(`duplicate Table source identity ${identity}`);
      identities.add(identity);
      const order = `${map.track}:${map.sourceOrder}`;
      if (orders.has(order)) throw new RangeError(`duplicate Table sourceOrder ${order}`);
      orders.add(order);
    }
    return Object.freeze(maps);
  }

  function compileTableSourceTrace(maps) {
    const sourceMaps = Array.isArray(maps) ? maps : [maps];
    const events = [];
    for (const map of sourceMaps) {
      if (!map || !Array.isArray(map.events)) throw new TypeError("Table source trace requires compiled source maps");
      const baseOrder = map.sourceOrder * 8;
      const identity = `${map.sourceKind}:${map.sourceId}:${map.instance}`;
      events.push({
        kind: "table-source-start",
        source: identity,
        sourceOrder: baseOrder,
        track: map.track,
        phase: timingDomain.EVENT_PHASES.SOURCE_CONTROL,
        position: { clock: timingDomain.CLOCK_DOMAINS.FRAME, frame: map.startFrame },
        data: { sourceKind: map.sourceKind, sourceId: map.sourceId, table: map.table, instance: map.instance },
      });
      for (const event of map.events) {
        events.push({
          kind: "table-row-evaluate",
          source: identity,
          sourceOrder: baseOrder + event.columnOrder,
          track: map.track,
          phase: timingDomain.EVENT_PHASES.TABLE,
          position: { clock: timingDomain.CLOCK_DOMAINS.FRAME, frame: event.frame },
          data: {
            sourceKind: event.sourceKind,
            sourceId: event.sourceId,
            table: event.table,
            instance: event.instance,
            column: event.column,
            tic: event.tic.hex,
            clockClass: event.tic.clockClass,
            tableRow: event.tableRow,
            cursorBefore: event.cursorBefore,
            cursorAfter: event.cursorAfter,
            carrierValue: event.carrierValue,
          },
        });
      }
      events.push({
        kind: "table-source-end",
        source: identity,
        sourceOrder: baseOrder + 7,
        track: map.track,
        phase: timingDomain.EVENT_PHASES.SOURCE_CONTROL,
        position: { clock: timingDomain.CLOCK_DOMAINS.FRAME, frame: map.endFrame },
        data: { sourceKind: map.sourceKind, sourceId: map.sourceId, table: map.table, instance: map.instance },
      });
    }
    return timingDomain.compileTimingTrace({ sampleRate: 1, tempo: 120, events });
  }

  function canonicalize(value, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new TypeError("unsupported Table source value");
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Table source values must be finite");
      return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) throw new TypeError("Table source values must not contain cycles");
      seen.add(value);
      const result = value.map((entry) => canonicalize(entry, seen));
      seen.delete(value);
      return result;
    }
    if (isPlainObject(value)) {
      if (seen.has(value)) throw new TypeError("Table source values must not contain cycles");
      seen.add(value);
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], seen);
      seen.delete(value);
      return result;
    }
    throw new TypeError("Table source values must contain only JSON-compatible data");
  }

  function serializeTableSourceMap(value) {
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
  }

  const api = Object.freeze({
    TABLE_ROWS,
    TABLE_ID_MAX,
    TABLE_TIC,
    CLOCK_CLASSES,
    SOURCE_KINDS,
    TABLE_COLUMNS,
    COLUMN_ORDER,
    EMISSION_POLICIES,
    ANCHOR_POLICIES,
    MAPPED_CURSOR_POLICIES,
    normalizeTic,
    compileTableColumnMap,
    compileTableSourceMap,
    compileTableSourceMaps,
    compileTableSourceTrace,
    serializeTableSourceMap,
    serializeTableSourceTrace: timingDomain.serializeTimingTrace,
  });

  if (typeof globalThis !== "undefined") globalThis.BRKTRKTableSourceDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();