(() => {
  "use strict";

  const packageDomain = globalThis.BRKTRKEnginePackageDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./engine-package-domain.js") : null);
  if (!packageDomain) throw new Error("BRKTRK EngineRegistry requires engine-package-domain.js");

  const normalizedSha = (value) => String(value ?? "").trim().toLowerCase();

  function engineKey(moduleId, engineId, version) {
    return `${String(moduleId)}\u0000${String(engineId)}\u0000${String(version)}`;
  }

  function exactEngineKey(moduleId, engineId, version, packageSha256) {
    return `${engineKey(moduleId, engineId, version)}\u0000${normalizedSha(packageSha256)}`;
  }

  function createEngineRegistry(host = {}) {
    const records = new Map();

    function register(loadedPackage, factory) {
      if (!loadedPackage?.manifest || !loadedPackage?.entry) throw new TypeError("EngineRegistry.register requires a verified loaded package");
      if (typeof factory !== "function") throw new TypeError("EngineRegistry.register requires a performer factory");
      const manifest = packageDomain.verifyManifestAgainstEntry(loadedPackage.manifest, loadedPackage.entry, host);
      const entry = packageDomain.normalizeCatalogEntry(loadedPackage.entry);
      if (!packageDomain.entryCompatible(entry, host)) {
        throw new packageDomain.EnginePackageError("incompatible-package", `${manifest.moduleId}/${manifest.engineId}@${manifest.version} is incompatible with this host`);
      }
      const key = exactEngineKey(manifest.moduleId, manifest.engineId, manifest.version, entry.packageSha256);
      if (records.has(key)) throw new packageDomain.EnginePackageError("duplicate-engine-registration", `engine ${manifest.moduleId}/${manifest.engineId}@${manifest.version}#${entry.packageSha256} is already registered`);
      const record = Object.freeze({
        key,
        manifest,
        entry,
        factory,
      });
      records.set(key, record);
      return record;
    }

    function resolve(engineRef) {
      if (!engineRef || typeof engineRef !== "object") return null;
      const version = engineRef.resolvedVersion ?? engineRef.requestedVersion;
      if (!version) return null;
      const packageSha256 = normalizedSha(engineRef.resolvedPackageSha256 ?? engineRef.packageSha256);
      if (packageSha256) {
        return records.get(exactEngineKey(engineRef.moduleId, engineRef.engineId, version, packageSha256)) ?? null;
      }
      const prefix = `${engineKey(engineRef.moduleId, engineRef.engineId, version)}\u0000`;
      const matches = [...records.entries()].filter(([key]) => key.startsWith(prefix)).map(([, record]) => record);
      return matches.length === 1 ? matches[0] : null;
    }

    function unregister(engineRef) {
      const record = resolve(engineRef);
      if (!record) return false;
      return records.delete(record.key);
    }

    function snapshot() {
      return Object.freeze([...records.values()].map((record) => Object.freeze({
        moduleId: record.manifest.moduleId,
        engineId: record.manifest.engineId,
        version: record.manifest.version,
        packageSha256: record.entry.packageSha256,
        contentSha256: record.manifest.contentSha256,
      })));
    }

    return Object.freeze({ register, resolve, unregister, snapshot });
  }

  const api = Object.freeze({ engineKey, exactEngineKey, createEngineRegistry });
  globalThis.BRKTRKEngineRegistryDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();