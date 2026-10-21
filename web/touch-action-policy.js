(() => {
  const EMPTY = -1;
  const NOTE_OFF = -2;
  const STRUCTURAL = new Set(["song", "chain", "phrase"]);
  const UTILITY = new Set(["sound", "mix"]);

  const hex = (value) => Math.max(0, Number(value) || 0).toString(16).toUpperCase().padStart(2, "0");

  const HIDDEN_UNIQUE = Object.freeze({
    visible: false,
    enabled: false,
    label: "MAKE UNIQUE",
    command: "structure.duplicateAndRepoint",
    tone: "amber",
    sharedCount: 0,
  });

  function childLabel(kind, value) {
    const prefix = kind === "chain" ? "C" : "P";
    return `${prefix}${hex(value)}`;
  }

  function describe(input = {}) {
    const workspace = input.workspace ?? input.pane ?? "phrase";
    const pane = input.pane ?? workspace;
    const descriptor = input.descriptor ?? null;
    const value = Number.isFinite(Number(input.value)) ? Number(input.value) : EMPTY;
    const childValue = Number.isFinite(Number(input.childValue)) ? Number(input.childValue) : EMPTY;
    const childKind = input.childKind ?? (pane === "song" ? "chain" : pane === "chain" ? "phrase" : null);
    const childExists = Boolean(input.childExists);
    const structuralReference = descriptor?.referenceKind === "chain" || descriptor?.referenceKind === "phrase";
    const sharedCount = Math.max(0, Math.trunc(Number(input.sharedCount)) || 0);

    if (UTILITY.has(workspace)) {
      return Object.freeze({
        visible: true,
        pane: workspace,
        back: Object.freeze({
          visible: true,
          enabled: Boolean(input.canReturn),
          label: workspace === "sound" ? "‹ PHRASE" : "‹ RETURN",
        }),
        open: Object.freeze({ visible: true, enabled: false, label: workspace.toUpperCase(), mode: "none" }),
        edit: Object.freeze({ visible: true, enabled: false, label: "EDIT" }),
        clear: Object.freeze({ visible: true, enabled: false, label: "CLEAR", command: "reset", confirm: false, tone: "muted" }),
        unique: HIDDEN_UNIQUE,
        sharedCount: 0,
        selectedValue: value,
        childValue,
        childKind,
        structuralReference: false,
        noteOff: false,
      });
    }

    if (!STRUCTURAL.has(workspace) || !descriptor) {
      return Object.freeze({ visible: false });
    }

    let open = { visible: true, enabled: false, label: "OPEN", mode: "none" };
    if (pane === "phrase") {
      open = { visible: true, enabled: true, label: "SOUND", mode: "sound" };
    } else if (structuralReference && childKind) {
      if (childValue < 0) open = { visible: true, enabled: true, label: `NEW ${childKind.toUpperCase()}`, mode: "fresh" };
      else if (childExists) open = { visible: true, enabled: true, label: `OPEN ${childLabel(childKind, childValue)}`, mode: "open" };
      else open = { visible: true, enabled: true, label: `CREATE ${childLabel(childKind, childValue)}`, mode: "repair" };
    }

    let editLabel = "EDIT VALUE";
    if (descriptor.editorKind === "note") editLabel = "EDIT NOTE";
    else if (structuralReference && value < 0) editLabel = `LINK ${descriptor.referenceKind.toUpperCase()}`;
    else if (structuralReference) editLabel = "EDIT REF";

    let clear = { visible: true, enabled: true, label: "RESET", command: "reset", confirm: false, tone: "muted" };
    if (descriptor.editorKind === "note") {
      clear = {
        visible: true,
        enabled: true,
        label: value === EMPTY ? "NOTE OFF" : "EMPTY",
        command: "clear",
        confirm: false,
        tone: "amber",
      };
    } else if (structuralReference) {
      clear = {
        visible: true,
        enabled: value >= 0,
        // UX0-04 (#373): "DETACH" reads as "separate this one from the
        // others", which is duplicate-and-repoint. This clears the reference
        // and keeps the object.
        label: "UNLINK",
        command: "clear",
        confirm: value >= 0,
        tone: "danger",
      };
    } else if (descriptor.referenceKind === "instrument") {
      clear = {
        visible: true,
        enabled: value >= 0,
        label: "FALLBACK",
        command: "clear",
        confirm: false,
        tone: "amber",
      };
    } else if (descriptor.type === "fx-command") {
      clear = { visible: true, enabled: true, label: "RESET FX", command: "reset", confirm: false, tone: "muted" };
    } else if (descriptor.id === "chain.transpose") {
      clear = { visible: true, enabled: value !== 0, label: "RESET ±0", command: "reset", confirm: false, tone: "muted" };
    } else if (descriptor.id === "phrase.velocity") {
      clear = { visible: true, enabled: value !== 100, label: "RESET 100", command: "reset", confirm: false, tone: "muted" };
    }

    // UX0-03 (#373). The counterpart of the SHARED marker: the marker says
    // this object is reached from more than one place, this says "give me my
    // own copy of it here". It stays on screen for every structural reference
    // so the column does not reflow under a moving cursor, and it is live only
    // when there is actually sharing to leave - on a Chain or Phrase reached
    // from one place it is already this occurrence's own.
    const unique = structuralReference
      ? {
        visible: true,
        // A reference that resolves to nothing has no object to copy: OPEN
        // offers to create it, and a live action here could only ever refuse.
        enabled: value >= 0 && childExists && sharedCount > 1,
        // Deliberately unlike UNLINK, which keeps one object and drops a
        // reference. This keeps the reference and makes a second object.
        label: "MAKE UNIQUE",
        command: "structure.duplicateAndRepoint",
        // The same amber the SHARED marker uses, so the button reads as the
        // answer to the thing the context line just pointed at.
        tone: "amber",
        sharedCount,
      }
      : HIDDEN_UNIQUE;

    return Object.freeze({
      visible: true,
      pane,
      back: Object.freeze({
        visible: pane !== "song",
        enabled: pane !== "song",
        label: pane === "phrase" ? "‹ CHAIN" : "‹ SONG",
      }),
      open: Object.freeze(open),
      edit: Object.freeze({ visible: true, enabled: true, label: editLabel }),
      clear: Object.freeze(clear),
      unique: Object.freeze(unique),
      sharedCount,
      selectedValue: value,
      childValue,
      childKind,
      structuralReference,
      noteOff: value === NOTE_OFF,
    });
  }

  const api = Object.freeze({ EMPTY, NOTE_OFF, describe });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof globalThis !== "undefined") globalThis.BRKTRKTouchActionPolicy = api;
})();
