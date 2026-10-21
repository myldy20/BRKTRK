(() => {
  "use strict";

  const PREVIEW_TOKEN = "a5.5-c1";
  const PATH_RE = /\/__physical\/([0-9a-f]{40})(?:\/|$)/;
  const PREFIX_ROOT = "__brktrk_physical__";

  function candidateCommit(pathname = globalThis.location?.pathname ?? "") {
    return String(pathname).match(PATH_RE)?.[1] ?? null;
  }

  function namespacePrefix(commit, kind) {
    if (!/^[0-9a-f]{40}$/.test(String(commit))) throw new Error("Invalid physical candidate storage commit");
    if (kind !== "local" && kind !== "session") throw new Error("Invalid physical candidate storage kind");
    return `${PREFIX_ROOT}:${commit}:${kind}:`;
  }

  function activateCandidateManifest(root, commit) {
    const manifest = root.document?.querySelector?.('link[rel="manifest"]');
    if (!manifest) return null;
    const href = `./physical-candidate.webmanifest?preview=${encodeURIComponent(PREVIEW_TOKEN)}&candidate=${encodeURIComponent(commit)}`;
    manifest.setAttribute("href", href);
    root.document.documentElement?.setAttribute?.("data-physical-candidate", commit);
    return href;
  }

  function installStorageNamespace(root = globalThis) {
    const commit = candidateCommit(root.location?.pathname);
    if (!commit) return Object.freeze({ active: false, commit: null });

    const StorageCtor = root.Storage;
    const local = root.localStorage;
    const session = root.sessionStorage;
    if (!StorageCtor?.prototype || !local || !session) throw new Error("Physical candidate storage isolation requires Web Storage");

    const proto = StorageCtor.prototype;
    const marker = Symbol.for("brktrk.physicalCandidateStorageScope.v1");
    if (!proto[marker]) {
      const rawGetItem = proto.getItem;
      const rawSetItem = proto.setItem;
      const rawRemoveItem = proto.removeItem;
      const rawKey = proto.key;
      const rawClear = proto.clear;
      const rawLengthGet = Object.getOwnPropertyDescriptor(proto, "length")?.get;
      if (![rawGetItem, rawSetItem, rawRemoveItem, rawKey, rawClear].every((fn) => typeof fn === "function")) {
        throw new Error("Physical candidate storage isolation could not capture Storage methods");
      }

      const prefixFor = (storage) => {
        if (storage === local) return namespacePrefix(commit, "local");
        if (storage === session) return namespacePrefix(commit, "session");
        return null;
      };
      const rawLength = (storage) => typeof rawLengthGet === "function"
        ? Number(rawLengthGet.call(storage))
        : Number(storage.length ?? 0);
      const scopedKeys = (storage, prefix) => {
        const output = [];
        for (let index = 0; index < rawLength(storage); index += 1) {
          const key = rawKey.call(storage, index);
          if (typeof key === "string" && key.startsWith(prefix)) output.push(key);
        }
        return output;
      };

      Object.defineProperties(proto, {
        getItem: {
          configurable: true,
          writable: true,
          value(key) {
            const prefix = prefixFor(this);
            return rawGetItem.call(this, prefix ? `${prefix}${String(key)}` : key);
          },
        },
        setItem: {
          configurable: true,
          writable: true,
          value(key, value) {
            const prefix = prefixFor(this);
            return rawSetItem.call(this, prefix ? `${prefix}${String(key)}` : key, value);
          },
        },
        removeItem: {
          configurable: true,
          writable: true,
          value(key) {
            const prefix = prefixFor(this);
            return rawRemoveItem.call(this, prefix ? `${prefix}${String(key)}` : key);
          },
        },
        key: {
          configurable: true,
          writable: true,
          value(index) {
            const prefix = prefixFor(this);
            if (!prefix) return rawKey.call(this, index);
            const raw = scopedKeys(this, prefix)[Number(index)];
            return typeof raw === "string" ? raw.slice(prefix.length) : null;
          },
        },
        clear: {
          configurable: true,
          writable: true,
          value() {
            const prefix = prefixFor(this);
            if (!prefix) return rawClear.call(this);
            for (const key of scopedKeys(this, prefix)) rawRemoveItem.call(this, key);
          },
        },
        [marker]: {
          configurable: false,
          enumerable: false,
          writable: false,
          value: Object.freeze({ commit }),
        },
      });
    }

    const manifestHref = activateCandidateManifest(root, commit);
    const result = Object.freeze({
      active: true,
      commit,
      localPrefix: namespacePrefix(commit, "local"),
      sessionPrefix: namespacePrefix(commit, "session"),
      manifestHref,
    });
    root.BRKTRKPhysicalCandidateStorageScope = result;
    return result;
  }

  const api = Object.freeze({ PREVIEW_TOKEN, PREFIX_ROOT, candidateCommit, namespacePrefix, activateCandidateManifest, installStorageNamespace });
  globalThis.BRKTRKPhysicalCandidateStorage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined" && typeof document !== "undefined") installStorageNamespace(globalThis);
})();
