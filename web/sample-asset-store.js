(() => {
  "use strict";

  const domain = globalThis.BRKTRKSampleAssetDomain
    ?? (typeof require !== "undefined" ? require("./sample-asset-domain.js") : null);
  if (!domain) throw new Error("BRKTRK sample asset store requires sample-asset-domain");

  const DB_NAME = "brktrk-sample-assets-v1";
  const DB_VERSION = 1;
  const STORE_NAME = "pcmAssets";

  const cloneRef = (ref) => JSON.parse(JSON.stringify(ref));
  const cloneBytes = (value) => {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return new Uint8Array(bytes);
  };

  async function canonicalRecord(ref, pcmBytesValue) {
    const pcmBytes = cloneBytes(pcmBytesValue);
    await domain.verifyAsset(ref, pcmBytes);
    return Object.freeze({
      sha256: ref.sha256,
      ref: Object.freeze(cloneRef(ref)),
      pcmBytes,
    });
  }

  function createMemoryStore() {
    const records = new Map();
    return Object.freeze({
      async put(ref, pcmBytes) {
        const record = await canonicalRecord(ref, pcmBytes);
        const existing = records.get(record.sha256);
        if (existing) {
          await domain.verifyAsset(existing.ref, existing.pcmBytes);
          if (existing.ref.byteSize !== record.ref.byteSize) throw new Error("Content-addressed asset collision");
          return Object.freeze({ inserted: false, ref: cloneRef(existing.ref) });
        }
        records.set(record.sha256, { ref: cloneRef(record.ref), pcmBytes: cloneBytes(record.pcmBytes) });
        return Object.freeze({ inserted: true, ref: cloneRef(record.ref) });
      },
      async get(sha256) {
        const key = String(sha256 ?? "").trim().toLowerCase();
        const record = records.get(key);
        if (!record) return null;
        await domain.verifyAsset(record.ref, record.pcmBytes);
        return Object.freeze({ ref: cloneRef(record.ref), pcmBytes: cloneBytes(record.pcmBytes) });
      },
      async has(sha256) {
        return records.has(String(sha256 ?? "").trim().toLowerCase());
      },
      async delete(sha256) {
        return records.delete(String(sha256 ?? "").trim().toLowerCase());
      },
      async clear() {
        records.clear();
      },
      async count() {
        return records.size;
      },
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
  }

  function openDatabase(indexedDB, name = DB_NAME) {
    if (!indexedDB?.open) throw new Error("IndexedDB is unavailable");
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "sha256" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open sample asset database"));
      request.onblocked = () => reject(new Error("Sample asset database upgrade is blocked"));
    });
  }

  function createIndexedDbStore(options = {}) {
    const indexedDB = options.indexedDB ?? globalThis.indexedDB;
    const databaseName = options.databaseName ?? DB_NAME;
    let dbPromise = null;
    const db = () => (dbPromise ??= openDatabase(indexedDB, databaseName));

    return Object.freeze({
      async put(ref, pcmBytes) {
        const record = await canonicalRecord(ref, pcmBytes);
        const database = await db();
        const readTx = database.transaction(STORE_NAME, "readonly");
        const existing = await requestResult(readTx.objectStore(STORE_NAME).get(record.sha256));
        await transactionDone(readTx);
        if (existing) {
          const existingBytes = new Uint8Array(existing.pcmBytes);
          await domain.verifyAsset(existing.ref, existingBytes);
          return Object.freeze({ inserted: false, ref: cloneRef(existing.ref) });
        }

        const writeTx = database.transaction(STORE_NAME, "readwrite");
        writeTx.objectStore(STORE_NAME).add({
          sha256: record.sha256,
          ref: cloneRef(record.ref),
          pcmBytes: record.pcmBytes.slice().buffer,
        });
        await transactionDone(writeTx);
        return Object.freeze({ inserted: true, ref: cloneRef(record.ref) });
      },

      async get(sha256) {
        const key = String(sha256 ?? "").trim().toLowerCase();
        const database = await db();
        const tx = database.transaction(STORE_NAME, "readonly");
        const record = await requestResult(tx.objectStore(STORE_NAME).get(key));
        await transactionDone(tx);
        if (!record) return null;
        const pcmBytes = new Uint8Array(record.pcmBytes);
        await domain.verifyAsset(record.ref, pcmBytes);
        return Object.freeze({ ref: cloneRef(record.ref), pcmBytes });
      },

      async has(sha256) {
        const key = String(sha256 ?? "").trim().toLowerCase();
        const database = await db();
        const tx = database.transaction(STORE_NAME, "readonly");
        const value = await requestResult(tx.objectStore(STORE_NAME).getKey(key));
        await transactionDone(tx);
        return value !== undefined;
      },

      async delete(sha256) {
        const key = String(sha256 ?? "").trim().toLowerCase();
        const database = await db();
        const tx = database.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        await transactionDone(tx);
        return true;
      },

      async clear() {
        const database = await db();
        const tx = database.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).clear();
        await transactionDone(tx);
      },

      async count() {
        const database = await db();
        const tx = database.transaction(STORE_NAME, "readonly");
        const value = await requestResult(tx.objectStore(STORE_NAME).count());
        await transactionDone(tx);
        return Number(value);
      },

      async close() {
        const database = await db();
        database.close();
        dbPromise = null;
      },
    });
  }

  const api = Object.freeze({
    DB_NAME,
    DB_VERSION,
    STORE_NAME,
    createMemoryStore,
    createIndexedDbStore,
  });

  globalThis.BRKTRKSampleAssetStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
