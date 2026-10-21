(() => {
  "use strict";

  const packageDomain = globalThis.BRKTRKEnginePackageDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./engine-package-domain.js") : null);
  const loaderDomain = globalThis.BRKTRKEnginePackageLoader
    ?? (typeof module !== "undefined" && module.exports ? require("./engine-package-loader.js") : null);
  const tarDomain = globalThis.BRKTRKEnginePackageTarDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./engine-package-tar-domain.js") : null);
  if (!packageDomain || !loaderDomain || !tarDomain) throw new Error("BRKTRK browser package transport requires package/loader/tar domains");

  // Pre-#349 builds persisted a second exact-SHA archive copy here even though
  // the immutable release/physical-candidate Service Worker cache already owns
  // the same trusted package URL for cold-offline startup. The current transport
  // reads the exact URL from CacheStorage but never creates a second archive owner.
  const LEGACY_CACHE_NAME = "brktrk-engine-packages-v1";
  const RELEASE_CACHE_PREFIX = "brktrk-web-v";
  const PREVIEW_CACHE_PREFIX = "brktrk-web-preview-";
  const TRUST_MODE = "same-origin-pinned-path-v1";
  const TRUST_PUBLISHER = "myldy-brksynth";
  const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
  const retiredCacheStores = new WeakSet();

  class EnginePackageTransportError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "EnginePackageTransportError";
      this.code = String(code || "engine-package-transport-error");
      this.details = Object.freeze({ ...details });
    }
  }

  function trustRoot(baseUrl = globalThis.location?.href ?? "https://invalid.local/") {
    const base = new URL(baseUrl);
    const prefix = new URL("./engines/", base);
    return Object.freeze({ origin: prefix.origin, pathPrefix: prefix.pathname.endsWith("/") ? prefix.pathname : `${prefix.pathname}/` });
  }

  function assertTrustedUrl(value, root, { packageOnly = false } = {}) {
    const url = new URL(value, `${root.origin}${root.pathPrefix}`);
    const requiredPrefix = packageOnly ? `${root.pathPrefix}packages/` : root.pathPrefix;
    if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new EnginePackageTransportError("untrusted-url", `engine URL must use HTTPS: ${url.href}`);
    if (url.origin !== root.origin || !url.pathname.startsWith(requiredPrefix)) throw new EnginePackageTransportError("untrusted-url", `engine URL escaped pinned trust root: ${url.href}`);
    return url;
  }

  function validateCatalogTrust(raw, catalogUrl, root) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EnginePackageTransportError("invalid-catalog", "engine catalog must be an object");
    if (raw?.trust?.mode !== TRUST_MODE || raw?.trust?.publisher !== TRUST_PUBLISHER) throw new EnginePackageTransportError("untrusted-catalog", `engine catalog trust metadata must be ${TRUST_MODE}/${TRUST_PUBLISHER}`);
    assertTrustedUrl(catalogUrl, root);
    return packageDomain.normalizeCatalog(raw);
  }

  async function fetchCatalog({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = globalThis.location?.href, catalogUrl = "./engines/catalog-v1.json" } = {}) {
    if (typeof fetchImpl !== "function") throw new EnginePackageTransportError("fetch-unavailable", "fetch is unavailable for engine catalog");
    const root = trustRoot(baseUrl);
    const requested = assertTrustedUrl(new URL(catalogUrl, baseUrl).href, root);
    const response = await fetchImpl(requested.href, { cache: "no-store", redirect: "follow", credentials: "same-origin" });
    if (!response?.ok) throw new EnginePackageTransportError("catalog-fetch-failed", `engine catalog fetch failed with HTTP ${response?.status ?? 0}`);
    const finalUrl = assertTrustedUrl(response.url || requested.href, root);
    let raw;
    try { raw = await response.json(); } catch { throw new EnginePackageTransportError("invalid-catalog-json", "engine catalog response is invalid JSON"); }
    return Object.freeze({ root, url: finalUrl.href, raw: Object.freeze(raw), catalog: validateCatalogTrust(raw, finalUrl.href, root) });
  }

  async function retireLegacyPackageCache(cacheStorage = globalThis.caches) {
    if (!cacheStorage?.delete || (typeof cacheStorage !== "object" && typeof cacheStorage !== "function")) return false;
    if (retiredCacheStores.has(cacheStorage)) return true;
    try {
      await cacheStorage.delete(LEGACY_CACHE_NAME);
      retiredCacheStores.add(cacheStorage);
      return true;
    } catch {
      return false;
    }
  }

  // An immutable physical candidate Service Worker keys all candidate assets
  // with ?preview=a5.5-c1&__brktrk_preview=<exact SHA>. Looking only for the
  // bare URL misses its fully installed, single-owner archive and needlessly
  // starts a fresh network request (measured 30s for a 52KB engine on Mac).
  // Match the exact Service Worker key first; SHA verification still runs
  // over archive bytes before any manifest or WASM can be evaluated.
  const CANDIDATE_PACKAGE_RE = /^\/__physical\/([0-9a-f]{40})\/engines\/packages\/.+$/;
  const CANDIDATE_PREVIEW_TOKEN = "a5.5-c1";
  const CANDIDATE_PREVIEW_KEY_PARAM = "__brktrk_preview";
  function candidatePackageCacheKey(packageUrl) {
    const url = new URL(packageUrl.href);
    const candidate = url.pathname.match(CANDIDATE_PACKAGE_RE)?.[1];
    if (!candidate) return null;
    url.searchParams.delete("v");
    url.searchParams.set("preview", CANDIDATE_PREVIEW_TOKEN);
    url.searchParams.set(CANDIDATE_PREVIEW_KEY_PARAM, candidate);
    return url.href;
  }

  async function cachedPackageResponse(cacheStorage, packageUrl) {
    if (!cacheStorage?.match) return null;
    try {
      const previewKey = candidatePackageCacheKey(packageUrl);
      if (previewKey) {
        const pinned = await cacheStorage.match(previewKey);
        if (pinned) return pinned;
      }
      // Root release packages and historical bare-URL cache identities still
      // resolve here. Never write a duplicate archive namespace.
      return await cacheStorage.match(packageUrl.href);
    }
    catch { return null; }
  }

  async function deleteCorruptCachedPackage(cacheStorage, packageUrl) {
    if (!cacheStorage?.keys || !cacheStorage?.open) return 0;
    let deleted = 0;
    try {
      const names = await cacheStorage.keys();
      for (const name of names) {
        if (!String(name).startsWith(RELEASE_CACHE_PREFIX) && !String(name).startsWith(PREVIEW_CACHE_PREFIX)) continue;
        try {
          const cache = await cacheStorage.open(name);
          const previewKey = candidatePackageCacheKey(packageUrl);
          // If the exact physical-candidate bytes were corrupt, evict the
          // same URL the Service Worker actually used; deleting only the bare
          // URL would leave a verified-failure cache loop on every attempt.
          if (previewKey && await cache.delete(previewKey)) deleted += 1;
          if (await cache.delete(packageUrl.href)) deleted += 1;
        } catch {}
      }
    } catch {}
    return deleted;
  }

  async function responseBytes(response, limit = MAX_ARCHIVE_BYTES) {
    if (!response) return null;
    if (response.body?.getReader) return tarDomain.readStreamWithLimit(response.body, limit, "engine package archive");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new EnginePackageTransportError("archive-too-large", `engine package exceeds ${limit} bytes`);
    return bytes;
  }

  async function sourceFromArchive(packageBytes, entry) {
    const bytes = loaderDomain.bytes(packageBytes);
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new EnginePackageTransportError("archive-too-large", `engine package exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    const actualHash = String(await loaderDomain.defaultSha256(bytes)).toLowerCase();
    if (actualHash !== entry.packageSha256) throw new packageDomain.EnginePackageError("package-hash-mismatch", `package SHA-256 mismatch for ${entry.moduleId}/${entry.engineId}@${entry.version}`, { expected: entry.packageSha256, actual: actualHash });
    const parsed = tarDomain.parseTar(await tarDomain.gunzip(bytes));
    return Object.freeze({ packageBytes: bytes, manifest: parsed.manifest, files: parsed.files });
  }

  // Timing only. `onStage` is invoked with a stage name and its elapsed
  // milliseconds; it observes, never decides. A thrown observer must not be
  // able to fail a package load, so every call is guarded.
  const now = () => (globalThis.performance?.now?.() ?? Date.now());

  function stageRecorder(onStage) {
    if (typeof onStage !== "function") return async (_name, work) => work();
    return async (name, work) => {
      const started = now();
      try {
        return await work();
      } finally {
        try { onStage(name, now() - started); } catch { /* observing must never break loading */ }
      }
    };
  }

  async function loadVerifiedEntry(entryValue, { root, fetchImpl = globalThis.fetch?.bind(globalThis), cacheStorage = globalThis.caches, host = {}, onStage } = {}) {
    const entry = packageDomain.normalizeCatalogEntry(entryValue);
    const trustedRoot = root ?? trustRoot(globalThis.location?.href);
    const packageUrl = assertTrustedUrl(entry.packageUrl, trustedRoot, { packageOnly: true });
    const stage = stageRecorder(onStage);

    // Migration/GC only. Package bytes are never written to a second package
    // cache. The current release/candidate Service Worker cache remains the sole
    // persistent archive owner.
    await retireLegacyPackageCache(cacheStorage);

    const verifyBytes = async (bytes) => stage("verify", async () => {
      const source = await sourceFromArchive(bytes, entry);
      return loaderDomain.createPackageLoader({ host, readPackage: async () => source }).load(entry);
    });

    const cached = await stage("cacheLookup", () => cachedPackageResponse(cacheStorage, packageUrl));
    if (cached) {
      try {
        const bytes = await stage("archiveRead", () => responseBytes(cached.clone()));
        return Object.freeze({ loaded: await verifyBytes(bytes), source: "verified-cache", packageUrl: packageUrl.href });
      } catch {
        await deleteCorruptCachedPackage(cacheStorage, packageUrl);
      }
    }

    if (typeof fetchImpl !== "function") throw new EnginePackageTransportError("package-unavailable", `engine package ${entry.moduleId}/${entry.engineId}@${entry.version} is unavailable offline`);
    let response;
    try { response = await stage("networkFetch", () => fetchImpl(packageUrl.href, { cache: "no-store", redirect: "follow", credentials: "same-origin" })); }
    catch (error) { throw new EnginePackageTransportError("package-fetch-failed", `engine package fetch failed: ${String(error?.message ?? error)}`); }
    if (!response?.ok) throw new EnginePackageTransportError("package-fetch-failed", `engine package fetch failed with HTTP ${response?.status ?? 0}`);
    const finalUrl = assertTrustedUrl(response.url || packageUrl.href, trustedRoot, { packageOnly: true });
    if (finalUrl.href !== packageUrl.href) throw new EnginePackageTransportError("package-redirected", `engine package redirected from exact trusted URL: ${packageUrl.href} -> ${finalUrl.href}`);
    const bytes = await stage("archiveRead", () => responseBytes(response.clone()));
    const loaded = await verifyBytes(bytes);
    return Object.freeze({ loaded, source: "network", packageUrl: finalUrl.href });
  }

  const api = Object.freeze({
    LEGACY_CACHE_NAME,
    RELEASE_CACHE_PREFIX,
    PREVIEW_CACHE_PREFIX,
    TRUST_MODE,
    TRUST_PUBLISHER,
    MAX_ARCHIVE_BYTES,
    EnginePackageTransportError,
    trustRoot,
    assertTrustedUrl,
    validateCatalogTrust,
    fetchCatalog,
    retireLegacyPackageCache,
    cachedPackageResponse,
    candidatePackageCacheKey,
    sourceFromArchive,
    loadVerifiedEntry,
  });
  globalThis.BRKTRKEnginePackageBrowser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
