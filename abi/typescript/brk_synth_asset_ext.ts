export const BRK_SYNTH_ASSET_EXT_MAJOR = 1;
export const BRK_SYNTH_ASSET_EXT_MINOR = 0;
export const BRK_SYNTH_ASSET_EXT_VERSION =
  (BRK_SYNTH_ASSET_EXT_MAJOR << 16) | BRK_SYNTH_ASSET_EXT_MINOR;

export const AssetFormat = {
  PcmS16Interleaved: 1,
} as const;

export const AssetArenaFlags = {
  HostWritable: 1 << 0,
  StoppedOnly: 1 << 1,
} as const;

export const AssetArenaSize = 48;
export const AssetBindingSize = 64;

export interface AssetArenaV1 {
  structSize: number;
  dataOffset: number;
  byteCapacity: number;
  alignment: number;
  flags: number;
}

export interface AssetBindingV1 {
  structSize: number;
  assetSlot: number;
  format: number;
  flags: number;
  dataOffset: number;
  byteSize: number;
  frameCount: number;
  channelCount: number;
  sampleRateHz: number;
}

function requireRange(view: DataView, offset: number, byteSize: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + byteSize > view.byteLength) {
    throw new RangeError(`Asset Extension read outside buffer: offset=${offset}, size=${byteSize}`);
  }
}

export function readAssetArenaV1(view: DataView, offset = 0): AssetArenaV1 {
  requireRange(view, offset, AssetArenaSize);
  const structSize = view.getUint32(offset, true);
  if (structSize !== AssetArenaSize) throw new Error(`Bad asset arena size ${structSize}`);
  return {
    structSize,
    dataOffset: view.getUint32(offset + 4, true),
    byteCapacity: view.getUint32(offset + 8, true),
    alignment: view.getUint32(offset + 12, true),
    flags: view.getUint32(offset + 16, true),
  };
}

export function readAssetBindingV1(view: DataView, offset = 0): AssetBindingV1 {
  requireRange(view, offset, AssetBindingSize);
  const structSize = view.getUint32(offset, true);
  if (structSize !== AssetBindingSize) throw new Error(`Bad asset binding size ${structSize}`);
  return {
    structSize,
    assetSlot: view.getUint32(offset + 4, true),
    format: view.getUint32(offset + 8, true),
    flags: view.getUint32(offset + 12, true),
    dataOffset: view.getUint32(offset + 16, true),
    byteSize: view.getUint32(offset + 20, true),
    frameCount: view.getUint32(offset + 24, true),
    channelCount: view.getUint32(offset + 28, true),
    sampleRateHz: view.getUint32(offset + 32, true),
  };
}

export function validatePcm16Binding(
  arena: AssetArenaV1,
  binding: AssetBindingV1,
): void {
  if (binding.format !== AssetFormat.PcmS16Interleaved) {
    throw new Error(`Unsupported asset format ${binding.format}`);
  }
  if (binding.channelCount !== 1 && binding.channelCount !== 2) {
    throw new Error(`Unsupported channel count ${binding.channelCount}`);
  }
  if (!Number.isInteger(binding.sampleRateHz) || binding.sampleRateHz < 1000 || binding.sampleRateHz > 384000) {
    throw new Error(`Invalid sample rate ${binding.sampleRateHz}`);
  }
  if (!Number.isInteger(binding.frameCount) || binding.frameCount <= 0) {
    throw new Error(`Invalid frame count ${binding.frameCount}`);
  }
  const expectedBytes = binding.frameCount * binding.channelCount * 2;
  if (!Number.isSafeInteger(expectedBytes) || binding.byteSize !== expectedBytes) {
    throw new Error(`PCM16 byte count mismatch ${binding.byteSize} != ${expectedBytes}`);
  }
  if (!Number.isInteger(arena.alignment) || arena.alignment <= 0 || (arena.alignment & (arena.alignment - 1)) !== 0) {
    throw new Error(`Invalid arena alignment ${arena.alignment}`);
  }
  if ((binding.dataOffset % arena.alignment) !== 0) {
    throw new Error(`Asset span is not aligned: ${binding.dataOffset}`);
  }
  const arenaEnd = arena.dataOffset + arena.byteCapacity;
  const bindingEnd = binding.dataOffset + binding.byteSize;
  if (!Number.isSafeInteger(arenaEnd) || !Number.isSafeInteger(bindingEnd)
      || binding.dataOffset < arena.dataOffset || bindingEnd > arenaEnd) {
    throw new RangeError("Asset binding span escapes arena");
  }
}
