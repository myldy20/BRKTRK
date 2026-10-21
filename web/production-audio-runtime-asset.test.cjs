const assert = require("node:assert/strict");
const packageDomain = require("./engine-package-domain.js");
require("./engine-registry-domain.js");
require("./performer-registry-domain.js");
require("./synth-gateway-domain.js");
require("./brk-synth-abi-v1-worklet.js");
const production = require("./production-audio-runtime.js");

const runtime = production.createProductionAudioRuntime({ sampleRate: 48000, trackCount: 1 });
const ref = {
  schema: "brktrk-pcm-asset-ref-v1",
  format: "pcm-s16-interleaved",
  sha256: "b".repeat(64),
  sampleRateHz: 48000,
  channelCount: 1,
  frameCount: 2,
  byteSize: 4,
};
const source = Uint8Array.from([1, 0, 2, 0]);
assert.equal(runtime.configureAssets([{ ref, pcmBytes: source }]), 1);
let snapshot = runtime.diagnostics();
assert.deepEqual(snapshot.assets, {
  count: 1,
  snapshotMessages: 1,
  recordsAccepted: 1,
  syncRejections: 0,
});
assert.equal(snapshot.traffic.assetSnapshotMessages, 1);
assert.equal(snapshot.traffic.assetRecordsAccepted, 1);
source[0] = 99;

assert.throws(
  () => runtime.configureAssets([{ ref, pcmBytes: Uint8Array.from([1, 0]) }]),
  /do not match assetRef/,
);
assert.throws(
  () => runtime.configureAssets([{ ref, pcmBytes: Uint8Array.from([1,0,2,0]) }, { ref, pcmBytes: Uint8Array.from([1,0,2,0]) }]),
  (error) => error?.code === "duplicate-asset",
);

runtime.beginBlock(0, 4);
assert.throws(
  () => runtime.configureAssets([{ ref, pcmBytes: Uint8Array.from([1,0,2,0]) }]),
  (error) => error?.code === "asset-sync-boundary",
);
runtime.endBlock();
snapshot = runtime.diagnostics();
assert.equal(snapshot.assets.syncRejections, 1);

const messages = [];
const messageRuntime = production.createProductionAudioRuntime({
  sampleRate: 48000,
  trackCount: 1,
  postMessage: (message) => messages.push(message),
});
assert.equal(messageRuntime.handleMessage({
  type: "production-assets",
  assets: [{ ref, pcmBytes: Uint8Array.from([1,0,2,0]) }],
}), true);
assert.equal(messageRuntime.diagnostics().assets.count, 1);
assert.ok(messages.some((message) => message.type === "production-diagnostics"));

messageRuntime.beginBlock(100, 4);
assert.equal(messageRuntime.handleMessage({
  type: "production-assets",
  assets: [{ ref, pcmBytes: Uint8Array.from([1,0,2,0]) }],
}), true);
assert.ok(messages.some((message) => message.type === "production-engine-error" && message.code === "asset-sync-boundary"));
messageRuntime.endBlock();

console.log("Production runtime stopped-boundary sample asset snapshot contract passed");
