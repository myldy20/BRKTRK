const assert = require("node:assert/strict");
const sound = require("./sound-edit-renderer.js");
const adapters = require("./store-runtime-adapters.js");

const view = {
  entry: {
    moduleId: "design.example.engine",
    engineId: "example",
    version: "1.2.3",
    packageSha256: "a".repeat(64),
    stateSchemaVersion: 65536,
    hostContract: { id: "brktrk-synth-gateway-v1" },
  },
  ui: {
    title: "Example Synth",
    enumLabels: { shape: ["A", "B", "C"] },
    pages: [
      { id: "main", label: "Main", mode: "curated", controls: ["shape", "cutoff"] },
      { id: "advanced", label: "Advanced", mode: "all" },
    ],
  },
  parameters: [
    { id: "shape", numericId: 256, name: "Shape", type: "enum", defaultNormalized: 0.5, values: ["A", "B", "C"] },
    { id: "cutoff", numericId: 513, name: "Cutoff", type: "continuous", defaultNormalized: 1 },
    { id: "drive.amount", numericId: 768, name: "Drive", type: "continuous", defaultNormalized: 0.25 },
  ],
};

const created = sound.buildCreationInput(view, 37);
assert.equal(created.name, "Example Synth");
assert.deepEqual(created.engineRef, {
  moduleId: "design.example.engine",
  engineId: "example",
  requestedVersion: "1.2.3",
  resolvedVersion: "1.2.3",
  resolvedPackageSha256: "a".repeat(64),
  hostContract: "brktrk-synth-gateway-v1",
  channel: "stable",
});
assert.deepEqual(created.parameterSnapshot, { shape: 0.5, cutoff: 1, "drive.amount": 0.25 });
assert.equal(created.patchState.schemaVersion, 65536);
assert.equal(created.patchState.data, null);

assert.deepEqual(sound.pageControls(view, "main").controls.map((item) => item.id), ["shape", "cutoff"]);
assert.deepEqual(sound.pageControls(view, "advanced").controls.map((item) => item.id), ["shape", "cutoff", "drive.amount"]);
assert.equal(sound.enumIndexFromNormalized(0.5, 3), 1);
assert.equal(sound.normalizedFromEnumIndex(2, 3), 1);
assert.equal(sound.displayValue(view.parameters[0], 0.5, view.ui), "B");
assert.equal(sound.parameterStep({ parameter: view.parameters[0] }, "fine"), 0.5, "enum keyboard step must follow descriptor choice count");
assert.equal(sound.normalizeParameterInput({ parameter: view.parameters[0] }, 0.68), 0.5, "enum writes must quantize to a descriptor choice");
assert.equal(sound.parameterStep({ parameter: view.parameters[1] }, "fine"), 0.01);
assert.equal(sound.parameterStep({ parameter: view.parameters[1] }, "coarse"), 0.1);

const productionTarget = {
  path: ["instrumentPool", 37, "parameterSnapshot", "drive.amount"],
  transaction: { parameterKey: "drive.amount" },
};
assert.deepEqual(sound.productionParameter(productionTarget), { instrumentId: 37, parameterId: "drive.amount" });
assert.deepEqual(adapters.parseInstrumentParameterTarget("production-instrument.parameter.37.drive.amount"), {
  instrumentId: 37,
  parameterId: "drive.amount",
  production: true,
});
assert.equal(
  adapters.parseInstrumentParameterTarget("instrument.parameter.3.5"),
  null,
  "removed preview parameter render targets must not be recognized",
);

console.log("M5A A4A descriptor-driven production Sound + stable parameter target tests passed");
