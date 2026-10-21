const assert = require("node:assert/strict");
const domain = require("./performer-registry-domain.js");

const assetRef = Object.freeze({
  schema: "brktrk-pcm-asset-ref-v1",
  format: "pcm-s16-interleaved",
  sha256: "a".repeat(64),
  sampleRateHz: 48000,
  channelCount: 1,
  frameCount: 2,
  byteSize: 4,
});
const asset = Object.freeze({ ref: assetRef, pcmBytes: Uint8Array.from([1, 0, 2, 0]) });
const instrument = Object.freeze({
  id: 7,
  engineRef: Object.freeze({ moduleId: "design.myldy.asset", engineId: "asset", resolvedVersion: "1.0.0" }),
  patchState: Object.freeze({ schemaVersion: 1, encoding: "opaque", data: null }),
  parameterSnapshot: Object.freeze({ level: 1 }),
  assetRef,
});
let seen = null;
const engineRecord = Object.freeze({
  manifest: Object.freeze({ moduleId: "design.myldy.asset", engineId: "asset", version: "1.0.0" }),
  factory(input) {
    seen = input;
    return Object.freeze({
      handleEvent() {},
      process() {},
      destroy() {},
      diagnostics: () => Object.freeze({ assetSha256: input.assetRef?.sha256 ?? null }),
    });
  },
});
const registry = domain.createPerformerRegistry({
  engineRegistry: { resolve: () => engineRecord },
  trackCount: 1,
  instrumentProvider: (id) => id === 7 ? instrument : null,
  assetProvider: (ref) => ref?.sha256 === assetRef.sha256 ? asset : null,
  sampleRate: 48000,
});
const slot = registry.prepare(0, 7);
assert.ok(slot);
assert.equal(seen.assetRef, assetRef);
assert.equal(seen.asset, asset);
assert.equal(seen.track, 0);
assert.equal(seen.instrumentId, 7);
assert.equal(seen.sampleRate, 48000);
assert.equal(registry.diagnostics().activeSlots[0].performer.assetSha256, assetRef.sha256);

let withoutProvider = null;
const registryWithoutProvider = domain.createPerformerRegistry({
  engineRegistry: {
    resolve: () => ({
      ...engineRecord,
      factory(input) {
        withoutProvider = input;
        return { handleEvent() {}, process() {} };
      },
    }),
  },
  trackCount: 1,
  instrumentProvider: () => instrument,
});
assert.ok(registryWithoutProvider.prepare(0, 7));
assert.equal(withoutProvider.assetRef, assetRef);
assert.equal(withoutProvider.asset, null, "assetRef remains visible while missing bytes fail later at the ABI boundary");

assert.throws(
  () => domain.createPerformerRegistry({ engineRegistry:{resolve(){}}, instrumentProvider:()=>null, assetProvider:{} }),
  /assetProvider/,
);

console.log("PerformerRegistry generic sample asset provider contract passed");
