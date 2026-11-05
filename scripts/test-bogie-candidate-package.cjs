const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
require('../web/engine-package-domain.js');
require('../web/engine-package-loader.js');
require('../web/engine-package-tar-domain.js');
const dir = process.argv[2] || 'build/brk-bogie-candidate/output';
const entry = JSON.parse(readFileSync(join(dir, 'candidate-entry.json')));
const archive = new Uint8Array(readFileSync(join(dir, entry.packageUrl.replace(/^\.\//, ''))));
const parsed = globalThis.BRKTRKEnginePackageTarDomain.parseTar(gunzipSync(archive));
const loader = bytes => globalThis.BRKTRKEnginePackageLoader.createPackageLoader({
  readPackage: async () => ({ packageBytes: bytes, manifest: parsed.manifest, files: parsed.files }),
});
(async () => {
  const loaded = await loader(archive).load(entry);
  assert.equal(loaded.entry.engineId, 'brk-bogie');
  assert.equal(loaded.manifest.parameters.length, 8);
  assert.equal(loaded.manifest.parameters.find(p => p.key === 'model').values.length, 12);
  assert.equal(loaded.manifest.runtime.maxModuleInstances, 8);
  assert.ok(parsed.files['provenance/UPSTREAM-MIT.txt']?.length);
  assert.ok(parsed.files['provenance/LICENSE.txt']?.length);
  const damaged = Uint8Array.from(archive);
  damaged[Math.floor(damaged.length / 2)] ^= 1;
  await assert.rejects(loader(damaged).load(entry), /package SHA-256 mismatch/i);
  console.log('BRK_BOGIE_VERIFIED_PACKAGE=PASS; sha256=' + entry.packageSha256);
})().catch(error => { console.error(error); process.exitCode = 1; });
