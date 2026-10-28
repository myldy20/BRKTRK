import {
  AssetArenaFlags,
  AssetArenaSize,
  AssetBindingSize,
  AssetFormat,
  BRK_SYNTH_ASSET_EXT_VERSION,
  readAssetArenaV1,
  readAssetBindingV1,
  validatePcm16Binding,
} from "./brk_synth_asset_ext.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(BRK_SYNTH_ASSET_EXT_VERSION === 0x00010000, "Asset Extension version mismatch");

const bytes = new Uint8Array(AssetArenaSize + AssetBindingSize);
const view = new DataView(bytes.buffer);

view.setUint32(0, AssetArenaSize, true);
view.setUint32(4, 4096, true);
view.setUint32(8, 32768, true);
view.setUint32(12, 16, true);
view.setUint32(16, AssetArenaFlags.HostWritable | AssetArenaFlags.StoppedOnly, true);

const bindingOffset = AssetArenaSize;
view.setUint32(bindingOffset + 0, AssetBindingSize, true);
view.setUint32(bindingOffset + 4, 0, true);
view.setUint32(bindingOffset + 8, AssetFormat.PcmS16Interleaved, true);
view.setUint32(bindingOffset + 12, 0, true);
view.setUint32(bindingOffset + 16, 4096, true);
view.setUint32(bindingOffset + 20, 19200, true);
view.setUint32(bindingOffset + 24, 4800, true);
view.setUint32(bindingOffset + 28, 2, true);
view.setUint32(bindingOffset + 32, 48000, true);

const arena = readAssetArenaV1(view, 0);
const binding = readAssetBindingV1(view, bindingOffset);
validatePcm16Binding(arena, binding);

assert(arena.dataOffset === 4096, "arena data offset");
assert(arena.byteCapacity === 32768, "arena capacity");
assert(arena.alignment === 16, "arena alignment");
assert((arena.flags & AssetArenaFlags.HostWritable) !== 0, "host-writable flag");
assert((arena.flags & AssetArenaFlags.StoppedOnly) !== 0, "stopped-only flag");
assert(binding.assetSlot === 0, "asset slot");
assert(binding.frameCount === 4800, "frame count");
assert(binding.channelCount === 2, "channel count");
assert(binding.sampleRateHz === 48000, "sample rate");

const badBytes = new Uint8Array(bytes);
const badView = new DataView(badBytes.buffer);
badView.setUint32(bindingOffset + 20, 19198, true);
let rejected = false;
try {
  validatePcm16Binding(readAssetArenaV1(badView), readAssetBindingV1(badView, bindingOffset));
} catch {
  rejected = true;
}
assert(rejected, "bad PCM byte count must fail closed");

console.log(`asset_ext_version=0x${BRK_SYNTH_ASSET_EXT_VERSION.toString(16)}`);
console.log(`asset_arena_size=${AssetArenaSize}`);
console.log(`asset_binding_size=${AssetBindingSize}`);
console.log("asset_ext_typescript=PASS");
