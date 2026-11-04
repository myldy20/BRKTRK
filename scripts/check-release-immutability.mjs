// Existing engine identities and archive bytes are append-only: saved Projects
// refer to the exact package SHA and old paths must continue to resolve.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const base = process.env.BRKTRK_IMMUTABILITY_BASE;
const lockPath = 'release/engines/catalog-lock.json';
if (!base) {
  console.log('No comparison base; release immutability comparison skipped');
  process.exit(0);
}
if (!/^[0-9a-f]{40}$/.test(base)) throw Error('invalid immutability base SHA');
const git = args => execFileSync('git', args, { encoding: 'utf8' });
const oldLockExists = spawnSync('git', ['cat-file', '-e', `${base}:${lockPath}`]).status === 0;
if (!oldLockExists) {
  // Distinguish a new release store from an unavailable base revision.
  git(['cat-file', '-e', `${base}^{commit}`]);
  console.log('No release lock in comparison base');
  process.exit(0);
}
if (!existsSync(lockPath)) throw Error('existing release lock cannot be removed');
const oldLock = JSON.parse(git(['show', `${base}:${lockPath}`]));
const nextLock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (oldLock.schema !== nextLock.schema || !Array.isArray(oldLock.releases) || !Array.isArray(nextLock.releases)) {
  throw Error('invalid release lock schema');
}
const key = r => `${r.entry.moduleId}/${r.entry.engineId}@${r.entry.version}:${r.entry.channel}`;
const next = new Map(nextLock.releases.map(r => [key(r), r]));
if (next.size !== nextLock.releases.length) throw Error('duplicate release identity');
for (const previous of oldLock.releases) {
  if (JSON.stringify(next.get(key(previous))) !== JSON.stringify(previous)) {
    throw Error('published release entry changed or removed: ' + key(previous));
  }
}
const changed = git(['diff', '--name-only', '--diff-filter=DMRT', base, 'HEAD', '--', 'release/engines/packages/']).trim();
if (changed) throw Error('published package path changed or removed: ' + changed);
console.log('Published engine identities and package paths unchanged');
