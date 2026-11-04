import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('scripts/check-release-immutability.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'brktrk-release-guard-'));
const git = (...args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const release = { entry: { moduleId: 'one', engineId: 'synth', version: '1', channel: 'stable', packageSha256: 'a'.repeat(64) }, sourceCommit: 'b'.repeat(40) };
const lock = releases => JSON.stringify({ schema: 'brktrk-release-engine-lock-v1', releases });
const path = join(tmp, 'release/engines/packages/one/synth/1.tar.gz');
const lockPath = join(tmp, 'release/engines/catalog-lock.json');
function check(base) {
  return spawnSync(process.execPath, [script], { cwd: tmp, encoding: 'utf8', env: { ...process.env, BRKTRK_IMMUTABILITY_BASE: base } });
}
try {
  git('init', '-q'); git('config', 'user.name', 'CI test'); git('config', 'user.email', 'ci-test@example.invalid');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'old bytes'); writeFileSync(lockPath, lock([release]));
  git('add', '.'); git('commit', '-qm', 'old release');
  const base = git('rev-parse', 'HEAD');
  assert.equal(check(base).status, 0);
  const next = { entry: { ...release.entry, version: '2', packageSha256: 'c'.repeat(64) }, sourceCommit: 'd'.repeat(40) };
  writeFileSync(lockPath, lock([release, next]));
  writeFileSync(join(dirname(path), '2.tar.gz'), 'new bytes');
  git('add', '.'); git('commit', '-qm', 'append release');
  assert.equal(check(base).status, 0, 'appending a new release is allowed');
  writeFileSync(path, 'replacement bytes'); git('add', '.'); git('commit', '-qm', 'rewrite archive');
  assert.notEqual(check(base).status, 0, 'rewriting a published archive must fail');
  git('reset', '--hard', 'HEAD~1');
  writeFileSync(lockPath, lock([next])); git('add', '.'); git('commit', '-qm', 'remove old row');
  assert.notEqual(check(base).status, 0, 'removing a published identity must fail');
  assert.notEqual(check('f'.repeat(40)).status, 0, 'unknown base must fail closed');
  console.log('Release immutability guard PASS');
} finally { rmSync(tmp, { recursive: true, force: true }); }
