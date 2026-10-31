// Verify the real Sound preset library accepts all 34 generated Modal states.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
require("../web/engine-preset-domain.js");
const presetDir = resolve(process.argv[2] || "build/brk-modal-factory/presets");
const index = JSON.parse(readFileSync(join(presetDir, "index.json"), "utf8"));
const rows = index.presets;
assert.equal(rows.length, 34);
const keys = Object.keys(rows[0].parameterSnapshot);
assert.equal(keys.length, 89);
const files = { "presets/index.json": new Uint8Array(readFileSync(join(presetDir, "index.json"))) };
for (const row of rows) files["presets/" + row.stateFile] = new Uint8Array(readFileSync(join(presetDir, row.stateFile)));
const loaded = {
  entry: { moduleId: "design.myldy.brk-modal", engineId: "brk-modal" },
  manifest: {
    stateSchemaVersion: 65536,
    stateBytes: 768,
    parameters: keys.map(id => ({ id })),
    descriptors: { presets: "presets/index.json" },
  },
  files,
};
const library = globalThis.BRKTRKEnginePresetDomain.createLibrary(loaded);
assert.equal(library.presetCount, 34);
for (const preset of library.presets) {
  assert.equal(preset.applicable, true, preset.name + " missing parameter snapshot");
  assert.equal(preset.missingParameters.length, 0);
  assert.equal(preset.readOnly, true);
  assert.deepEqual(Buffer.from(preset.patchState.data, "base64"), Buffer.from(files[preset.statePath]));
  assert.equal(Object.keys(preset.parameterSnapshot).length, 89);
}
assert.equal(library.presets.filter(p => p.origin === "upstream").length, 28);
assert.equal(library.presets.filter(p => p.origin === "brk").length, 6);
console.log("BRK_MODAL_SOUND_PRESET_LIBRARY=PASS; presets=34, applicable=34");
