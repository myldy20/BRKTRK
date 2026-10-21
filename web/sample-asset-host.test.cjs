const assert = require("node:assert/strict");
const assetDomain = require("./sample-asset-domain.js");
const assetHost = require("./sample-asset-host.js");

const ref = {
  schema: "brktrk-pcm-asset-ref-v1",
  format: "pcm-s16-interleaved",
  sha256: null,
  sampleRateHz: 48000,
  channelCount: 1,
  frameCount: 2,
  byteSize: 4,
  sourceName: "fixture.wav",
};

(async () => {
  const pcmBytes = Uint8Array.from([1, 0, 2, 0]);
  const builtRef = await assetDomain.assetRefForPcm(ref, pcmBytes, { sourceName: ref.sourceName });
  const project = {
    instrumentPool: {
      1: { id: 1, assetRef: builtRef },
      2: { id: 2, assetRef: { ...builtRef, sourceName: "same-content-renamed.wav" } },
    },
  };
  assert.equal(assetHost.projectAssetRefs(project).length, 1, "same SHA must dedupe across Instruments");
  assert.match(assetHost.projectAssetSignature(project), new RegExp(builtRef.sha256));

  const storedBytes = new Uint8Array(pcmBytes);
  const store = {
    async get(sha) {
      assert.equal(sha, builtRef.sha256);
      return { ref: builtRef, pcmBytes: new Uint8Array(storedBytes) };
    },
  };
  const messages = [];
  const node = {
    port: {
      postMessage(message, transfers) {
        messages.push({ message, transfers });
      },
    },
  };

  const first = await assetHost.syncNode(node, project, { store });
  assert.equal(first.assetCount, 1);
  assert.equal(first.byteCount, 4);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.type, "production-assets");
  assert.equal(messages[0].message.assets.length, 1);
  assert.equal(messages[0].message.assets[0].ref.sha256, builtRef.sha256);
  assert.deepEqual([...messages[0].message.assets[0].pcmBytes], [...pcmBytes]);
  assert.equal(messages[0].transfers.length, 1);
  assert.equal(messages[0].transfers[0], messages[0].message.assets[0].pcmBytes.buffer);
  assert.equal(assetHost.isNodeSynced(node, project), true);

  assert.equal(await assetHost.syncNode(node, project, { store }), false, "unchanged Project assets must not resend");
  assert.equal(messages.length, 1);
  await assetHost.syncNode(node, project, { store, force: true });
  assert.equal(messages.length, 2, "force must resend authoritative asset snapshot");

  const emptyNodeMessages = [];
  const emptyNode = { port: { postMessage(message, transfers) { emptyNodeMessages.push({ message, transfers }); } } };
  const empty = await assetHost.syncNode(emptyNode, { instrumentPool: {} }, { store });
  assert.equal(empty.assetCount, 0);
  assert.deepEqual(emptyNodeMessages[0].message, { type: "production-assets", assets: [] }, "empty Project must clear Worklet assets");

  const missingStore = { async get() { return null; } };
  await assert.rejects(
    () => assetHost.syncNode({ port: { postMessage() { throw new Error("must not post"); } } }, project, { store: missingStore }),
    (error) => error?.code === "sample-asset-missing" && error?.details?.assetRef?.sha256 === builtRef.sha256,
  );

  const badStored = { ...builtRef, frameCount: 3, byteSize: 6 };
  await assert.rejects(
    () => assetHost.loadProjectAssets(project, { store: { async get() { return { ref: badStored, pcmBytes: Uint8Array.from([1,0,2,0,3,0]) }; } } }),
    (error) => error?.code === "sample-asset-metadata-mismatch",
  );

  const conflictProject = {
    instrumentPool: {
      1: { assetRef: builtRef },
      2: { assetRef: { ...builtRef, sampleRateHz: 44100 } },
    },
  };
  assert.throws(
    () => assetHost.projectAssetRefs(conflictProject),
    (error) => error?.code === "sample-asset-ref-conflict",
  );

  console.log("Sample asset Host synchronization contract passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
