const assert = require("node:assert/strict");
const domain = require("./phrase-row-presentation.js");

const EMPTY = -1;
const NOTE_OFF = -2;
const emptyFx = () => [{ command: 0, value: 0 }, { command: 0, value: 0 }, { command: 0, value: 0 }];
const row = (over = {}) => domain.phraseRowPresentation({ note: EMPTY, velocity: 100, instrument: EMPTY, fx: emptyFx(), ...over });

// The row this issue is about. Nothing here plays, yet the grid drew velocity
// with no class at all, at full brightness, beside a note reading "---".
{
  const empty = row();
  assert.equal(empty.operative, false);
  assert.equal(empty.velocityOperative, false, "velocity cannot apply to a row with no note");
  assert.equal(empty.instrumentOperative, false, "the Instrument is the note's, and there is no note");
  assert.deepEqual([...empty.fxOperative], [false, false, false]);
  assert.match(domain.velocityTitle(empty), /no note to apply it to/,
    "an inert value must say why it is inert, not merely look faded");
  assert.match(domain.instrumentTitle(empty, "Instrument 01"), /Instrument 01 · /);
}

// An ordinary playing row is untouched.
{
  const playing = row({ note: 48 });
  assert.equal(playing.operative, true);
  assert.equal(playing.velocityOperative, true);
  assert.equal(playing.instrumentOperative, true);
  assert.equal(domain.velocityTitle(playing), "Velocity", "a live value does not need explaining");
  assert.equal(domain.instrumentTitle(playing, "Instrument 01"), "Instrument 01");
}

// The lowest note is note 0. An off-by-one here would grey out an octave.
assert.equal(row({ note: 0 }).velocityOperative, true);
assert.equal(row({ note: 127 }).velocityOperative, true);

// A note-off is an event, not an absence: event-plan-compiler.js emits it with
// an instrument. It is not struck, though, so it has no velocity to show.
{
  const off = row({ note: NOTE_OFF });
  assert.equal(off.hasNote, false);
  assert.equal(off.hasNoteOff, true);
  assert.equal(off.operative, true, "a release is something the row does");
  assert.equal(off.velocityOperative, false, "a release is not struck at a velocity");
  assert.equal(off.instrumentOperative, true, "the compiler carries an instrument for a note-off");
}

// An Instrument written on a note-less row is not inert: resolveCyclicInstrumentIds()
// in event-plan-compiler.js reads an explicit instrument from every step and
// carries it into the rows that follow, seeding the cycle from the last
// explicit one so it wraps. Dimming such a row while claiming nothing uses it
// would be a lie about audible playback.
{
  const carrier = row({ instrument: 3 });
  assert.equal(carrier.hasNote, false);
  assert.equal(carrier.carriesInstrument, true);
  assert.equal(carrier.operative, true, "a row that sets the Instrument for later rows does something");
  assert.equal(carrier.instrumentOperative, true, "the assignment reaches the rows below it");
  assert.equal(carrier.velocityOperative, false, "it still has no note of its own to strike");
  assert.equal(
    domain.instrumentTitle(carrier, "Instrument 03"),
    "Instrument 03 · carried to the rows that follow",
    "the surface should teach the carry rather than only dim or not dim",
  );
}

// A row with no note and no Instrument of its own is the genuinely silent case.
{
  const silent = row();
  assert.equal(silent.carriesInstrument, false);
  assert.equal(silent.operative, false);
  assert.equal(silent.instrumentOperative, false);
}

// Instrument 0 is a real assignment. An off-by-one here would silently drop the
// first Instrument in the pool out of the carry.
assert.equal(row({ instrument: 0 }).carriesInstrument, true);
assert.equal(row({ instrument: 255 }).carriesInstrument, true);
// project-storage clamps instrument to an integer in [-1, 255], so the values
// below are the whole stored domain. The rule must match the compiler's own
// explicitInstrument() over all of it, or the grid would dim a row the plan
// still carries.
for (let instrument = -1; instrument <= 255; instrument += 1) {
  assert.equal(row({ instrument }).carriesInstrument, instrument >= 0, `instrument ${instrument}`);
}
// Outside that domain, what matters is not a rule of this module's own but
// agreement with the compiler, which decides what actually gets carried.
// event-plan-compiler.js reads it as: Number.isInteger(Number(v)) && v >= 0.
const compilerWouldCarry = (value) => Number.isInteger(Number(value)) && Number(value) >= 0;
for (const instrument of [undefined, null, NaN, "3", "x", 1.5, -0.5, [], {}, true]) {
  assert.equal(
    row({ instrument }).carriesInstrument,
    compilerWouldCarry(instrument),
    `the grid must dim exactly what the plan leaves out: ${JSON.stringify(instrument)}`,
  );
}

// A note row keeps the plain title: the carry is worth explaining only where it
// is the reason the cell is live.
assert.equal(domain.instrumentTitle(row({ note: 48, instrument: 3 }), "Instrument 03"), "Instrument 03");

// A tracker runs effects on rows that carry no note, so FX is judged per slot
// and the note's own settings do not become operative because an effect shares
// the row.
{
  const fxOnly = row({ fx: [{ command: 5, value: 9 }, { command: 0, value: 0 }, { command: 0, value: 0 }] });
  assert.equal(fxOnly.hasCommand, true);
  assert.equal(fxOnly.operative, true, "a row with an effect and no note still does something");
  assert.equal(fxOnly.velocityOperative, false, "an effect is not a note for the velocity to describe");
  assert.equal(fxOnly.instrumentOperative, false);
  assert.deepEqual([...fxOnly.fxOperative], [true, false, false]);
}

// The grid decides "is there a note here" with `step.note < 0`, over notes that
// project-storage has already clamped to integers in [NOTE_OFF, 127]. Across
// that whole stored range the two must agree, or the note column and the
// velocity column would argue about whether the row plays.
for (let note = NOTE_OFF; note <= 127; note += 1) {
  assert.equal(row({ note }).velocityOperative, !(note < 0), `note ${note}`);
}

// FX slots appear in several shapes across the codebase; this reads them all
// the way the grid's own fxCommandCode does.
assert.deepEqual([...row({ fx: [7, { commandCode: 3 }, { command: 0 }] }).fxOperative], [true, true, false]);

// Runs on every redraw, so a short or absent row must not throw.
for (const step of [undefined, null, {}, { fx: null }, { note: EMPTY, fx: [] }]) {
  const presentation = domain.phraseRowPresentation(step);
  assert.equal(presentation.fxOperative.length, domain.FX_SLOTS, `all ${domain.FX_SLOTS} slots reported: ${JSON.stringify(step)}`);
  assert.equal(presentation.operative, false, "a row with nothing readable in it claims nothing");
}

// A presentation is a reading of the row, so nothing displaying it can edit it.
{
  const frozen = row({ note: 48 });
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.fxOperative), true);
}

console.log("Phrase row presentation tests passed");
