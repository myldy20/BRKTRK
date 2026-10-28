import { readFileSync } from "node:fs";
import {
  ParameterDescriptorFixtureHeaderSize,
  ParameterDescriptorSize,
  ParameterFlags,
  ParameterType,
  readParameterDescriptor,
  readParameterDescriptorFixtureHeader,
  readUtf8String,
} from "./brk_synth_abi.ts";

const path = process.argv[2];
if (!path) throw new Error("descriptor fixture path required");
const bytes = readFileSync(path);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const header = readParameterDescriptorFixtureHeader(view);
if (header.descriptorCount !== 89) throw new Error(`descriptor count ${header.descriptorCount}`);

const ids = new Set<number>();
const byKey = new Map<string, ReturnType<typeof readParameterDescriptor>>();
for (let index = 0; index < header.descriptorCount; index += 1) {
  const offset = ParameterDescriptorFixtureHeaderSize + index * ParameterDescriptorSize;
  const descriptor = readParameterDescriptor(view, offset);
  const key = readUtf8String(view, descriptor.key);
  const name = readUtf8String(view, descriptor.displayName);
  const unit = readUtf8String(view, descriptor.unit);
  const group = readUtf8String(view, descriptor.groupKey);
  if (ids.has(descriptor.parameterId)) throw new Error(`duplicate id ${descriptor.parameterId}`);
  if (byKey.has(key)) throw new Error(`duplicate key ${key}`);
  if (!key || !name || !group) throw new Error(`missing descriptor string at ${index}`);
  if (!(descriptor.normalizedDefault >= 0 && descriptor.normalizedDefault <= 1)) {
    throw new Error(`bad normalized default for ${key}`);
  }
  if (!(descriptor.plainMax > descriptor.plainMin)) throw new Error(`bad range for ${key}`);
  void unit;
  ids.add(descriptor.parameterId);
  byKey.set(key, descriptor);
}

const decay = byKey.get("a_decay");
if (!decay || decay.parameterId !== 0x1003 || decay.parameterType !== ParameterType.Continuous) {
  throw new Error("A decay identity mismatch");
}
if (Math.abs(decay.plainMin - 0.01) > 1e-6 || decay.plainMax !== 100 || Math.abs(decay.plainStep - 0.01) > 1e-6) {
  throw new Error("A decay range mismatch");
}

const stiffness = byKey.get("mallet_stiff");
if (!stiffness || stiffness.parameterId !== 0x3002) throw new Error("mallet stiffness identity mismatch");
if (readUtf8String(view, stiffness.unit) !== "Hz" || stiffness.plainMin !== 100 || stiffness.plainMax !== 5000) {
  throw new Error("mallet stiffness metadata mismatch");
}

const partials = byKey.get("a_partials");
if (!partials || partials.parameterType !== ParameterType.Enum || partials.enumValueCount !== 7) {
  throw new Error("partial enum mismatch");
}

const noiseEngine = byKey.get("brk.noise_engine");
if (!noiseEngine || noiseEngine.parameterType !== ParameterType.Boolean) throw new Error("noise engine type mismatch");
if ((noiseEngine.flags & ParameterFlags.Hidden) === 0
    || (noiseEngine.flags & ParameterFlags.RequiresReconfigure) === 0) {
  throw new Error("noise engine flags mismatch");
}

const last = byKey.get("brk.velocity.inharmonicity");
if (!last || last.parameterId !== 0x4007) throw new Error("last parameter mismatch");

console.log(`descriptor_fixture_bytes=${view.byteLength}`);
console.log(`descriptor_count=${header.descriptorCount}`);
console.log(`string_pool_offset=${header.stringPoolOffset}`);
console.log(`a_decay_default=${decay.normalizedDefault}`);
