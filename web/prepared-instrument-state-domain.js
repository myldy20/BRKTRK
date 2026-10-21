(() => {
  "use strict";

  const SHA256_RE = /^[0-9a-f]{64}$/;
  const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  const SUPPORTED_SUBTYPES = new Set(["instrument.preset", "instrument.patch"]);

  class PreparedInstrumentStateError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "PreparedInstrumentStateError";
      this.code = String(code || "prepared-state-error");
      this.details = Object.freeze({ ...details });
    }
  }

  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const text = (value) => String(value ?? "").trim();
  const normalizedSha = (value) => text(value).toLowerCase();

  function instrumentId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 0 || id > 255) {
      throw new PreparedInstrumentStateError("instrument-id", `Instrument id must be 00–FF, got ${String(value)}`);
    }
    return id;
  }

  function exactIdentityFromRef(ref) {
    if (!object(ref)) return null;
    const moduleId = text(ref.moduleId);
    const engineId = text(ref.engineId);
    const version = text(ref.resolvedVersion);
    const packageSha256 = normalizedSha(ref.resolvedPackageSha256);
    if (!moduleId || !engineId || !version || !SHA256_RE.test(packageSha256)) return null;
    return Object.freeze({ moduleId, engineId, version, packageSha256 });
  }

  function exactIdentityFromPackageView(packageView) {
    const entry = packageView?.entry;
    if (!object(entry)) return null;
    const moduleId = text(entry.moduleId);
    const engineId = text(entry.engineId);
    const version = text(entry.version);
    const packageSha256 = normalizedSha(entry.packageSha256);
    if (!moduleId || !engineId || !version || !SHA256_RE.test(packageSha256)) return null;
    return Object.freeze({ moduleId, engineId, version, packageSha256 });
  }

  function sameIdentity(left, right) {
    return Boolean(left && right)
      && left.moduleId === right.moduleId
      && left.engineId === right.engineId
      && left.version === right.version
      && left.packageSha256 === right.packageSha256;
  }

  function classifySameTopology({ instrumentId: rawInstrumentId, currentInstrument, desiredInstrument, packageView } = {}) {
    let id;
    try { id = instrumentId(rawInstrumentId ?? desiredInstrument?.id ?? currentInstrument?.id); }
    catch (error) {
      return Object.freeze({ eligible: false, code: error.code ?? "instrument-id", reason: error.message });
    }

    if (!object(currentInstrument) || !object(desiredInstrument)) {
      return Object.freeze({ eligible: false, code: "instrument-missing", reason: "Current and desired Production Instruments are required" });
    }
    if ((currentInstrument.id != null && Number(currentInstrument.id) !== id)
      || (desiredInstrument.id != null && Number(desiredInstrument.id) !== id)) {
      return Object.freeze({ eligible: false, code: "instrument-identity-changed", reason: "Instrument slot/id changed" });
    }

    const currentIdentity = exactIdentityFromRef(currentInstrument.engineRef);
    const desiredIdentity = exactIdentityFromRef(desiredInstrument.engineRef);
    if (!currentIdentity || !desiredIdentity) {
      return Object.freeze({ eligible: false, code: "exact-engine-identity-missing", reason: "Prepared state requires resolved version + exact package SHA" });
    }
    if (!sameIdentity(currentIdentity, desiredIdentity)) {
      return Object.freeze({ eligible: false, code: "engine-topology-changed", reason: "Engine module/version/package identity changed" });
    }

    const packageIdentity = exactIdentityFromPackageView(packageView);
    if (!packageIdentity) {
      return Object.freeze({ eligible: false, code: "verified-package-view-missing", reason: "Verified exact package view is required" });
    }
    if (!sameIdentity(desiredIdentity, packageIdentity)) {
      return Object.freeze({ eligible: false, code: "verified-package-identity-mismatch", reason: "Verified package view does not match desired exact engine identity" });
    }

    return Object.freeze({ eligible: true, code: "same-exact-topology", reason: null, instrumentId: id, exactEngineIdentity: desiredIdentity });
  }

  function decodeBase64(value) {
    const source = typeof value === "string" ? value : "";
    if (source.length % 4 !== 0 || !BASE64_RE.test(source)) {
      throw new PreparedInstrumentStateError("patch-base64-invalid", "Prepared Instrument patchState.data must be canonical base64");
    }
    if (typeof Buffer !== "undefined") {
      const decoded = Buffer.from(source, "base64");
      if (decoded.toString("base64") !== source) {
        throw new PreparedInstrumentStateError("patch-base64-invalid", "Prepared Instrument patchState.data must be canonical base64");
      }
      return Uint8Array.from(decoded);
    }
    if (typeof atob !== "function" || typeof btoa !== "function") {
      throw new PreparedInstrumentStateError("patch-base64-unavailable", "Base64 decoding is unavailable on the control plane");
    }
    let binary;
    try { binary = atob(source); }
    catch {
      throw new PreparedInstrumentStateError("patch-base64-invalid", "Prepared Instrument patchState.data must be canonical base64");
    }
    if (btoa(binary) !== source) {
      throw new PreparedInstrumentStateError("patch-base64-invalid", "Prepared Instrument patchState.data must be canonical base64");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function normalizedParameters(parameterSnapshot, packageView) {
    if (!object(parameterSnapshot)) {
      throw new PreparedInstrumentStateError("parameter-snapshot-invalid", "Prepared Instrument parameterSnapshot must be an object");
    }
    const parameters = Array.isArray(packageView?.parameters) ? packageView.parameters : [];
    const ids = [];
    const values = [];
    const expected = new Set();
    for (const parameter of parameters) {
      const id = text(parameter?.id);
      if (!id || expected.has(id)) {
        throw new PreparedInstrumentStateError("verified-parameter-schema-invalid", "Verified package parameter ids must be unique non-empty strings");
      }
      expected.add(id);
      if (!Object.hasOwn(parameterSnapshot, id)) {
        throw new PreparedInstrumentStateError("parameter-snapshot-incomplete", `Prepared Instrument is missing stable parameter ${id}`, { parameterId: id });
      }
      const value = parameterSnapshot[id];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new PreparedInstrumentStateError("parameter-value-invalid", `Prepared Instrument parameter ${id} must be a numeric normalized value in [0,1]`, { parameterId: id });
      }
      ids.push(id);
      values.push(value);
    }
    for (const key of Object.keys(parameterSnapshot)) {
      if (!expected.has(key)) {
        throw new PreparedInstrumentStateError("parameter-snapshot-unknown", `Prepared Instrument contains parameter not present in verified package: ${key}`, { parameterId: key });
      }
    }
    return Object.freeze({ ids: Object.freeze(ids), values: Object.freeze(values) });
  }

  function privateStateDelivery(stateBytes) {
    const bytes = Uint8Array.from(stateBytes);
    function copyStateBytesInto(target, offset = 0) {
      if (!(target instanceof Uint8Array)) {
        throw new PreparedInstrumentStateError("state-copy-target", "Prepared state copy target must be a Uint8Array");
      }
      const start = Number(offset);
      if (!Number.isSafeInteger(start) || start < 0) {
        throw new PreparedInstrumentStateError("state-copy-offset", "Prepared state copy offset must be a non-negative safe integer");
      }
      if (start + bytes.byteLength > target.byteLength) {
        throw new PreparedInstrumentStateError("state-copy-capacity", `Prepared state needs ${bytes.byteLength} bytes at offset ${start}, target has ${target.byteLength}`);
      }
      target.set(bytes, start);
      return bytes.byteLength;
    }
    return Object.freeze({ copyStateBytesInto });
  }

  function prepareEnvelope({
    instrumentId: rawInstrumentId,
    currentInstrument,
    desiredInstrument,
    packageView,
    commitId,
    sourceSubtype,
  } = {}) {
    const classification = classifySameTopology({ instrumentId: rawInstrumentId, currentInstrument, desiredInstrument, packageView });
    if (!classification.eligible) {
      throw new PreparedInstrumentStateError(classification.code, classification.reason, { instrumentId: rawInstrumentId ?? null });
    }
    if (!SUPPORTED_SUBTYPES.has(String(sourceSubtype))) {
      throw new PreparedInstrumentStateError("source-subtype", "Prepared state is limited to instrument.preset / instrument.patch");
    }
    const sequence = Number(commitId);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new PreparedInstrumentStateError("commit-id", "Prepared Instrument commitId must be a positive safe integer");
    }

    const manifest = packageView?.manifest;
    const stateSchemaVersion = Number(manifest?.stateSchemaVersion);
    const expectedStateBytes = Number(manifest?.stateBytes);
    if (!Number.isSafeInteger(stateSchemaVersion) || stateSchemaVersion < 0 || !Number.isSafeInteger(expectedStateBytes) || expectedStateBytes < 1) {
      throw new PreparedInstrumentStateError("verified-state-schema-invalid", "Verified package must expose stateSchemaVersion + positive stateBytes");
    }
    const contentSha256 = normalizedSha(manifest?.contentSha256);
    if (!SHA256_RE.test(contentSha256)) {
      throw new PreparedInstrumentStateError("verified-content-sha-invalid", "Verified package must expose an exact SHA-256 content identity");
    }

    const patchState = desiredInstrument?.patchState;
    if (!object(patchState) || text(patchState.encoding).toLowerCase() !== "base64") {
      throw new PreparedInstrumentStateError("patch-encoding-unsupported", "Prepared state currently requires base64 Production Instrument patchState");
    }
    if (Number(patchState.schemaVersion) !== stateSchemaVersion) {
      throw new PreparedInstrumentStateError("state-schema-mismatch", `Prepared state schema ${String(patchState.schemaVersion)} does not match verified package schema ${stateSchemaVersion}`);
    }
    const encodedState = typeof patchState.data === "string" ? patchState.data : "";
    const expectedBase64Chars = Math.ceil(expectedStateBytes / 3) * 4;
    if (encodedState.length !== expectedBase64Chars) {
      throw new PreparedInstrumentStateError("state-size-mismatch", `Prepared base64 length ${encodedState.length} cannot represent verified ${expectedStateBytes}-byte state`);
    }
    const stateBytes = decodeBase64(encodedState);
    if (stateBytes.byteLength !== expectedStateBytes) {
      throw new PreparedInstrumentStateError("state-size-mismatch", `Prepared state contains ${stateBytes.byteLength} bytes, expected ${expectedStateBytes}`);
    }

    const parameters = normalizedParameters(desiredInstrument.parameterSnapshot, packageView);
    const delivery = privateStateDelivery(stateBytes);

    return Object.freeze({
      instrumentId: classification.instrumentId,
      commitId: sequence,
      exactEngineIdentity: classification.exactEngineIdentity,
      contentSha256,
      stateSchemaVersion,
      stateByteLength: stateBytes.byteLength,
      copyStateBytesInto: delivery.copyStateBytesInto,
      parameterIds: parameters.ids,
      parameterValues: parameters.values,
      sourceSubtype: String(sourceSubtype),
      desiredPresetId: desiredInstrument?.presetRef?.id == null ? null : String(desiredInstrument.presetRef.id),
    });
  }

  function createSequencer() {
    const nextCommitId = new Map();
    const latestByInstrument = new Map();
    let prepared = 0;
    let superseded = 0;
    let released = 0;
    let rejected = 0;

    function prepare(input = {}) {
      const id = instrumentId(input.instrumentId ?? input.desiredInstrument?.id ?? input.currentInstrument?.id);
      const commitId = (nextCommitId.get(id) ?? 0) + 1;
      let envelope;
      try {
        envelope = prepareEnvelope({ ...input, instrumentId: id, commitId });
      } catch (error) {
        rejected += 1;
        throw error;
      }
      nextCommitId.set(id, commitId);
      if (latestByInstrument.has(id)) superseded += 1;
      latestByInstrument.set(id, envelope);
      prepared += 1;
      return envelope;
    }

    function latest(rawInstrumentId) {
      return latestByInstrument.get(instrumentId(rawInstrumentId)) ?? null;
    }

    function release(rawInstrumentId, commitId) {
      const id = instrumentId(rawInstrumentId);
      const current = latestByInstrument.get(id);
      if (!current || current.commitId !== Number(commitId)) return false;
      latestByInstrument.delete(id);
      released += 1;
      return true;
    }

    function snapshot() {
      return Object.freeze({
        prepared,
        superseded,
        released,
        rejected,
        queuedInstruments: latestByInstrument.size,
        latest: Object.freeze([...latestByInstrument.values()].map((item) => Object.freeze({ instrumentId: item.instrumentId, commitId: item.commitId, sourceSubtype: item.sourceSubtype }))),
      });
    }

    return Object.freeze({ prepare, latest, release, snapshot });
  }

  const api = Object.freeze({
    PreparedInstrumentStateError,
    exactIdentityFromRef,
    exactIdentityFromPackageView,
    classifySameTopology,
    decodeBase64,
    prepareEnvelope,
    createSequencer,
  });

  globalThis.BRKTRKPreparedInstrumentStateDomain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
