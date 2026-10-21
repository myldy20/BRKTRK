const assert = require("node:assert/strict");

const records = new Map();
const key = (entry) => `${entry.moduleId}\u0000${entry.engineId}\u0000${entry.version}\u0000${String(entry.packageSha256 ?? "").toLowerCase()}`;
const makeRecord = (suffix, overrides = {}) => {
  const entry = Object.freeze({
    moduleId: `design.myldy.${suffix}`,
    engineId: suffix,
    version: "1.0.0",
    packageSha256: suffix.repeat(64).slice(0, 64),
    ...overrides,
  });
  return Object.freeze({
    key: key(entry),
    entry,
    manifest: Object.freeze({ contentSha256: "f".repeat(64) }),
    module: Object.freeze({ HEAPU8: Object.freeze({ buffer: Object.freeze({ byteLength: 1024 }) }) }),
  });
};
const recordA = makeRecord("a");
const recordB = makeRecord("b");
const recordA2 = makeRecord("a2", {
  moduleId: recordA.entry.moduleId,
  engineId: recordA.entry.engineId,
  version: recordA.entry.version,
  packageSha256: "c".repeat(64),
});
records.set(key(recordA.entry), recordA);
records.set(key(recordB.entry), recordB);

globalThis.BRKTRKBrkSynthAbiV1Runtime = Object.freeze({
  runtimeRecords: () => Object.freeze([...records.values()]),
  runtimeLifetimeSnapshot: () => Object.freeze([...records.values()].map((record) => Object.freeze({
    moduleId: record.entry.moduleId,
    engineId: record.entry.engineId,
    version: record.entry.version,
    packageSha256: record.entry.packageSha256,
    livePerformers: 0,
  }))),
  unregisterModuleRuntime(entry) { return records.delete(key(entry)); },
});

const configureCalls = [];
let transportActive = false;
let blockActive = false;
let baseMessageSink = null;
const baseRuntime = {
  // The real base Worklet posts these messages on non-structural routes.
  // Their contents must not erase the retirement extension's lifetime view.
  handleMessage(message) {
    if (message?.type !== "fixture-base-diagnostics") return false;
    baseMessageSink?.({ type: "production-diagnostics", snapshot: this.diagnostics() });
    return true;
  },
  configureInstruments(snapshot) {
    configureCalls.push(JSON.parse(JSON.stringify(snapshot ?? {})));
    return !(transportActive || blockActive);
  },
  stop() { transportActive = false; blockActive = false; return true; },
  diagnostics() { return Object.freeze({ transportActive, blockActive, activeRegistryPackages: Object.freeze([...records.values()].map((record) => record.entry)) }); },
};
class ProductionProgramError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
globalThis.BRKTRKProductionAudioRuntime = Object.freeze({
  ProductionProgramError,
  createProductionAudioRuntime: (options) => { baseMessageSink = options.postMessage; return baseRuntime; },
});

const domain = require("./production-runtime-lifetime-extension.js");
const messages = [];
const runtime = domain.createProductionAudioRuntime({ postMessage: (message) => messages.push(message) });
const instrument = (record) => Object.freeze({ engineRef: Object.freeze({
  moduleId: record.entry.moduleId,
  engineId: record.entry.engineId,
  resolvedVersion: record.entry.version,
  resolvedPackageSha256: record.entry.packageSha256,
}) });
const legacyInstrument = (record) => Object.freeze({ engineRef: Object.freeze({
  moduleId: record.entry.moduleId,
  engineId: record.entry.engineId,
  resolvedVersion: record.entry.version,
}) });

const exactRefs = domain.projectEngineRefs({ 1: instrument(recordA) });
assert.equal(domain.recordRequired(recordA, exactRefs, [recordA, recordA2]), true,
  "exact package pin must retain only its matching SHA even when same-semver runtimes coexist");
assert.equal(domain.recordRequired(recordA2, exactRefs, [recordA, recordA2]), false);
const sameSemverDifferentSha = Object.freeze([{ ...exactRefs[0], packageSha256: "c".repeat(64) }]);
assert.equal(domain.recordRequired(recordA, sameSemverDifferentSha, [recordA, recordA2]), false,
  "same module/engine/version with a different exact package SHA must not retain the old runtime");
assert.equal(domain.recordRequired(recordA, Object.freeze([{ ...exactRefs[0], packageSha256: recordA.entry.packageSha256.toUpperCase() }]), [recordA, recordA2]), true,
  "exact package identity comparison must normalize SHA casing");

const legacyRefs = domain.projectEngineRefs({ 1: legacyInstrument(recordA) });
assert.equal(domain.recordRequired(recordA, legacyRefs, [recordA]), true,
  "legacy unpinned ref may preserve one unambiguous already-registered runtime");
assert.equal(domain.recordRequired(recordA, legacyRefs, [recordA, recordA2]), false,
  "legacy unpinned ref must not keep one candidate when same-semver runtime identity is ambiguous");
assert.equal(domain.recordRequired(recordA2, legacyRefs, [recordA, recordA2]), false,
  "legacy unpinned ref must not retain every historical same-semver SHA");

assert.equal(runtime.configureInstruments({ 1: instrument(recordA) }), true);
assert.equal(records.has(key(recordA.entry)), true, "referenced exact runtime must remain registered");
assert.equal(records.has(key(recordB.entry)), false, "unreferenced runtime should retire at a stopped structural boundary");
assert.equal(configureCalls.length, 2, "runtime registry must rebuild once after retirement so no stale EngineRegistry retains the retired module");
assert.equal(messages.filter((message) => message.type === "production-runtime-retired").length, 1);
assert.equal(runtime.diagnostics().runtimeLifetime.retiredRuntimeCount, 1);

// Base events (e.g. track insert FX, sample assets, audition, render stop)
// publish their own diagnostics. The host must always receive runtimeLifetime,
// including AFTER one Worklet runtime was retired.
assert.equal(runtime.handleMessage({ type: "fixture-base-diagnostics" }), true);
const afterBaseDiagnostics = messages.at(-1);
assert.equal(afterBaseDiagnostics.type, "production-diagnostics");
assert.equal(afterBaseDiagnostics.snapshot.runtimeLifetime.registered, 1,
  "base-generated diagnostic events must include exact runtime registration count");
assert.equal(afterBaseDiagnostics.snapshot.runtimeLifetime.retiredRuntimeCount, 1,
  "base-generated diagnostic events must retain extension retirement state");
assert.equal(typeof afterBaseDiagnostics.snapshot.transportActive, "boolean",
  "enriched diagnostics must preserve existing base diagnostic properties");


// Returning to a previously retired package requires the main-thread host to
// re-register it before the structural snapshot reaches this boundary.
records.set(key(recordB.entry), recordB);
transportActive = true;
assert.equal(runtime.configureInstruments({ 2: instrument(recordB) }), false,
  "structural runtime retirement must defer while transport owns the active graph");
assert.equal(records.has(key(recordA.entry)), true, "old runtime must stay alive while the replacement snapshot is deferred");
assert.equal(records.has(key(recordB.entry)), true);

runtime.stop();
assert.equal(records.has(key(recordA.entry)), false, "old runtime should retire only after stop destroys its performers");
assert.equal(records.has(key(recordB.entry)), true, "new Project runtime must survive the deferred handover");
assert.ok(configureCalls.length >= 4, "stop-time retirement must rebuild the registry without the retired runtime");
assert.equal(runtime.diagnostics().runtimeLifetime.retiredRuntimeCount, 2);

// A schema-v4 legacy ref without resolvedPackageSha256 is safe only while one
// matching runtime exists. If catalog churn produces two same-semver SHAs, the
// stopped boundary must retire the entire ambiguous set instead of silently
// selecting one or retaining historical runtimes without bound.
records.clear();
records.set(key(recordA.entry), recordA);
records.set(key(recordA2.entry), recordA2);
assert.equal(runtime.configureInstruments({ 3: legacyInstrument(recordA) }), true);
assert.equal(records.size, 0, "ambiguous legacy same-semver runtime set must retire completely at a stopped boundary");
assert.equal(runtime.diagnostics().runtimeLifetime.retiredRuntimeCount, 4);
assert.equal(runtime.handleMessage({ type: "fixture-base-diagnostics" }), true);
assert.equal(messages.at(-1).snapshot.runtimeLifetime.registered, 0,
  "late base diagnostic must never reanimate a fully retired Worklet runtime");
assert.equal(messages.at(-1).snapshot.runtimeLifetime.retiredRuntimeCount, 4);

const retiredMessages = messages.filter((message) => message.type === "production-runtime-retired");
assert.equal(retiredMessages.at(-1).packages.length, 2, "ambiguous legacy retirement must report both retired exact identities to the Host");

console.log("A5 #349 exact-pin and bounded legacy stopped-only production runtime retirement regression passed");
