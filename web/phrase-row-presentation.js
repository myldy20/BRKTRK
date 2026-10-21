(() => {
  "use strict";

  // UX0-07 (#374). A Phrase row drew its velocity with no class at all, so an
  // empty row read `--- 100 01 --- --- ---`: the note said nothing is here and
  // the velocity said 100, in full brightness, as confidently as a row that
  // actually plays. A musician scanning a mostly-empty Phrase saw a wall of
  // active-looking parameter data.
  //
  // Velocity and Instrument belong to the note. With no note there is nothing
  // to apply them to, so they are stored settings rather than live values. An
  // FX command is operative on its own - a tracker runs effects on rows that
  // carry no note - so FX is judged per slot and never borrows the note's
  // state.
  //
  // Nothing here edits or clears anything. It decides how a value is drawn,
  // and the value stays exactly where it was, readable and editable.

  const FX_SLOTS = 3;
  // What the Phrase actually stores: project-storage clamps every note to an
  // integer in [NOTE_OFF, 127] with -1 (empty) as the default, so a row's note is
  // never a string, null or NaN by the time it is drawn.
  const NOTE_OFF = -2;

  // An Instrument written on a row is not only that row's. The event-plan
  // compiler's resolveCyclicInstrumentIds() reads an explicit instrument from
  // every step - note or not - and carries it forward into the rows that
  // follow, seeding the cycle from the last explicit one so it wraps. A
  // note-less row that names an Instrument therefore changes what later rows
  // play, and dimming it while claiming nothing uses it would be a lie about
  // audible behaviour.
  function explicitInstrument(step) {
    const value = Number(step?.instrument);
    return Number.isInteger(value) && value >= 0;
  }

  function commandCode(slot) {
    if (typeof slot === "number") return Number.isFinite(slot) ? Math.max(0, Math.round(slot)) : 0;
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) return 0;
    const raw = Object.hasOwn(slot, "command") ? slot.command : slot.commandCode;
    return Number.isFinite(Number(raw)) ? Math.max(0, Math.round(Number(raw))) : 0;
  }

  function phraseRowPresentation(step) {
    const note = Number(step?.note);
    const readable = Number.isFinite(note);
    const hasNote = readable && note >= 0;
    // A note-off is a musical event, not an absence: the event-plan compiler
    // emits it with an instrument, so the row is doing something even though
    // the note column reads OFF.
    const hasNoteOff = readable && note === NOTE_OFF;
    const carriesInstrument = explicitInstrument(step);
    const slots = Array.isArray(step?.fx) ? step.fx : [];
    const fxOperative = [];
    for (let index = 0; index < FX_SLOTS; index += 1) fxOperative.push(commandCode(slots[index]) > 0);
    const hasCommand = fxOperative.some(Boolean);
    return Object.freeze({
      hasNote,
      hasNoteOff,
      hasCommand,
      carriesInstrument,
      // The row does something when played - including setting the Instrument
      // that the rows after it will use.
      operative: hasNote || hasNoteOff || hasCommand || carriesInstrument,
      // Velocity is how hard a note is struck. A release is not struck, and an
      // effect sharing the row is not a note for it to describe.
      velocityOperative: hasNote,
      // Live for this row's own note or release, and for an assignment this
      // row hands to the rows that follow.
      instrumentOperative: hasNote || hasNoteOff || carriesInstrument,
      fxOperative: Object.freeze(fxOperative),
    });
  }

  // One word for "stored, but nothing is applying it right now". The grid
  // already says "not set" with `empty`; this says "set, and inert".
  const INOPERATIVE_CLASS = "inoperative";

  function velocityTitle(presentation) {
    return presentation?.velocityOperative
      ? "Velocity"
      : "Velocity · stored, but this row has no note to apply it to";
  }

  function instrumentTitle(presentation, resolvedTitle) {
    const base = String(resolvedTitle ?? "Instrument");
    if (!presentation?.instrumentOperative) return `${base} · stored, but this row has no note to play it`;
    // Worth saying out loud: this is how a musician discovers that an
    // Instrument set on a note-less row reaches the rows below it.
    if (!presentation.hasNote && !presentation.hasNoteOff && presentation.carriesInstrument) {
      return `${base} · carried to the rows that follow`;
    }
    return base;
  }

  const api = Object.freeze({
    FX_SLOTS,
    INOPERATIVE_CLASS,
    phraseRowPresentation,
    velocityTitle,
    instrumentTitle,
  });
  globalThis.BRKTRKPhraseRowPresentation = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
