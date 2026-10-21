const assert = require("node:assert/strict");
require("./production-instrument-domain.js");
const storage = require("./project-storage.js");

const RETIRED_PREVIEW_EXTENSION = "org.myldydesign.brktrk.preview-instruments-v2";
const RETIRED_COLLISION_EXTENSION = "org.myldydesign.brktrk.pre-v4-instrument-pool-unknown";
const UNKNOWN_EXTENSION = "org.example.old-internal";

function legacyProject(schemaVersion) {
  return {
    schemaVersion,
    projectName: "UNKNOWN COLLISION",
    tempo: 120,
    tracks: [],
    song: [],
    chains: {},
    phrases: {},
    instrumentPool: {
      vendorOpaque: { bytes: [1, 2, 3], keep: true },
    },
    compatibilityExtensions: {
      [RETIRED_PREVIEW_EXTENSION]: { retired: "preview" },
      [RETIRED_COLLISION_EXTENSION]: { retired: "collision" },
      [UNKNOWN_EXTENSION]: { keep: true },
    },
    unknownData: [],
  };
}

function assertScopedCompatibilityCleanup(project, label) {
  assert.equal(
    Object.hasOwn(project.compatibilityExtensions, RETIRED_PREVIEW_EXTENSION),
    false,
    `${label} must remove the retired preview extension`,
  );
  assert.equal(
    Object.hasOwn(project.compatibilityExtensions, RETIRED_COLLISION_EXTENSION),
    false,
    `${label} must remove the retired pre-v4 collision extension`,
  );
  assert.deepEqual(
    project.compatibilityExtensions[UNKNOWN_EXTENSION],
    { keep: true },
    `${label} must preserve unrelated compatibility extension data`,
  );
}

for (const schemaVersion of [0, 1, 2, 3]) {
  const source = legacyProject(schemaVersion);
  const before = JSON.stringify(source);
  const migrated = storage.migrateProject(source);
  assert.equal(migrated.project.schemaVersion, 5);
  assert.deepEqual(migrated.project.instrumentPool, {}, `schema ${schemaVersion} must not reinterpret pre-v4 instrumentPool data`);
  assertScopedCompatibilityCleanup(migrated.project, `schema ${schemaVersion}`);
  assert.equal(JSON.stringify(source), before, `schema ${schemaVersion} cleanup must not mutate source`);
}

{
  const schema4 = {
    ...legacyProject(4),
    instrumentPool: {
      3: {
        id: 3,
        name: "REAL V4",
        engineRef: {
          moduleId: "org.myldydesign.test",
          engineId: "org.myldydesign.test.engine",
          requestedVersion: "1",
          hostContract: "1.x",
        },
        patchState: { schemaVersion: 1, encoding: "json", data: {} },
        parameterSnapshot: {},
      },
    },
  };
  const migrated = storage.migrateProject(schema4);
  assert.equal(migrated.fromVersion, 4);
  assert.equal(migrated.project.schemaVersion, 5);
  assert.equal(migrated.project.instrumentPool[3].name, "REAL V4", "schema v4 must retain production instrumentPool semantics while migrating to v5");
  assert.deepEqual(migrated.project.phrases, {});
  assertScopedCompatibilityCleanup(migrated.project, "schema v4");
}

console.log("Schema-v4 production Instrument collision cleanup survives canonical schema-v5 migration");
