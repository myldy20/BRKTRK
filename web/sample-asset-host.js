(() => {
  "use strict";

  const domain = globalThis.BRKTRKSampleAssetDomain
    ?? (typeof require !== "undefined" ? require("./sample-asset-domain.js") : null);
  const storeApi = globalThis.BRKTRKSampleAssetStore
    ?? (typeof require !== "undefined" ? require("./sample-asset-store.js") : null);
  if (!domain || !storeApi) throw new Error("BRKTRK sample asset host requires sample asset domain + store");

  const nodeSignatures = new WeakMap();
  let defaultStoreInstance = null;

  class SampleAssetHostError extends Error {
    constructor(code, message, details = null) {
      super(message);
      this.name = "SampleAssetHostError";
      this.code = code;
      this.details = details;
    }
  }

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

  function projectAssetRefs(project) {
    const pool = project?.instrumentPool && typeof project.instrumentPool === "object"
      ? project.instrumentPool
      : {};
    const bySha = new Map();
    for (const instrument of Array.isArray(pool) ? pool : Object.values(pool)) {
      const ref = instrument?.assetRef;
      if (!ref) continue;
      const sha = String(ref.sha256 ?? "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha)) {
        throw new SampleAssetHostError("sample-asset-ref-invalid", "Project contains an invalid sample asset SHA-256", { assetRef: clone(ref) });
      }
      const normalized = Object.freeze({ ...clone(ref), sha256: sha });
      const prior = bySha.get(sha);
      if (prior) {
        for (const field of ["schema","format","sampleRateHz","channelCount","frameCount","byteSize"]) {
          if (prior[field] !== normalized[field]) {
            throw new SampleAssetHostError("sample-asset-ref-conflict", `Project contains conflicting metadata for sample asset ${sha}`, { field, left: prior[field], right: normalized[field] });
          }
        }
      } else bySha.set(sha, normalized);
    }
    return Object.freeze([...bySha.values()].sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0));
  }

  function projectAssetSignature(project) {
    return JSON.stringify(projectAssetRefs(project).map((ref) => [
      ref.sha256,
      ref.schema,
      ref.format,
      ref.sampleRateHz,
      ref.channelCount,
      ref.frameCount,
      ref.byteSize,
    ]));
  }

  function defaultStore() {
    if (defaultStoreInstance) return defaultStoreInstance;
    if (!globalThis.indexedDB) {
      throw new SampleAssetHostError("sample-asset-store-unavailable", "Sample assets are required but IndexedDB is unavailable");
    }
    defaultStoreInstance = storeApi.createIndexedDbStore();
    return defaultStoreInstance;
  }

  function sameMetadata(left, right) {
    return ["schema","format","sha256","sampleRateHz","channelCount","frameCount","byteSize"]
      .every((field) => left?.[field] === right?.[field]);
  }

  async function loadProjectAssets(project, options = {}) {
    const refs = projectAssetRefs(project);
    if (!refs.length) return Object.freeze([]);
    const store = options.store ?? defaultStore();
    if (!store?.get) throw new SampleAssetHostError("sample-asset-store-unavailable", "Sample asset store does not provide get()");
    const records = [];
    for (const ref of refs) {
      const stored = await store.get(ref.sha256);
      if (!stored) {
        throw new SampleAssetHostError("sample-asset-missing", `Sample asset ${ref.sha256} is not available on this device`, { assetRef: clone(ref) });
      }
      if (!sameMetadata(stored.ref, ref)) {
        throw new SampleAssetHostError("sample-asset-metadata-mismatch", `Stored sample asset metadata disagrees with Project for ${ref.sha256}`, {
          project: clone(ref),
          stored: clone(stored.ref),
        });
      }
      const bytes = stored.pcmBytes instanceof Uint8Array
        ? new Uint8Array(stored.pcmBytes)
        : new Uint8Array(stored.pcmBytes);
      await domain.verifyAsset(ref, bytes);
      records.push(Object.freeze({ ref: Object.freeze(clone(ref)), pcmBytes: bytes }));
    }
    return Object.freeze(records);
  }

  function isNodeSynced(node, project) {
    if (!node || typeof node !== "object") return false;
    return nodeSignatures.get(node) === projectAssetSignature(project);
  }

  async function syncNode(node, project, options = {}) {
    if (!node?.port?.postMessage) throw new SampleAssetHostError("sample-asset-node-unavailable", "AudioWorklet node is unavailable for sample asset synchronization");
    const signature = projectAssetSignature(project);
    if (!options.force && nodeSignatures.get(node) === signature) return false;
    const records = await loadProjectAssets(project, options);
    const assets = records.map((record) => ({
      ref: clone(record.ref),
      pcmBytes: new Uint8Array(record.pcmBytes),
    }));
    const transfers = assets.map((record) => record.pcmBytes.buffer);
    node.port.postMessage({ type: "production-assets", assets }, transfers);
    nodeSignatures.set(node, signature);
    return Object.freeze({
      assetCount: assets.length,
      byteCount: assets.reduce((sum, record) => sum + record.ref.byteSize, 0),
      signature,
    });
  }

  function forgetNode(node) {
    return node && typeof node === "object" ? nodeSignatures.delete(node) : false;
  }

  const api = Object.freeze({
    SampleAssetHostError,
    projectAssetRefs,
    projectAssetSignature,
    loadProjectAssets,
    isNodeSynced,
    syncNode,
    forgetNode,
  });

  globalThis.BRKTRKSampleAssetHost = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
