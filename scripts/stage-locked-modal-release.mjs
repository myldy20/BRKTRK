// Restage the already locked bytes for the production package and browser
// qualification tools. Never rebuild an existing version under its old name.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const lock = JSON.parse(readFileSync('release/engines/catalog-lock.json', 'utf8'));
const record = lock.releases.find(r => r.entry?.engineId === 'brk-modal');
if (!record || !/^[0-9a-f]{40}$/.test(record.sourceCommit)) throw Error('missing Modal source commit');
execFileSync('git', ['merge-base', '--is-ancestor', record.sourceCommit, 'HEAD']);
const entry = { ...record.entry };
const path = entry.packageUrl.replace(/^\.\//, '');
if (!/^packages\/[A-Za-z0-9._/-]+\.tar\.gz$/.test(path) || path.includes('..')) throw Error('unsafe locked path');
const bytes = readFileSync(join('release/engines', path));
if (createHash('sha256').update(bytes).digest('hex') !== entry.packageSha256) throw Error('locked Modal SHA mismatch');
const dir = 'build/brk-modal-release/output';
mkdirSync(dir, { recursive: true });
const name = basename(path);
writeFileSync(join(dir, name), bytes);
entry.packageUrl = './' + name;
writeFileSync(join(dir, 'candidate-entry.json'), JSON.stringify(entry, null, 2) + '\n');
console.log(`Restaged immutable Modal ${entry.version} ${entry.packageSha256}`);
