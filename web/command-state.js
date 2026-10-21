(() => {
  const STRUCTURAL_WORKSPACES = Object.freeze(["song", "chain", "phrase"]);
  const UTILITY_WORKSPACES = Object.freeze(["sound", "mix"]);
  const WORKSPACES = Object.freeze([...STRUCTURAL_WORKSPACES, ...UTILITY_WORKSPACES]);
  const CHANGE_OWNERS = Object.freeze(["project", "navigation", "transport", "ui"]);
  const CHANGE_KINDS = Object.freeze(["cursor", "structure", "note", "parameter", "mix", "transport", "project", "ui"]);
  const CURSOR_ONLY_TARGETS = new Set([
    "context.navigate",
    "dock.select",
    "dock.toggle",
    "mix.selectTrack",
    "sound.selectParam",
    "sound.selectInstrument",
  ]);
  const UI_ONLY_TARGETS = new Set([
    "note.octave",
    "note.editStep",
    "ui.editHeld",
  ]);

  const isInteger = (value) => Number.isInteger(value);
  const isWorkspace = (value) => WORKSPACES.includes(value);
  const isStructuralWorkspace = (value) => STRUCTURAL_WORKSPACES.includes(value);
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const freezeList = (value) => Object.freeze([...(Array.isArray(value) ? value : [])]);

  function normalizeWorkspace(value, fallback = "phrase") {
    if (isWorkspace(value)) return value;
    return isWorkspace(fallback) ? fallback : "phrase";
  }

  function createTrackerCursor(source = {}) {
    const pane = isStructuralWorkspace(source.pane) ? source.pane : "phrase";
    const row = isInteger(source.row) ? Math.max(0, source.row) : 0;
    const col = isInteger(source.col) ? Math.max(0, source.col) : 0;
    return Object.freeze({ pane, row, col });
  }

  function createWorkspaceSnapshot(source = {}) {
    const cursor = createTrackerCursor(source.focus ?? source.trackerCursor ?? {});
    const activeWorkspace = normalizeWorkspace(source.activeWorkspace ?? source.view ?? cursor.pane, cursor.pane);
    return Object.freeze({
      activeWorkspace,
      view: normalizeWorkspace(source.view ?? activeWorkspace, activeWorkspace),
      dock: typeof source.dock === "string" ? source.dock : "mix",
      trackerCursor: cursor,
      songRow: isInteger(source.songRow) ? source.songRow : 0,
      track: isInteger(source.track) ? source.track : 0,
      chain: isInteger(source.chain) ? source.chain : 0,
      chainRow: isInteger(source.chainRow) ? source.chainRow : 0,
      phrase: isInteger(source.phrase) ? source.phrase : 0,
      phraseRow: isInteger(source.phraseRow) ? source.phraseRow : 0,
      instrument: isInteger(source.instrument) ? source.instrument : 0,
      soundParam: isInteger(source.soundParam) ? source.soundParam : 0,
    });
  }

  function createReturnSnapshot(label, source = {}) {
    if (typeof label !== "string" || !label.trim()) throw new TypeError("Return snapshot label is required");
    return Object.freeze({
      label: label.trim(),
      context: createWorkspaceSnapshot(source),
      createdAt: Date.now(),
    });
  }

  function subtypeFromTarget(target, fallback) {
    const value = String(target || "").trim();
    if (!value) return fallback;
    const parts = value.split(".").filter(Boolean);
    if (parts[0] === "navigation") return parts.slice(1).join(".") || fallback;
    return value;
  }

  function createChangeSet(input = {}) {
    let kind = CHANGE_KINDS.includes(input.kind) ? input.kind : "ui";
    const target = typeof input.target === "string" && input.target ? input.target : kind;
    let affectsPlayback = Boolean(input.affectsPlayback);
    let persistsProject = Boolean(input.persistsProject);
    let owner = CHANGE_OWNERS.includes(input.owner) ? input.owner : null;

    const structuralNavigation = target.startsWith("navigation.")
      || target.startsWith("cursor.")
      || target.startsWith("hierarchy.")
      || target.startsWith("workspace.")
      || CURSOR_ONLY_TARGETS.has(target);
    if (structuralNavigation) {
      kind = "cursor";
      owner = "navigation";
      affectsPlayback = false;
      persistsProject = false;
    } else if (UI_ONLY_TARGETS.has(target)) {
      kind = "ui";
      owner = "ui";
      affectsPlayback = false;
      persistsProject = false;
    } else if (!owner) {
      if (kind === "transport" || target.startsWith("transport.") || target === "scope.set") owner = "transport";
      else if (persistsProject || ["project", "structure", "note", "parameter", "mix"].includes(kind)) owner = "project";
      else owner = "ui";
    }

    const defaultSubtype = structuralNavigation ? "context" : kind;
    const subtype = typeof input.subtype === "string" && input.subtype
      ? input.subtype
      : subtypeFromTarget(target, defaultSubtype);

    return Object.freeze({
      owner,
      kind,
      subtype,
      target,
      path: freezeList(input.path),
      before: clone(input.before),
      after: clone(input.after),
      affectsPlayback,
      persistsProject,
      renderTargets: freezeList(input.renderTargets),
    });
  }

  function mergeChangeSets(changeSets = []) {
    const valid = changeSets.filter(Boolean);
    if (!valid.length) return createChangeSet();
    const owners = new Set(valid.map((item) => item.owner).filter(Boolean));
    return createChangeSet({
      owner: owners.size === 1 ? valid[0].owner : "ui",
      kind: valid.at(-1).kind,
      subtype: "merged",
      target: valid.map((item) => item.target).join("+"),
      path: valid.flatMap((item) => item.path ?? []),
      before: valid[0].before,
      after: valid.at(-1).after,
      affectsPlayback: valid.some((item) => item.affectsPlayback),
      persistsProject: valid.some((item) => item.persistsProject),
      renderTargets: [...new Set(valid.flatMap((item) => item.renderTargets ?? []))],
    });
  }

  class CommandHistory {
    constructor(limit = 96) {
      this.limit = Math.max(1, Number(limit) || 96);
      this.records = [];
      this.serial = 0;
    }

    push(command, before, after, changeSet, result = {}) {
      const record = Object.freeze({
        id: ++this.serial,
        command: clone(command),
        before: clone(before),
        after: clone(after),
        changeSet: clone(changeSet),
        ok: result.ok !== false,
        timestamp: Date.now(),
      });
      this.records.push(record);
      if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
      return record;
    }

    clear() {
      this.records.length = 0;
    }

    last() {
      return this.records.at(-1) ?? null;
    }

    list() {
      return this.records.slice();
    }
  }

  const api = Object.freeze({
    STRUCTURAL_WORKSPACES,
    UTILITY_WORKSPACES,
    WORKSPACES,
    CHANGE_OWNERS,
    CHANGE_KINDS,
    isWorkspace,
    isStructuralWorkspace,
    normalizeWorkspace,
    createTrackerCursor,
    createWorkspaceSnapshot,
    createReturnSnapshot,
    createChangeSet,
    mergeChangeSets,
    CommandHistory,
  });

  globalThis.BRKTRKCommandState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
