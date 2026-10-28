export const BRK_SYNTH_ABI_MAJOR = 1;
export const BRK_SYNTH_ABI_MINOR = 0;
export const BRK_SYNTH_ABI_VERSION =
  (BRK_SYNTH_ABI_MAJOR << 16) | BRK_SYNTH_ABI_MINOR;

export const EventType = {
  NoteOn: 1,
  NoteOff: 2,
  NoteChoke: 3,
  Retrigger: 4,
  ParameterValue: 5,
  ParameterRamp: 6,
  AllNotesOff: 7,
  Reset: 8,
  Sustain: 9,
} as const;

export const EventSize = {
  Header: 12,
  Note: 28,
  ParameterValue: 24,
  ParameterRamp: 32,
  Sustain: 20,
} as const;

export const ParameterType = {
  Continuous: 1,
  Stepped: 2,
  Enum: 3,
  Boolean: 4,
} as const;

export const ParameterFlags = {
  Automatable: 1 << 0,
  Modulatable: 1 << 1,
  PerNote: 1 << 2,
  Hidden: 1 << 3,
  ReadOnly: 1 << 4,
  RequiresReconfigure: 1 << 5,
} as const;

export const ParameterDescriptorSize = 96;
export const ParameterDescriptorFixtureMagic = 0x444b5242;
export const ParameterDescriptorFixtureHeaderSize = 16;

export interface EventHeader {
  size: number;
  type: number;
  frameOffset: number;
  flags: number;
}

export interface NoteEvent extends EventHeader {
  noteId: number;
  key: number;
  channel: number;
  velocity: number;
  tuningSemitones: number;
}

export interface ParameterValueEvent extends EventHeader {
  parameterId: number;
  normalizedValue: number;
  noteId: number;
}

export interface SustainEvent extends EventHeader {
  down: boolean;
}

export interface StringRef {
  offset: number;
  byteSize: number;
}

export interface ParameterDescriptor {
  structSize: number;
  parameterId: number;
  parameterType: number;
  flags: number;
  key: StringRef;
  displayName: StringRef;
  unit: StringRef;
  groupKey: StringRef;
  normalizedDefault: number;
  plainMin: number;
  plainMax: number;
  plainStep: number;
  enumValueCount: number;
}

export interface ParameterDescriptorFixtureHeader {
  magic: number;
  descriptorCount: number;
  descriptorSize: number;
  stringPoolOffset: number;
}

function requireRange(view: DataView, offset: number, byteSize: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + byteSize > view.byteLength) {
    throw new RangeError(`ABI read outside buffer: offset=${offset}, size=${byteSize}`);
  }
}

export function readEventHeader(view: DataView, offset: number): EventHeader {
  requireRange(view, offset, EventSize.Header);
  return {
    size: view.getUint16(offset, true),
    type: view.getUint16(offset + 2, true),
    frameOffset: view.getUint32(offset + 4, true),
    flags: view.getUint32(offset + 8, true),
  };
}

export function readNoteEvent(view: DataView, offset: number): NoteEvent {
  requireRange(view, offset, EventSize.Note);
  const header = readEventHeader(view, offset);
  if (header.size !== EventSize.Note) throw new Error(`Bad note event size ${header.size}`);
  return {
    ...header,
    noteId: view.getUint32(offset + 12, true),
    key: view.getInt16(offset + 16, true),
    channel: view.getInt16(offset + 18, true),
    velocity: view.getFloat32(offset + 20, true),
    tuningSemitones: view.getFloat32(offset + 24, true),
  };
}

export function readParameterValueEvent(
  view: DataView,
  offset: number,
): ParameterValueEvent {
  requireRange(view, offset, EventSize.ParameterValue);
  const header = readEventHeader(view, offset);
  if (header.size !== EventSize.ParameterValue) {
    throw new Error(`Bad parameter event size ${header.size}`);
  }
  return {
    ...header,
    parameterId: view.getUint32(offset + 12, true),
    normalizedValue: view.getFloat32(offset + 16, true),
    noteId: view.getUint32(offset + 20, true),
  };
}

export function readSustainEvent(view: DataView, offset: number): SustainEvent {
  requireRange(view, offset, EventSize.Sustain);
  const header = readEventHeader(view, offset);
  if (header.size !== EventSize.Sustain) {
    throw new Error(`Bad sustain event size ${header.size}`);
  }
  return {
    ...header,
    down: view.getUint32(offset + 12, true) !== 0,
  };
}

export function readStringRef(view: DataView, offset: number): StringRef {
  requireRange(view, offset, 8);
  const result = {
    offset: view.getUint32(offset, true),
    byteSize: view.getUint32(offset + 4, true),
  };
  requireRange(view, result.offset, result.byteSize);
  return result;
}

export function readUtf8String(view: DataView, reference: StringRef): string {
  requireRange(view, reference.offset, reference.byteSize);
  const bytes = new Uint8Array(
    view.buffer,
    view.byteOffset + reference.offset,
    reference.byteSize,
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function readParameterDescriptor(
  view: DataView,
  offset: number,
): ParameterDescriptor {
  requireRange(view, offset, ParameterDescriptorSize);
  const structSize = view.getUint32(offset, true);
  if (structSize !== ParameterDescriptorSize) {
    throw new Error(`Bad parameter descriptor size ${structSize}`);
  }
  return {
    structSize,
    parameterId: view.getUint32(offset + 4, true),
    parameterType: view.getUint32(offset + 8, true),
    flags: view.getUint32(offset + 12, true),
    key: readStringRef(view, offset + 16),
    displayName: readStringRef(view, offset + 24),
    unit: readStringRef(view, offset + 32),
    groupKey: readStringRef(view, offset + 40),
    normalizedDefault: view.getFloat32(offset + 48, true),
    plainMin: view.getFloat32(offset + 52, true),
    plainMax: view.getFloat32(offset + 56, true),
    plainStep: view.getFloat32(offset + 60, true),
    enumValueCount: view.getUint32(offset + 64, true),
  };
}

export function readParameterDescriptorFixtureHeader(
  view: DataView,
): ParameterDescriptorFixtureHeader {
  requireRange(view, 0, ParameterDescriptorFixtureHeaderSize);
  const result = {
    magic: view.getUint32(0, true),
    descriptorCount: view.getUint32(4, true),
    descriptorSize: view.getUint32(8, true),
    stringPoolOffset: view.getUint32(12, true),
  };
  if (result.magic !== ParameterDescriptorFixtureMagic) {
    throw new Error(`Bad descriptor fixture magic 0x${result.magic.toString(16)}`);
  }
  if (result.descriptorSize !== ParameterDescriptorSize) {
    throw new Error(`Bad descriptor record size ${result.descriptorSize}`);
  }
  const recordsEnd = ParameterDescriptorFixtureHeaderSize
    + result.descriptorCount * result.descriptorSize;
  if (result.stringPoolOffset !== recordsEnd || recordsEnd > view.byteLength) {
    throw new Error(`Bad descriptor string pool offset ${result.stringPoolOffset}`);
  }
  return result;
}
