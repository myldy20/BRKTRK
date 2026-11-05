// Copy locked, separately qualified engine archives into the generated web
// store. Never rebuild or silently change an already published package.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../web/engine-package-domain.js');
require('../web/engine-package-loader.js');
require('../web/engine-package-tar-domain.js');
require('../web/engine-preset-domain.js');

const lock = JSON.parse(readFileSync('release/engines/catalog-lock.json', 'utf8'));
if (lock.schema !== 'brktrk-release-engine-lock-v1' || !Array.isArray(lock.releases) || !lock.releases.length) {
  throw Error('invalid release engine lock');
}
const targetCatalog = 'web/engines/catalog-v1.json';
const catalog = JSON.parse(readFileSync(targetCatalog, 'utf8'));
const seen = new Set(catalog.entries.map(e => `${e.moduleId}/${e.engineId}@${e.version}:${e.channel}`));
for (const release of lock.releases) {
  const entry = release.entry;
  if (!entry || entry.channel !== 'stable' || entry.status !== 'active'
      || !/^[0-9a-f]{40}$/.test(release.sourceCommit || '')
      || !/^[0-9a-f]{64}$/.test(entry.packageSha256 || '')) throw Error('invalid release engine identity');
  const key = `${entry.moduleId}/${entry.engineId}@${entry.version}:${entry.channel}`;
  if (seen.has(key)) throw Error('duplicate catalog engine ' + key);
  seen.add(key);
  const path = `packages/${entry.moduleId}/${entry.engineId}/${entry.version}.tar.gz`;
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.includes('..')
      || entry.packageUrl !== './' + path) throw Error('unsafe release archive path');
  const bytes = readFileSync(join('release/engines', path));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.packageSha256) throw Error('locked package SHA mismatch');
  const parsed = globalThis.BRKTRKEnginePackageTarDomain.parseTar(gunzipSync(bytes));
  const loaded = await globalThis.BRKTRKEnginePackageLoader.createPackageLoader({
    readPackage: async () => ({ packageBytes: bytes, manifest: parsed.manifest, files: parsed.files }),
  }).load(entry);
  if (parsed.manifest.candidateOnly !== false || parsed.manifest.source?.commit !== release.sourceCommit
      || parsed.manifest.source?.repository !== 'myldy20/BRKTRK'
      || parsed.manifest.source?.license !== 'GPL-3.0-only') throw Error('unqualified release provenance');
  for (const file of ['provenance/PROVENANCE.yml', 'provenance/LICENSE.txt', 'provenance/BUILD-SOURCE.md']) {
    if (!parsed.files[file]?.length) throw Error('release notice missing: ' + file);
  }
  if (entry.engineId === 'brk-modal') {
    const library = globalThis.BRKTRKEnginePresetDomain.createLibrary(loaded);
    if (loaded.manifest.parameters.length !== 89 || library.presetCount !== 34
        || library.presets.some(p => !p.applicable)) throw Error('Modal release is incomplete');
  }
  if (entry.engineId === 'brk-bogie') {
    if (loaded.manifest.parameters.length !== 8
        || loaded.manifest.parameters.find(p => p.key === 'model')?.values?.length !== 12
        || !parsed.files['provenance/UPSTREAM-MIT.txt']?.length) throw Error('Bogie release is incomplete');
  }
  const destination = join('web/engines', path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  catalog.entries.push(entry);
  console.log(`Installed locked engine ${key}: ${entry.packageSha256}`);
}
writeFileSync(targetCatalog, JSON.stringify(catalog, null, 2) + '\n');
