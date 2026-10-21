(() => {
  "use strict";

  const packageDomain = globalThis.BRKTRKEnginePackageDomain
    ?? (typeof module !== "undefined" && module.exports ? require("./engine-package-domain.js") : null);
  if (!packageDomain) throw new Error("BRKTRK engine package loader requires engine-package-domain.js");

  const bytes = (value) => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === "string") return new TextEncoder().encode(value);
    throw new packageDomain.EnginePackageError("invalid-bytes", "engine package artifact must be bytes or UTF-8 text");
  };

  async function defaultSha256(value) {
    const source = bytes(value);
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", source);
      return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
    }
    if (typeof module !== "undefined" && module.exports) {
      const { createHash } = require("node:crypto");
      return createHash("sha256").update(source).digest("hex");
    }
    throw new packageDomain.EnginePackageError("hash-unavailable", "SHA-256 implementation is unavailable");
  }

  function decodeJson(payload, label) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes(payload)));
    } catch (error) {
      throw new packageDomain.EnginePackageError("invalid-descriptor-json", `${label} is not valid UTF-8 JSON`, { cause: String(error?.message ?? error) });
    }
  }

  function createPackageLoader({ readPackage, digest = defaultSha256, host = {} } = {}) {
    if (typeof readPackage !== "function") throw new TypeError("EnginePackageLoader requires an injected readPackage(entry) function");
    if (typeof digest !== "function") throw new TypeError("EnginePackageLoader digest must be a function");

    async function verifyArtifact(artifact, files) {
      if (!Object.hasOwn(files, artifact.path)) throw new packageDomain.EnginePackageError("missing-artifact", `engine package is missing ${artifact.path}`);
      const payload = bytes(files[artifact.path]);
      if (payload.byteLength !== artifact.size) throw new packageDomain.EnginePackageError("artifact-size-mismatch", `${artifact.path} expected ${artifact.size} bytes, got ${payload.byteLength}`, { path: artifact.path });
      const actual = String(await digest(payload)).toLowerCase();
      if (actual !== artifact.sha256) throw new packageDomain.EnginePackageError("artifact-hash-mismatch", `${artifact.path} SHA-256 mismatch`, { path: artifact.path, expected: artifact.sha256, actual });
      return payload;
    }

    async function verifyContentDigest(manifest) {
      const actual = String(await digest(packageDomain.contentDigestInput(manifest.artifacts))).toLowerCase();
      if (actual !== manifest.contentSha256) {
        throw new packageDomain.EnginePackageError("content-hash-mismatch", "engine package manifest content SHA-256 mismatch", {
          expected: manifest.contentSha256,
          actual,
        });
      }
      return actual;
    }

    function materializeParameterDescriptors(manifest, verifiedFiles) {
      const path = manifest.descriptors?.parameters ?? null;
      if (!path) return manifest;
      const payload = verifiedFiles[path];
      if (!payload) throw new packageDomain.EnginePackageError("missing-parameter-descriptor", `verified package is missing parameter descriptor ${path}`);
      const descriptor = decodeJson(payload, `parameter descriptor ${path}`);
      if (!descriptor || typeof descriptor !== "object" || !Array.isArray(descriptor.parameters)) {
        throw new packageDomain.EnginePackageError("invalid-parameter-descriptor", `${path} must contain a parameters array`);
      }
      const parameters = packageDomain.normalizeParameters(descriptor.parameters);
      if (manifest.parameters.length > 0) {
        const inline = manifest.parameters.map((parameter) => parameter.id).join("\u0000");
        const external = parameters.map((parameter) => parameter.id).join("\u0000");
        if (inline !== external) throw new packageDomain.EnginePackageError("parameter-descriptor-mismatch", "inline and external parameter identities disagree");
      }
      return Object.freeze({
        ...manifest,
        parameters,
        parameterRegistry: Object.freeze({
          path,
          schema: typeof descriptor.schema === "string" ? descriptor.schema : null,
          count: parameters.length,
        }),
      });
    }

    async function load(entryValue) {
      const entry = packageDomain.normalizeCatalogEntry(entryValue);
      if (!packageDomain.entryCompatible(entry, host)) throw new packageDomain.EnginePackageError("incompatible-package", `${entry.moduleId}/${entry.engineId}@${entry.version} is incompatible with this host`);
      const source = await readPackage(entry);
      if (!source || typeof source !== "object") throw new packageDomain.EnginePackageError("package-read-failed", "readPackage must return a package object");

      // The transport/archive hash belongs to the trusted catalog. It cannot live
      // inside brk-package.json without creating a self-referential archive hash.
      const packageBytes = bytes(source.packageBytes ?? "");
      const packageHash = String(await digest(packageBytes)).toLowerCase();
      if (packageHash !== entry.packageSha256) throw new packageDomain.EnginePackageError("package-hash-mismatch", `package SHA-256 mismatch for ${entry.moduleId}/${entry.engineId}@${entry.version}`, { expected: entry.packageSha256, actual: packageHash });

      const normalizedManifest = packageDomain.verifyManifestAgainstEntry(source.manifest, entry, host);
      const files = source.files && typeof source.files === "object" ? source.files : {};
      const verifiedFiles = {};
      for (const artifact of normalizedManifest.artifacts) verifiedFiles[artifact.path] = await verifyArtifact(artifact, files);
      const contentSha256 = await verifyContentDigest(normalizedManifest);
      const manifest = materializeParameterDescriptors(normalizedManifest, verifiedFiles);
      return Object.freeze({
        entry,
        manifest,
        packageBytes,
        packageSha256: packageHash,
        contentSha256,
        files: Object.freeze(verifiedFiles),
      });
    }

    return Object.freeze({ load });
  }

  const api = Object.freeze({ bytes, defaultSha256, createPackageLoader });
  globalThis.BRKTRKEnginePackageLoader = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
