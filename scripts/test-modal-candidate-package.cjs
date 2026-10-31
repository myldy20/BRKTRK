const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { gunzipSync } = require("node:zlib");
require("../web/engine-package-domain.js");
require("../web/engine-package-loader.js");
require("../web/engine-package-tar-domain.js");
require("../web/engine-preset-domain.js");
const dir = resolve(process.argv[2] ?? "build/brk-modal-candidate/output");
const entry = JSON.parse(readFileSync(join(dir, "candidate-entry.json"), "utf8"));
const archive = new Uint8Array(readFileSync(join(dir, entry.packageUrl.replace(/^\.\//, ""))));
const parsed = globalThis.BRKTRKEnginePackageTarDomain.parseTar(gunzipSync(archive));
const makeLoader = bytes => globalThis.BRKTRKEnginePackageLoader.createPackageLoader({
  readPackage: async () => ({
    packageBytes: bytes,
    manifest: parsed.manifest,
    files: parsed.files,
  }),
});
(async () => {
  const loaded = await makeLoader(archive).load(entry);
  assert.equal(loaded.entry.engineId, "brk-modal");
  assert.equal(loaded.manifest.parameters.length, 89);
  assert.equal(loaded.manifest.runtime.maxModuleInstances, 8);
  assert.equal(loaded.manifest.runtime.directWasm, "runtime/brk_modal_module.wasm");
  assert.equal(loaded.manifest.integration?.profile, "brksynth-integration-ready-v1");
  const library = globalThis.BRKTRKEnginePresetDomain.createLibrary(loaded);
  assert.equal(library.presetCount, 34);
  assert.equal(library.presets.filter(x => x.applicable).length, 34);
  assert.equal(library.presets.filter(x => x.origin === "upstream").length, 28);
  assert.equal(library.presets.filter(x => x.origin === "brk").length, 6);
  assert.ok(archive.length > 10000, "real Modal package must include compiled JS/WASM");
  const changed = Uint8Array.from(archive);
  changed[Math.floor(changed.length / 2)] ^= 1;
  await assert.rejects(makeLoader(changed).load(entry), /package SHA-256 mismatch/i);
  console.log("BRK_MODAL_PRODUCTION_PACKAGE_LOADER=PASS; artifacts=" + loaded.manifest.artifacts.length
    + "; parameters=89; presets=34; sha256=" + entry.packageSha256);
})().catch(error => { console.error(error); process.exitCode = 1; });
