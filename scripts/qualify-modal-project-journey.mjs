// Serve the real app and an unpublished, hash-pinned Modal package only from
// an isolated temporary directory. Never write a candidate to the public tree.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'brktrk-modal-project-'));
let server;
try {
  const locked = process.argv[2] === '--locked-dist';
  cpSync(locked ? 'dist' : 'web', join(root, 'web'), { recursive: true });
  if (!locked) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync('scripts/build-dev-engine-store.mjs', join(root, 'scripts/build-dev-engine-store.mjs'));
    cpSync('engines/brk-dev-poly', join(root, 'engines/brk-dev-poly'), { recursive: true });
    cpSync('engines/brk-dev-fm', join(root, 'engines/brk-dev-fm'), { recursive: true });
    cpSync('LICENSE', join(root, 'LICENSE'));
    cpSync('NOTICE.md', join(root, 'NOTICE.md'));
    execFileSync(process.execPath, ['scripts/build-dev-engine-store.mjs'], { cwd: root });
  }
  cpSync('scripts/fixtures/modal-project-journey.html', join(root, 'web/modal-project-journey.html'));
  const candidateDir = locked ? null : resolve(process.argv[2] || 'build/brk-modal-candidate/output');
  const row = locked
    ? JSON.parse(readFileSync('release/engines/catalog-lock.json', 'utf8')).releases.find(r => r.entry.engineId === 'brk-modal')?.entry
    : JSON.parse(readFileSync(join(candidateDir, 'candidate-entry.json'), 'utf8'));
  if (!row) throw Error('Modal lock entry missing');
  const bytes = readFileSync(locked
    ? join(root, 'web/engines', row.packageUrl.replace(/^\.\//, ''))
    : join(candidateDir, row.packageUrl.replace(/^\.\//, '')));
  if (row.engineId !== 'brk-modal' || !['preview', 'stable'].includes(row.channel)
      || createHash('sha256').update(bytes).digest('hex') !== row.packageSha256) {
    throw Error('Modal candidate identity or SHA mismatch');
  }
  const path = `packages/${row.moduleId}/${row.engineId}/${row.version}.tar.gz`;
  mkdirSync(dirname(join(root, 'web/engines', path)), { recursive: true });
  writeFileSync(join(root, 'web/engines', path), bytes);
  row.packageUrl = './' + path;
  const catalogPath = join(root, 'web/engines/catalog-v1.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (locked) {
    if (!catalog.entries.some(e => e.moduleId === row.moduleId && e.engineId === row.engineId
      && e.version === row.version && e.packageSha256 === row.packageSha256 && e.packageUrl === row.packageUrl)) {
      throw Error('deployed catalog does not contain the locked Modal archive');
    }
  } else catalog.entries.push(row);
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const web = join(root, 'web');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' };
  server = createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const target = resolve(web, '.' + path);
      const check = relative(web, target);
      if (!check || check.startsWith('..') || check.startsWith('/')) throw Error('invalid path');
      const data = readFileSync(target);
      res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  for (const width of [1210, 390]) {
    let passed = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const child = spawn(process.execPath, ['scripts/run-browser-cdp-fixture.mjs',
        `http://127.0.0.1:${server.address().port}/modal-project-journey.html?width=${width}&channel=${row.channel}`,
        join(root, `profile-${width}-${attempt}`), join(root, `chrome-${width}-${attempt}.stderr`)],
        { env: { ...process.env, BRKTRK_CDP_DISCOVERY_ATTEMPTS: '250' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.setEncoding('utf8').on('data', part => out += part);
      child.stderr.setEncoding('utf8').on('data', part => err += part);
      const status = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', ok); });
      if (status === 0 && out.trim() === 'BRKTRK_BROWSER_TESTS_PASSED') {
        console.log(`BRK_MODAL_PROJECT_JOURNEY_${width}=PASS`);
        console.log(err.split('\n').filter(line => line.includes('Browser fixture diagnostics')).join('\n'));
        passed = true; break;
      }
      if (attempt === 1 && /DevToolsActivePort|Chrome exited before the DevTools endpoint/.test(out)) continue;
      throw Error(`Modal project journey ${width} failed:\n${out}\n${err}`);
    }
    if (!passed) throw Error(`Chromium bootstrap failed twice at ${width}`);
  }
} finally {
  if (server?.listening) await new Promise(ok => server.close(ok));
  rmSync(root, { recursive: true, force: true });
}
