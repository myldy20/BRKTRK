(() => {
  "use strict";

  const PACKAGE_FORMAT = "brk-engine-package-v1";
  const CATALOG_FORMAT = "brk-engine-catalog-v1";
  const HOST_CONTRACT_ID = "brktrk-synth-gateway-v1";
  const HOST_CONTRACT_VERSION = 1;
  const SHARED_HOST_CONTRACT_ID = "brk-synth-host-v1";
  const SHARED_INTEGRATION_PROFILE = "brksynth-integration-ready-v1";
  const DEFAULT_CHANNEL = "stable";
  const CHANNELS = Object.freeze(["stable", "preview", "dev"]);
  const ACTIVE_STATUSES = Object.freeze(new Set(["active", "ready"]));
  const LEGACY_MAX_MODULE_INSTANCES = 8;

  class EnginePackageError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "EnginePackageError";
      this.code = String(code || "engine-package-error");
      this.details = Object.freeze({ ...details });
    }
  }

  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  const text = (value, label) => {
    const result = typeof value === "string" ? value.trim() : "";
    if (!result) throw new EnginePackageError("invalid-field", `${label} must be a non-empty string`);
    return result;
  };
  const optionalText = (value) => value == null ? null : String(value).trim() || null;
  const uint = (value, label) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new EnginePackageError("invalid-field", `${label} must be a non-negative safe integer`);
    return result;
  };
  const requiredUint = (value, label) => {
    if (value === undefined || value === null) throw new EnginePackageError("invalid-field", `${label} is required`);
    return uint(value, label);
  };
  const positiveUint = (value, label) => {
    const result = uint(value, label);
    if (result < 1) throw new EnginePackageError("invalid-field", `${label} must be at least 1`);
    return result;
  };
  const sha256 = (value, label) => {
    const result = String(value ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(result)) throw new EnginePackageError("invalid-hash", `${label} must be a SHA-256 hex digest`);
    return result;
  };
  const gitSha = (value, label) => {
    const result = String(value ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(result)) throw new EnginePackageError("invalid-field", `${label} must be an exact lowercase git SHA`);
    return result;
  };
  const evidenceId = (value, label) => {
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new EnginePackageError("invalid-field", `${label} is required`);
    }
    return typeof value === "number" ? value : String(value).trim();
  };
  const compareCodeUnits = (left, right) => {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
  };

  function normalizeAbiVersion(value, label = "abiVersion") {
    if (value === undefined || value === null) throw new EnginePackageError("invalid-field", `${label} is required`);
    let numeric;
    if (typeof value === "number") {
      numeric = value;
    } else {
      const source = String(value).trim();
      if (/^0x[0-9a-f]+$/i.test(source)) numeric = Number.parseInt(source.slice(2), 16);
      else if (/^\d+$/.test(source)) numeric = Number(source);
      else throw new EnginePackageError("invalid-field", `${label} must be a non-negative integer or hexadecimal ABI version`);
    }
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0xffffffff) {
      throw new EnginePackageError("invalid-field", `${label} must fit an unsigned 32-bit ABI version`);
    }
    return `0x${numeric.toString(16).padStart(8, "0")}`;
  }

  function contract(value, label = "hostContract") {
    if (value === undefined || value === null) throw new EnginePackageError("invalid-field", `${label} is required`);
    if (typeof value === "string") {
      const id = text(value, label);
      return Object.freeze({ id, minVersion: 1, maxVersion: 1 });
    }
    if (!object(value)) throw new EnginePackageError("invalid-field", `${label} must be a string or object`);
    const minVersion = uint(value.minVersion ?? value.version ?? 1, `${label}.minVersion`);
    const maxVersion = uint(value.maxVersion ?? value.version ?? minVersion, `${label}.maxVersion`);
    if (minVersion < 1 || maxVersion < minVersion) throw new EnginePackageError("invalid-field", `${label} version range is invalid`);
    return Object.freeze({ id: text(value.id ?? value.name, `${label}.id`), minVersion, maxVersion });
  }

  function optionalContract(value, label = "hostContract") {
    return value === undefined || value === null ? null : contract(value, label);
  }

  function normalizeHostCompatibility(value, packageSha256, label = "hostCompatibility") {
    if (value === undefined || value === null) return null;
    if (!object(value)) throw new EnginePackageError("invalid-host-compatibility", `${label} must be an object`);
    const profile = text(value.profile, `${label}.profile`);
    const source = text(value.source, `${label}.source`);
    if (!["package-manifest", "host-qualification"].includes(source)) {
      throw new EnginePackageError("invalid-host-compatibility", `${label}.source must be package-manifest or host-qualification`);
    }
    let qualification = null;
    if (source === "host-qualification") {
      const q = value.qualification;
      if (!object(q)) throw new EnginePackageError("invalid-host-qualification", `${label}.qualification is required for host-qualification`);
      const qualifiedPackageSha = sha256(q.packageSha256, `${label}.qualification.packageSha256`);
      if (qualifiedPackageSha !== packageSha256) {
        throw new EnginePackageError(
          "invalid-host-qualification",
          `${label}.qualification.packageSha256 must bind the exact catalog package`,
          { expected: packageSha256, actual: qualifiedPackageSha },
        );
      }
      qualification = Object.freeze({
        hostHead: gitSha(q.hostHead, `${label}.qualification.hostHead`),
        runner: text(q.runner, `${label}.qualification.runner`),
        runId: evidenceId(q.runId, `${label}.qualification.runId`),
        jobId: evidenceId(q.jobId, `${label}.qualification.jobId`),
        artifactId: evidenceId(q.artifactId, `${label}.qualification.artifactId`),
        artifactDigestSha256: sha256(q.artifactDigestSha256, `${label}.qualification.artifactDigestSha256`),
        packageSha256: qualifiedPackageSha,
      });
    }
    return Object.freeze({ profile, source, qualification });
  }

  function normalizeCatalogEntry(value, index = 0) {
    if (!object(value)) throw new EnginePackageError("invalid-catalog-entry", `catalog entry ${index} must be an object`);
    const channel = optionalText(value.channel) ?? DEFAULT_CHANNEL;
    if (!CHANNELS.includes(channel)) throw new EnginePackageError("invalid-channel", `catalog entry ${index} has unsupported channel ${channel}`);
    const packageSha256 = sha256(value.packageSha256, `catalog[${index}].packageSha256`);
    const hostContract = optionalContract(value.hostContract, `catalog[${index}].hostContract`);
    const hostCompatibility = normalizeHostCompatibility(value.hostCompatibility, packageSha256, `catalog[${index}].hostCompatibility`);
    if (!hostContract && !hostCompatibility) {
      throw new EnginePackageError(
        "invalid-host-compatibility",
        `catalog[${index}] must declare hostContract or hostCompatibility qualification`,
      );
    }
    return Object.freeze({
      moduleId: text(value.moduleId, `catalog[${index}].moduleId`),
      engineId: text(value.engineId, `catalog[${index}].engineId`),
      version: text(value.version, `catalog[${index}].version`),
      channel,
      hostContract,
      hostCompatibility,
      abiVersion: normalizeAbiVersion(value.abiVersion, `catalog[${index}].abiVersion`),
      packageUrl: text(value.packageUrl, `catalog[${index}].packageUrl`),
      packageSha256,
      stateSchemaVersion: requiredUint(value.stateSchemaVersion, `catalog[${index}].stateSchemaVersion`),
      parameterSchemaVersion: requiredUint(value.parameterSchemaVersion, `catalog[${index}].parameterSchemaVersion`),
      status: optionalText(value.status) ?? "active",
      publishedAt: optionalText(value.publishedAt),
    });
  }

  function normalizeCatalog(value) {
    const source = Array.isArray(value) ? { format: CATALOG_FORMAT, entries: value } : value;
    if (!object(source)) throw new EnginePackageError("invalid-catalog", "engine catalog must be an object or entry array");
    const format = optionalText(source.format) ?? CATALOG_FORMAT;
    if (format !== CATALOG_FORMAT) throw new EnginePackageError("unsupported-catalog-format", `unsupported engine catalog format ${format}`);
    const entries = Object.freeze((Array.isArray(source.entries) ? source.entries : []).map(normalizeCatalogEntry));
    const keys = new Set();
    for (const entry of entries) {
      const key = `${entry.moduleId}\u0000${entry.engineId}\u0000${entry.version}\u0000${entry.channel}`;
      if (keys.has(key)) throw new EnginePackageError("duplicate-catalog-entry", `duplicate engine catalog entry ${entry.moduleId}/${entry.engineId}@${entry.version}#${entry.channel}`);
      keys.add(key);
    }
    return Object.freeze({ format, entries });
  }

  function normalizeArtifact(value, index) {
    if (!object(value)) throw new EnginePackageError("invalid-artifact", `artifacts[${index}] must be an object`);
    return Object.freeze({
      path: text(value.path, `artifacts[${index}].path`),
      kind: optionalText(value.kind) ?? "data",
      size: uint(value.size ?? value.bytes ?? 0, `artifacts[${index}].size`),
      sha256: sha256(value.sha256, `artifacts[${index}].sha256`),
      entryPoint: optionalText(value.entryPoint),
    });
  }

  // Only a number or a non-blank string can name a numeric parameter id.
  // Number(null) is 0 and Number(true) is 1, so coercing anything else invents
  // an id the package never declared.
  function optionalParameterNumber(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }

  function normalizeParameter(value, index) {
    if (!object(value)) throw new EnginePackageError("invalid-parameter", `parameters[${index}] must be an object`);
    const stableKey = optionalText(value.key) ?? (typeof value.id === "string" ? optionalText(value.id) : null);
    if (!stableKey) throw new EnginePackageError("invalid-parameter", `parameters[${index}] requires a stable string key/id`);
    // Normalization must be idempotent: the host embeds the normalized
    // manifest in the Worklet module it builds, and the Worklet's
    // EngineRegistry verifies it again. A parameter without a numeric id
    // normalizes to `numericId: null`; coercing that null to 0 on the second
    // pass gave every such parameter id 0, the second was rejected as a
    // duplicate, and an engine without numeric ids could never enter the
    // Worklet registry - which is why the development engine never played.
    const numericId = Object.hasOwn(value, "numericId")
      ? optionalParameterNumber(value.numericId)
      : optionalParameterNumber(value.id);
    return Object.freeze({ ...value, id: stableKey, key: stableKey, numericId });
  }

  function normalizeParameters(values) {
    const parameters = Object.freeze((Array.isArray(values) ? values : []).map(normalizeParameter));
    const parameterIds = new Set();
    const numericIds = new Set();
    for (const parameter of parameters) {
      if (parameterIds.has(parameter.id)) throw new EnginePackageError("duplicate-parameter", `duplicate stable parameter key ${parameter.id}`);
      parameterIds.add(parameter.id);
      if (parameter.numericId !== null) {
        if (numericIds.has(parameter.numericId)) throw new EnginePackageError("duplicate-parameter", `duplicate numeric parameter id ${parameter.numericId}`);
        numericIds.add(parameter.numericId);
      }
    }
    return parameters;
  }

  function normalizeDescriptorPaths(value) {
    const source = object(value) ? value : {};
    return Object.freeze({
      engine: optionalText(source.engine),
      ui: optionalText(source.ui),
      parameters: optionalText(source.parameters),
      presets: optionalText(source.presets),
    });
  }

  function normalizeRuntime(value) {
    if (value === undefined || value === null) return Object.freeze({});
    if (!object(value)) throw new EnginePackageError("invalid-field", "manifest.runtime must be an object");
    const result = { ...value };
    if (Object.hasOwn(value, "maxModuleInstances")) {
      result.maxModuleInstances = positiveUint(value.maxModuleInstances, "manifest.runtime.maxModuleInstances");
    }
    if (Object.hasOwn(value, "maxInstances")) {
      result.maxInstances = positiveUint(value.maxInstances, "manifest.runtime.maxInstances");
    }
    return Object.freeze(result);
  }

  function normalizeIntegration(value) {
    if (value === undefined || value === null) return null;
    if (!object(value)) throw new EnginePackageError("invalid-field", "manifest.integration must be an object");
    const audio = value.audio === undefined || value.audio === null
      ? null
      : object(value.audio) ? Object.freeze({ ...value.audio }) : (() => { throw new EnginePackageError("invalid-field", "manifest.integration.audio must be an object"); })();
    const presentation = value.presentation === undefined || value.presentation === null
      ? null
      : object(value.presentation) ? Object.freeze({ ...value.presentation }) : (() => { throw new EnginePackageError("invalid-field", "manifest.integration.presentation must be an object"); })();
    return Object.freeze({ ...value, profile: optionalText(value.profile), audio, presentation });
  }

  function moduleInstanceCapability(manifest, { legacyFallback = LEGACY_MAX_MODULE_INSTANCES } = {}) {
    const runtime = object(manifest?.runtime) ? manifest.runtime : {};
    if (Object.hasOwn(runtime, "maxModuleInstances")) {
      return Object.freeze({
        capacity: positiveUint(runtime.maxModuleInstances, "manifest.runtime.maxModuleInstances"),
        source: "runtime.maxModuleInstances",
        explicit: true,
        legacy: false,
      });
    }
    if (Object.hasOwn(runtime, "maxInstances")) {
      return Object.freeze({
        capacity: positiveUint(runtime.maxInstances, "manifest.runtime.maxInstances"),
        source: "runtime.maxInstances",
        explicit: false,
        legacy: true,
      });
    }
    return Object.freeze({
      capacity: positiveUint(legacyFallback, "legacy maxModuleInstances fallback"),
      source: "legacy-host-fallback",
      explicit: false,
      legacy: true,
    });
  }

  function contentDigestInput(artifacts) {
    return [...artifacts]
      // Package content identity is a cross-repository byte contract. Locale
      // collation can reorder ASCII paths (for example README before/after a
      // lowercase name) differently across builders and browsers, so use the
      // stable ECMAScript code-unit order that matches the package producer's
      // canonical UTF-8/ASCII path ordering.
      .sort((left, right) => compareCodeUnits(left.path, right.path))
      .map((artifact) => `${artifact.path}\u0000${artifact.size}\u0000${artifact.sha256}\n`)
      .join("");
  }

  function normalizeManifest(value, { allowMissingHostContract = false } = {}) {
    if (!object(value)) throw new EnginePackageError("invalid-manifest", "engine package manifest must be an object");
    const format = optionalText(value.schema ?? value.format ?? value.packageFormat) ?? PACKAGE_FORMAT;
    if (format !== PACKAGE_FORMAT) throw new EnginePackageError("unsupported-package-format", `unsupported engine package format ${format}`);
    const artifacts = Object.freeze((Array.isArray(value.artifacts) ? value.artifacts : Array.isArray(value.files) ? value.files : []).map(normalizeArtifact));
    if (artifacts.length === 0) throw new EnginePackageError("missing-artifacts", "engine package manifest must declare at least one artifact");
    const paths = new Set();
    for (const artifact of artifacts) {
      if (paths.has(artifact.path)) throw new EnginePackageError("duplicate-artifact", `duplicate package artifact ${artifact.path}`);
      paths.add(artifact.path);
    }
    const parameters = normalizeParameters(value.parameters);
    const descriptors = normalizeDescriptorPaths(value.descriptors);
    if (descriptors.parameters && !paths.has(descriptors.parameters)) {
      throw new EnginePackageError("missing-parameter-descriptor", `parameter descriptor ${descriptors.parameters} is not declared in package files`);
    }
    const hostContract = value.hostContract === undefined || value.hostContract === null
      ? allowMissingHostContract ? null : contract(value.hostContract, "manifest.hostContract")
      : contract(value.hostContract, "manifest.hostContract");
    return Object.freeze({
      ...value,
      format,
      moduleId: text(value.moduleId, "manifest.moduleId"),
      engineId: text(value.engineId, "manifest.engineId"),
      version: text(value.version, "manifest.version"),
      hostContract,
      abiVersion: normalizeAbiVersion(value.abiVersion, "manifest.abiVersion"),
      stateSchemaVersion: requiredUint(value.stateSchemaVersion, "manifest.stateSchemaVersion"),
      parameterSchemaVersion: requiredUint(value.parameterSchemaVersion, "manifest.parameterSchemaVersion"),
      contentSha256: sha256(value.contentSha256, "manifest.contentSha256"),
      runtime: normalizeRuntime(value.runtime),
      integration: normalizeIntegration(value.integration),
      artifacts,
      descriptors,
      parameters,
    });
  }

  function contractCompatible(candidate, hostId = HOST_CONTRACT_ID, hostVersion = HOST_CONTRACT_VERSION) {
    const normalized = contract(candidate);
    return normalized.id === hostId && hostVersion >= normalized.minVersion && hostVersion <= normalized.maxVersion;
  }

  function hostContracts(options = {}) {
    if (Array.isArray(options.hostContracts) && options.hostContracts.length) {
      return Object.freeze(options.hostContracts.map((value, index) => {
        if (typeof value === "string") return Object.freeze({ id: text(value, `host.hostContracts[${index}]`), version: 1 });
        if (!object(value)) throw new EnginePackageError("invalid-field", `host.hostContracts[${index}] must be a string or object`);
        return Object.freeze({
          id: text(value.id ?? value.name, `host.hostContracts[${index}].id`),
          version: positiveUint(value.version ?? value.maxVersion ?? value.minVersion ?? 1, `host.hostContracts[${index}].version`),
        });
      }));
    }
    if (Object.hasOwn(options, "hostContractId") || Object.hasOwn(options, "hostContractVersion")) {
      return Object.freeze([Object.freeze({
        id: optionalText(options.hostContractId) ?? HOST_CONTRACT_ID,
        version: positiveUint(options.hostContractVersion ?? HOST_CONTRACT_VERSION, "host.hostContractVersion"),
      })]);
    }
    return Object.freeze([
      Object.freeze({ id: HOST_CONTRACT_ID, version: HOST_CONTRACT_VERSION }),
      Object.freeze({ id: SHARED_HOST_CONTRACT_ID, version: 1 }),
    ]);
  }

  function hostSupportsContract(candidate, options = {}) {
    if (!candidate) return false;
    return hostContracts(options).some((supported) => contractCompatible(candidate, supported.id, supported.version));
  }

  function supportedAbi(entry, options = {}) {
    if (!Array.isArray(options.abiVersions) || options.abiVersions.length === 0) return true;
    const supported = options.abiVersions.map((value, index) => normalizeAbiVersion(value, `host.abiVersions[${index}]`));
    return supported.includes(entry.abiVersion);
  }

  function supportedIntegrationProfiles(options = {}) {
    if (Array.isArray(options.integrationProfiles) && options.integrationProfiles.length) {
      return options.integrationProfiles.map((value, index) => text(value, `host.integrationProfiles[${index}]`));
    }
    return [SHARED_INTEGRATION_PROFILE];
  }

  function entryCompatibility(entryValue, options = {}) {
    const entry = normalizeCatalogEntry(entryValue);
    if (!ACTIVE_STATUSES.has(entry.status)) {
      return Object.freeze({ compatible: false, code: "inactive-status", reason: `catalog status ${entry.status} is not active`, via: null });
    }
    if (!supportedAbi(entry, options)) {
      return Object.freeze({ compatible: false, code: "abi-version", reason: `ABI ${entry.abiVersion} is not supported by this Host`, via: null });
    }

    if (entry.hostContract && !hostSupportsContract(entry.hostContract, options)) {
      return Object.freeze({ compatible: false, code: "host-contract", reason: `host contract ${entry.hostContract.id} is not supported by this Host`, via: null });
    }

    if (entry.hostContract?.id === SHARED_HOST_CONTRACT_ID && !entry.hostCompatibility) {
      return Object.freeze({
        compatible: false,
        code: "missing-host-qualification",
        reason: `shared host contract ${SHARED_HOST_CONTRACT_ID} requires ${SHARED_INTEGRATION_PROFILE} qualification`,
        via: null,
      });
    }

    if (entry.hostCompatibility) {
      if (!supportedIntegrationProfiles(options).includes(entry.hostCompatibility.profile)) {
        return Object.freeze({ compatible: false, code: "integration-profile", reason: `integration profile ${entry.hostCompatibility.profile} is not supported by this Host`, via: null });
      }
      if (entry.hostCompatibility.source === "package-manifest"
        && !hostSupportsContract({ id: SHARED_HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 }, options)) {
        return Object.freeze({ compatible: false, code: "host-contract", reason: `host contract ${SHARED_HOST_CONTRACT_ID} is not supported by this Host`, via: null });
      }
      return Object.freeze({
        compatible: true,
        code: "compatible",
        reason: entry.hostCompatibility.source === "host-qualification"
          ? "exact package is externally Host-qualified"
          : "package declares the shared Host integration profile",
        via: entry.hostCompatibility.source,
        profile: entry.hostCompatibility.profile,
      });
    }

    if (entry.hostContract) {
      return Object.freeze({
        compatible: true,
        code: "compatible",
        reason: `catalog declares compatible host contract ${entry.hostContract.id}`,
        via: "host-contract",
        profile: null,
      });
    }

    return Object.freeze({ compatible: false, code: "missing-host-compatibility", reason: "catalog does not qualify this package for a supported Host", via: null });
  }

  function entryCompatible(entry, options = {}) {
    return entryCompatibility(entry, options).compatible;
  }

  function integrationCapabilitiesCompatible(manifest, options = {}) {
    const profile = manifest?.integration?.profile;
    if (!profile || !supportedIntegrationProfiles(options).includes(profile)) return false;
    const audio = manifest.integration.audio;
    if (!object(audio)) return false;
    for (const field of ["inputBusCount", "outputBusCount", "inputChannelCount", "outputChannelCount"]) {
      if (!Number.isSafeInteger(Number(audio[field])) || Number(audio[field]) < 0) return false;
    }
    if (Number(audio.inputBusCount) !== 0 || Number(audio.inputChannelCount) !== 0) return false;
    if (Number(audio.outputBusCount) !== 1 || Number(audio.outputChannelCount) !== 2) return false;
    const mode = optionalText(manifest.integration.presentation?.mode);
    const supportedModes = Array.isArray(options.presentationModes) && options.presentationModes.length
      ? options.presentationModes.map(String)
      : ["generic-descriptor-ui", "headless"];
    return Boolean(mode && supportedModes.includes(mode));
  }

  function sameContract(left, right) {
    return Boolean(left && right
      && left.id === right.id
      && left.minVersion === right.minVersion
      && left.maxVersion === right.maxVersion);
  }

  function versionTuple(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(String(value));
    if (!match) return null;
    return Object.freeze({
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: match[4] ? Object.freeze(match[4].split(".")) : null,
    });
  }

  function comparePrerelease(left, right) {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      if (left[index] === undefined) return -1;
      if (right[index] === undefined) return 1;
      if (left[index] === right[index]) continue;
      const leftNumeric = /^\d+$/.test(left[index]);
      const rightNumeric = /^\d+$/.test(right[index]);
      if (leftNumeric && rightNumeric) return Number(left[index]) - Number(right[index]);
      if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
      return compareCodeUnits(left[index], right[index]);
    }
    return 0;
  }

  function compareVersions(left, right) {
    const a = versionTuple(left);
    const b = versionTuple(right);
    if (!a || !b) return compareCodeUnits(left, right);
    for (const field of ["major", "minor", "patch"]) if (a[field] !== b[field]) return a[field] - b[field];
    return comparePrerelease(a.prerelease, b.prerelease);
  }

  function resolveCatalogEntry(catalogValue, engineRef, options = {}) {
    const catalog = normalizeCatalog(catalogValue);
    if (!object(engineRef)) throw new EnginePackageError("invalid-engine-ref", "engineRef must be an object");
    const moduleId = text(engineRef.moduleId, "engineRef.moduleId");
    const engineId = text(engineRef.engineId, "engineRef.engineId");
    const channel = optionalText(options.channel) ?? DEFAULT_CHANNEL;
    let candidates = catalog.entries.filter((entry) => entry.moduleId === moduleId
      && entry.engineId === engineId
      && entry.channel === channel
      && entryCompatible(entry, options));
    const exactVersion = optionalText(engineRef.resolvedVersion) ?? optionalText(engineRef.requestedVersion);
    const exactHash = optionalText(engineRef.resolvedPackageSha256 ?? engineRef.packageSha256)?.toLowerCase() ?? null;
    if (exactVersion) candidates = candidates.filter((entry) => entry.version === exactVersion);
    if (exactHash) candidates = candidates.filter((entry) => entry.packageSha256 === exactHash);
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => compareVersions(right.version, left.version));
    return candidates[0];
  }

  function verifyManifestAgainstEntry(manifestValue, entryValue, options = {}) {
    // brk-engine-package-v1 structural validity is independent from Host
    // qualification. A trusted catalog/lock row binds the exact archive SHA and
    // may qualify an already accepted immutable package whose manifest predates
    // hostContract/integration metadata.
    const manifest = normalizeManifest(manifestValue, { allowMissingHostContract: true });
    const entry = normalizeCatalogEntry(entryValue);
    const mismatches = [];
    for (const field of ["moduleId", "engineId", "version", "abiVersion", "stateSchemaVersion", "parameterSchemaVersion"]) {
      if (String(manifest[field]) !== String(entry[field])) mismatches.push(field);
    }

    const compatibility = entryCompatibility(entry, options);
    if (!compatibility.compatible) mismatches.push("hostCompatibility");

    if (entry.hostCompatibility?.source === "package-manifest") {
      if (!manifest.hostContract
        || manifest.hostContract.id !== SHARED_HOST_CONTRACT_ID
        || !hostSupportsContract(manifest.hostContract, options)
        || (entry.hostContract && !sameContract(manifest.hostContract, entry.hostContract))) {
        mismatches.push("hostContract");
      }
      if (manifest.integration?.profile !== entry.hostCompatibility.profile) mismatches.push("integration.profile");
      else if (!integrationCapabilitiesCompatible(manifest, options)) mismatches.push("integration.capabilities");
    } else if (entry.hostCompatibility?.source === "host-qualification") {
      // External qualification is exact-package evidence. The legacy package
      // metadata is not rewritten merely to repeat a newer Host profile, but
      // any compatibility metadata the immutable manifest already declares
      // remains authoritative and may not disagree with the trusted catalog.
      if (entry.hostCompatibility.qualification?.packageSha256 !== entry.packageSha256) mismatches.push("hostQualification");
      if (manifest.hostContract) {
        if (entry.hostContract && !sameContract(manifest.hostContract, entry.hostContract)) mismatches.push("hostContract");
        if (!hostSupportsContract(manifest.hostContract, options)) mismatches.push("hostContract-host");
      }
      if (manifest.integration?.profile) {
        if (manifest.integration.profile !== entry.hostCompatibility.profile) mismatches.push("integration.profile");
        else if (!integrationCapabilitiesCompatible(manifest, options)) mismatches.push("integration.capabilities");
      }
    } else if (manifest.hostContract) {
      if (!sameContract(manifest.hostContract, entry.hostContract)) mismatches.push("hostContract");
      if (!hostSupportsContract(manifest.hostContract, options)) mismatches.push("hostContract-host");
    }

    if (mismatches.length) {
      throw new EnginePackageError(
        "manifest-catalog-mismatch",
        `engine package manifest disagrees with catalog/Host qualification: ${mismatches.join(", ")}`,
        { mismatches, compatibility },
      );
    }
    return manifest;
  }

  const api = Object.freeze({
    PACKAGE_FORMAT,
    CATALOG_FORMAT,
    HOST_CONTRACT_ID,
    HOST_CONTRACT_VERSION,
    SHARED_HOST_CONTRACT_ID,
    SHARED_INTEGRATION_PROFILE,
    DEFAULT_CHANNEL,
    CHANNELS,
    LEGACY_MAX_MODULE_INSTANCES,
    EnginePackageError,
    normalizeAbiVersion,
    normalizeCatalogEntry,
    normalizeCatalog,
    normalizeManifest,
    normalizeParameters,
    normalizeRuntime,
    moduleInstanceCapability,
    contentDigestInput,
    contractCompatible,
    entryCompatibility,
    entryCompatible,
    integrationCapabilitiesCompatible,
    compareVersions,
    resolveCatalogEntry,
    verifyManifestAgainstEntry,
  });

  globalThis.BRKTRKEnginePackageDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
