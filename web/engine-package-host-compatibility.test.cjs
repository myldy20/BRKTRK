const assert = require("node:assert/strict");
const domain = require("./engine-package-domain.js");

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const legacyContract = { id: domain.HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const sharedContract = { id: domain.SHARED_HOST_CONTRACT_ID, minVersion: 1, maxVersion: 1 };
const host = {
  abiVersions: ["0x00010000"],
  hostContracts: [
    { id: domain.HOST_CONTRACT_ID, version: 1 },
    { id: domain.SHARED_HOST_CONTRACT_ID, version: 1 },
  ],
  integrationProfiles: [domain.SHARED_INTEGRATION_PROFILE],
  presentationModes: ["generic-descriptor-ui", "headless"],
};

const files = [{ path: "runtime/module.wasm", bytes: 4, sha256: "c".repeat(64) }];

function entry(overrides = {}) {
  return {
    moduleId: "design.myldy.fixture",
    engineId: "fixture",
    version: "1.0.0",
    channel: "stable",
    hostContract: legacyContract,
    abiVersion: 65536,
    packageUrl: "https://example.test/engines/packages/fixture.tar.gz",
    packageSha256: shaA,
    stateSchemaVersion: 1,
    parameterSchemaVersion: 1,
    status: "active",
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    schema: domain.PACKAGE_FORMAT,
    moduleId: "design.myldy.fixture",
    engineId: "fixture",
    version: "1.0.0",
    hostContract: legacyContract,
    abiVersion: 65536,
    stateSchemaVersion: 1,
    parameterSchemaVersion: 1,
    contentSha256: "d".repeat(64),
    files,
    ...overrides,
  };
}

// Standalone legacy normalization remains fail-closed for callers that have no
// trusted catalog/Host qualification context.
assert.throws(
  () => domain.normalizeManifest({ ...manifest(), hostContract: undefined }),
  /manifest\.hostContract is required/,
);

// The verified package path may accept a canonical v1 legacy manifest with no
// hostContract because the trusted catalog row binds exact bytes + compatibility.
const hostless = { ...manifest() };
delete hostless.hostContract;
const normalizedHostless = domain.normalizeManifest(hostless, { allowMissingHostContract: true });
assert.equal(normalizedHostless.hostContract, null);
assert.doesNotThrow(() => domain.verifyManifestAgainstEntry(hostless, entry(), host));

// rc5-style manifest/catalog compatibility remains valid.
assert.doesNotThrow(() => domain.verifyManifestAgainstEntry(manifest(), entry(), host));

// A shared package-manifest qualification is accepted only when the package
// itself carries the common Host profile and capabilities BRKTRK supports.
const sharedEntry = entry({
  hostContract: sharedContract,
  hostCompatibility: {
    profile: domain.SHARED_INTEGRATION_PROFILE,
    source: "package-manifest",
  },
});
const sharedManifest = manifest({
  hostContract: sharedContract,
  integration: {
    profile: domain.SHARED_INTEGRATION_PROFILE,
    audio: { inputBusCount: 0, outputBusCount: 1, inputChannelCount: 0, outputChannelCount: 2 },
    presentation: { mode: "generic-descriptor-ui" },
  },
});
assert.equal(domain.entryCompatibility(sharedEntry, host).compatible, true);
assert.doesNotThrow(() => domain.verifyManifestAgainstEntry(sharedManifest, sharedEntry, host));

assert.throws(
  () => domain.verifyManifestAgainstEntry({ ...sharedManifest, integration: undefined }, sharedEntry, host),
  (error) => error?.code === "manifest-catalog-mismatch" && error.details?.mismatches?.includes("integration.profile"),
);
assert.throws(
  () => domain.verifyManifestAgainstEntry({
    ...sharedManifest,
    integration: {
      ...sharedManifest.integration,
      presentation: { mode: "package-capability-ui" },
    },
  }, sharedEntry, host),
  (error) => error?.code === "manifest-catalog-mismatch" && error.details?.mismatches?.includes("integration.capabilities"),
);

// Exact external qualification allows immutable legacy bytes to remain untouched.
const qualifiedEntry = entry({
  hostContract: sharedContract,
  packageSha256: shaB,
  hostCompatibility: {
    profile: domain.SHARED_INTEGRATION_PROFILE,
    source: "host-qualification",
    qualification: {
      hostHead: "e".repeat(40),
      runner: "myldyserver-brksnth",
      runId: 123,
      jobId: 456,
      artifactId: 789,
      artifactDigestSha256: "f".repeat(64),
      packageSha256: shaB,
    },
  },
});
const qualifiedLegacyManifest = manifest({ hostContract: undefined });
delete qualifiedLegacyManifest.hostContract;
assert.equal(domain.entryCompatibility(qualifiedEntry, host).via, "host-qualification");
assert.doesNotThrow(() => domain.verifyManifestAgainstEntry(qualifiedLegacyManifest, qualifiedEntry, host));
assert.throws(
  () => domain.normalizeCatalogEntry({
    ...qualifiedEntry,
    hostCompatibility: {
      ...qualifiedEntry.hostCompatibility,
      qualification: { ...qualifiedEntry.hostCompatibility.qualification, packageSha256: shaA },
    },
  }),
  (error) => error?.code === "invalid-host-qualification",
  "external qualification must be bound to the exact catalog package SHA",
);

assert.throws(
  () => domain.verifyManifestAgainstEntry(
    { ...qualifiedLegacyManifest, hostContract: { id: "other-host-v1", minVersion: 1, maxVersion: 1 } },
    qualifiedEntry,
    host,
  ),
  (error) => error?.code === "manifest-catalog-mismatch"
    && error.details?.mismatches?.includes("hostContract"),
  "external qualification must not override an explicitly conflicting manifest Host contract",
);
assert.throws(
  () => domain.verifyManifestAgainstEntry({
    ...qualifiedLegacyManifest,
    integration: {
      profile: "other-integration-profile-v1",
      audio: { inputBusCount: 0, outputBusCount: 1, inputChannelCount: 0, outputChannelCount: 2 },
      presentation: { mode: "generic-descriptor-ui" },
    },
  }, qualifiedEntry, host),
  (error) => error?.code === "manifest-catalog-mismatch"
    && error.details?.mismatches?.includes("integration.profile"),
  "external qualification must not override an explicitly conflicting manifest integration profile",
);

// Unsupported Host contracts/ABIs are rejected before package Create.
const incompatibleContract = entry({ hostContract: { id: "other-host-v1", minVersion: 1, maxVersion: 1 } });
assert.equal(domain.entryCompatibility(incompatibleContract, host).compatible, false);
assert.equal(domain.entryCompatibility(incompatibleContract, host).code, "host-contract");

const incompatibleAbi = entry({ abiVersion: 0x00020000 });
assert.equal(domain.entryCompatibility(incompatibleAbi, host).compatible, false);
assert.equal(domain.entryCompatibility(incompatibleAbi, host).code, "abi-version");

// Current production ABI adapter is stereo-only.
assert.equal(domain.integrationCapabilitiesCompatible({
  integration: {
    profile: domain.SHARED_INTEGRATION_PROFILE,
    audio: { inputBusCount: 0, outputBusCount: 1, inputChannelCount: 0, outputChannelCount: 1 },
    presentation: { mode: "generic-descriptor-ui" },
  },
}, host), false, "mono shared packages must fail until mono negotiation/upmix exists");

// Profile-only catalog qualification still requires shared Host-contract support before resolve/download.
const profileOnlyEntry = entry({
  hostContract: undefined,
  hostCompatibility: { profile: domain.SHARED_INTEGRATION_PROFILE, source: "package-manifest" },
});
assert.equal(domain.entryCompatibility(profileOnlyEntry, host).compatible, true);
assert.equal(domain.entryCompatibility(profileOnlyEntry, {
  ...host,
  hostContracts: [{ id: domain.HOST_CONTRACT_ID, version: 1 }],
}).code, "host-contract");

// Catalog and package-manifest contracts must agree when both are present.
const disagreeingCatalogEntry = entry({
  hostContract: legacyContract,
  hostCompatibility: { profile: domain.SHARED_INTEGRATION_PROFILE, source: "package-manifest" },
});
assert.throws(
  () => domain.verifyManifestAgainstEntry(sharedManifest, disagreeingCatalogEntry, host),
  (error) => error?.code === "manifest-catalog-mismatch" && error.details?.mismatches?.includes("hostContract"),
);

console.log("A5 shared engine Host compatibility + legacy immutable package qualification passed");
