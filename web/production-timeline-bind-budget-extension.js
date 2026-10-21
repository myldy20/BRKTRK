(() => {
  "use strict";

  const baseDomain = globalThis.BRKTRKProductionTimelineTemplate;
  if (!baseDomain?.bindRelativeTimeline) throw new Error("R6 bind budget requires ProductionTimelineTemplate");

  const BIND_BUDGET_VERSION = 1;
  const MAX_BIND_WORK_UNITS = 2_000_000;
  const MAX_BIND_ALLOCATION_UNITS = 1_000_000;
  let lastWorkUnits = 0;
  let lastAllocationUnits = 0;
  let rejectedBinds = 0;

  function add(units, allocations = 0) {
    lastWorkUnits += Number(units) || 0;
    lastAllocationUnits += Number(allocations) || 0;
    if (lastWorkUnits > MAX_BIND_WORK_UNITS || lastAllocationUnits > MAX_BIND_ALLOCATION_UNITS) {
      rejectedBinds += 1;
      throw new RangeError(`prepared timeline bind budget exceeded: work ${lastWorkUnits}/${MAX_BIND_WORK_UNITS}, allocations ${lastAllocationUnits}/${MAX_BIND_ALLOCATION_UNITS}`);
    }
  }

  function scanCycle(cycle) {
    if (!cycle || typeof cycle !== "object") return;
    const rows = Array.isArray(cycle.rows) ? cycle.rows.length : Number(cycle.rowCount) || 0;
    const schedule = Array.isArray(cycle.schedule) ? cycle.schedule.length : 0;
    // Conservative: exact-start rotation can visit/copy every row and schedule
    // entry, and maximumRowsAtOneOffset() scans the resulting schedule again.
    add(4 + (rows * 2) + (schedule * 2), 2 + rows + schedule);
  }

  function scanTableSource(source) {
    if (!source || typeof source !== "object") return;
    const events = Array.isArray(source.events) ? source.events.length : 0;
    add(6 + (events * 2), 2 + events);
    const columns = source.columns && typeof source.columns === "object" ? source.columns : null;
    if (!columns) return;
    for (const name in columns) {
      if (!Object.hasOwn(columns, name)) continue;
      const column = columns[name];
      const columnEvents = Array.isArray(column?.events) ? column.events.length : 0;
      add(4 + (columnEvents * 2), 2 + columnEvents);
    }
  }

  function assertBindBudget(template) {
    lastWorkUnits = 0;
    lastAllocationUnits = 0;
    add(16, 1);
    scanCycle(template?.sequence);
    const tracks = Array.isArray(template?.tracks) ? template.tracks : [];
    add(tracks.length * 3, tracks.length + 1);
    for (const cycle of tracks) scanCycle(cycle);
    const sources = Array.isArray(template?.tableSources) ? template.tableSources : [];
    add(sources.length * 2, sources.length + 1);
    for (const source of sources) scanTableSource(source);
    const tableEvents = Array.isArray(template?.tableEvents) ? template.tableEvents.length : 0;
    add(tableEvents * 2, tableEvents + 1);
    const summaryTracks = Array.isArray(template?.summary?.tracks) ? template.summary.tracks.length : 0;
    const summarySources = Array.isArray(template?.summary?.tableSources) ? template.summary.tableSources.length : 0;
    add((summaryTracks * 2) + (summarySources * 2) + 8, summaryTracks + summarySources + 3);
    return true;
  }

  function bindRelativeTimeline(template, startFrame = 0, position = null) {
    assertBindBudget(template);
    return baseDomain.bindRelativeTimeline(template, startFrame, position);
  }

  function estimateBindCost(template) {
    assertBindBudget(template);
    return Object.freeze({
      version: BIND_BUDGET_VERSION,
      workUnits: lastWorkUnits,
      allocationUnits: lastAllocationUnits,
      maxWorkUnits: MAX_BIND_WORK_UNITS,
      maxAllocationUnits: MAX_BIND_ALLOCATION_UNITS,
    });
  }

  function bindBudgetDiagnostics() {
    return Object.freeze({
      version: BIND_BUDGET_VERSION,
      lastWorkUnits,
      lastAllocationUnits,
      maxWorkUnits: MAX_BIND_WORK_UNITS,
      maxAllocationUnits: MAX_BIND_ALLOCATION_UNITS,
      rejectedBinds,
    });
  }

  const api = Object.freeze({
    ...baseDomain,
    bindRelativeTimeline,
    estimateBindCost,
    assertBindBudget,
    bindBudgetDiagnostics,
    BIND_BUDGET_VERSION,
    MAX_BIND_WORK_UNITS,
    MAX_BIND_ALLOCATION_UNITS,
  });
  globalThis.BRKTRKProductionTimelineTemplate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();