import { readFileSync } from "node:fs";
import {
  BRK_SYNTH_ABI_VERSION,
  EventSize,
  EventType,
  readNoteEvent,
  readParameterValueEvent,
  readSustainEvent,
} from "./brk_synth_abi.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const fixturePath = process.argv[2];
assert(fixturePath, "fixture path is required");
const bytes = readFileSync(fixturePath);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
assert(BRK_SYNTH_ABI_VERSION === 0x00010000, "ABI version mismatch");
assert(bytes.byteLength === EventSize.Note + EventSize.ParameterValue + EventSize.Sustain,
  `fixture size mismatch: ${bytes.byteLength}`);

const note = readNoteEvent(view, 0);
assert(note.type === EventType.NoteOn, "note type");
assert(note.frameOffset === 7, "note frame offset");
assert(note.flags === 0x01020304, "note flags");
assert(note.noteId === 0x11223344, "note id");
assert(note.key === 60, "note key");
assert(note.channel === -1, "note channel");
assert(note.velocity === 0.75, "note velocity");
assert(note.tuningSemitones === -0.25, "note tuning");

const parameterOffset = EventSize.Note;
const parameter = readParameterValueEvent(view, parameterOffset);
assert(parameter.type === EventType.ParameterValue, "parameter type");
assert(parameter.frameOffset === 11, "parameter frame offset");
assert(parameter.parameterId === 0x1003, "parameter id");
assert(parameter.normalizedValue === 0.5, "parameter value");
assert(parameter.noteId === 0, "global parameter note id");

const sustainOffset = EventSize.Note + EventSize.ParameterValue;
const sustain = readSustainEvent(view, sustainOffset);
assert(sustain.type === EventType.Sustain, "sustain type");
assert(sustain.frameOffset === 13, "sustain frame offset");
assert(sustain.down, "sustain down");

console.log(`fixture_bytes=${bytes.byteLength}`);
console.log(`note_id=0x${note.noteId.toString(16)}`);
console.log(`parameter_id=0x${parameter.parameterId.toString(16)}`);
