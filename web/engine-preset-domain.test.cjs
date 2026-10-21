const assert = require("node:assert/strict");
const presets = require("./engine-preset-domain.js");

const encoder = new TextEncoder();
const parameters = [
  { id: "cutoff", numericId: 513 },
  { id: "level", numericId: 770 },
];

function loadedWith(rows) {
  const index = {
    schema: "brk-preset-index-v1",
    moduleId: "design.myldy.fixture",
    engineId: "fixture",
    stateSchemaVersion: 65536,
    stateBytes: 4,
    presetCount: rows.length,
    presets: rows,
  };
  return {
    entry: { moduleId: "design.myldy.fixture", engineId: "fixture", version: "1.0.0" },
    manifest: {
      moduleId: "design.myldy.fixture",
      engineId: "fixture",
      stateSchemaVersion: 65536,
      stateBytes: 4,
      parameters,
      descriptors: { presets: "presets/index.json" },
    },
    files: {
      "presets/index.json": encoder.encode(JSON.stringify(index)),
      "presets/a.state": Uint8Array.from([1, 2, 3, 4]),
      "presets/b.state": Uint8Array.from([5, 6, 7, 8]),
    },
  };
}

const library = presets.createLibrary(loadedWith([
  { id: "a", name: "A", bank: "Factory", origin: "brk", stateFile: "a.state", parameterSnapshot: { cutoff: 0.25, level: 0.75 } },
  { id: "b", name: "B", bank: "Factory", origin: "brk", stateFile: "b.state" },
]));
assert.equal(library.presetCount, 2);
assert.equal(library.presets[0].applicable, true);
assert.deepEqual(library.presets[0].parameterSnapshot, { cutoff: 0.25, level: 0.75 });
assert.equal(library.presets[0].patchState.schemaVersion, 65536);
assert.equal(Buffer.from(library.presets[0].patchState.data, "base64").toString("hex"), "01020304");
assert.equal(library.presets[1].applicable, false);
assert.equal(library.presets[1].unavailableReason, "parameter-snapshot-missing");
assert.equal(library.presets[1].parameterSnapshot, null);

assert.equal(presets.resolvePackageRelative("presets/index.json", "nested/a.state"), "presets/nested/a.state");
assert.throws(() => presets.resolvePackageRelative("index.json", "../escape.state"), (error) => error.code === "preset-state-path");

assert.throws(() => presets.createLibrary(loadedWith([
  { id: "a", name: "A", stateFile: "a.state", parameterSnapshot: { cutoff: 0.2, level: 0.8, secret: 0.1 } },
])), (error) => error.code === "preset-parameter-unknown");

const incomplete = presets.createLibrary(loadedWith([
  { id: "a", name: "A", stateFile: "a.state", parameterSnapshot: { cutoff: 0.2 } },
]));
assert.equal(incomplete.presets[0].applicable, false);
assert.equal(incomplete.presets[0].unavailableReason, "parameter-snapshot-incomplete");
assert.deepEqual([...incomplete.presets[0].missingParameters], ["level"]);

console.log("A4B1 verified preset package contract passed");