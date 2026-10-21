import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, sep } from 'node:path';
import { Script } from 'node:vm';

// The source tree stays unbundled/testable; Pages receives only the compact output.
const root = resolve(import.meta.dirname, '..');
const web = join(root, 'web');
const dist = join(root, 'dist');
const read = (path) => readFileSync(join(web, path), 'utf8');
const put = (path, data) => writeFileSync(join(dist, path), data);
const mustMatch = (text, regex, label) => {
  const match = regex.exec(text);
  if (!match) throw new Error('Compact build: missing ' + label);
  return match;
};
const assetList = (text) => [...text.matchAll(/"([^"]+)"/g)].map(match => match[1]);
const assertLocal = (ref) => {
  if (!ref.startsWith('./') || ref.includes('..')) {
    throw new Error('Compact build: unsafe relative asset ' + ref);
  }
  if (!existsSync(join(web, ref.slice(2)))) {
    throw new Error('Compact build: missing asset ' + ref);
  }
  return ref;
};
const readAsset = (ref) => readFileSync(join(web, assertLocal(ref).slice(2)), 'utf8');

const sourceIndex = read('index.html');
const originalBind = read('app-bind.js');
const originalWorker = read('sw.js');
const scriptPattern = /const DYNAMIC_SCRIPT_ASSETS = Object\.freeze\(\[([\s\S]*?)\]\);/;
const stylePattern = /const DYNAMIC_STYLE_ASSETS = Object\.freeze\(\[([\s\S]*?)\]\);/;
const scripts = assetList(mustMatch(originalBind, scriptPattern, 'runtime script list')[1]);
const dynamicStyles = assetList(mustMatch(originalBind, stylePattern, 'dynamic style list')[1]);
const initialStyles = [...sourceIndex.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)]
  .map(match => match[1].split('?')[0]);
if (scripts.length < 50 || dynamicStyles.length < 5 || initialStyles.length < 1) {
  throw new Error('Compact build: unexpected script/style manifest shape');
}
const uniqueStyles = [...new Set([...initialStyles, ...dynamicStyles])];
const css = uniqueStyles.map(ref => '/* ' + ref + ' */\n' + readAsset(ref)).join('\n\n');

// Keep the original dependency order and classic global-script semantics.
// A syntax check catches unexpected top-level redeclarations before publishing.
// In that case split at the failing boundary instead of renaming globals.
const groups = [];
let current = [];
for (const ref of scripts) {
  const code = readAsset(ref);
  const attempted = [...current, code].join('\n;\n');
  try {
    new Script(attempted, { filename: 'compact-runtime-check.js' });
    current.push(code);
  } catch (error) {
    if (current.length === 0) throw error;
    groups.push(current);
    new Script(code, { filename: ref });
    current = [code];
  }
}
if (current.length) groups.push(current);
if (groups.length > 8) {
  throw new Error('Compact build: unexpected ' + groups.length + ' JS chunks; review before deployment');
}
const bundles = groups.map((group, i) => groups.length === 1
  ? './runtime.bundle.js' : './runtime.' + String(i + 1).padStart(2, '0') + '.js');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(web, dist, {
  recursive: true,
  filter: (source) => {
    const name = relative(web, source).split(sep).join('/');
    if (!name) return true;
    if (name.endsWith('.test.cjs') || name.startsWith('fixtures/')) return false;
    // Keep the public smoke only for CI; Pages deletes it before publishing.
    if (name.endsWith('.html') && name !== 'index.html' && name !== 'public-source-browser-smoke.html') return false;
    return true;
  },
});
groups.forEach((group, i) => put(bundles[i].slice(2), group.join('\n;\n') + '\n'));
put('styles.bundle.css', css + '\n');
// One runtime module is also an early bootstrap dependency: retain its source file.
const bootstrapScripts = new Set([...sourceIndex.matchAll(/<script src="([^"]+)"/g)]
  .map(match => match[1].split('?')[0]));

// AudioWorklet uses its own ES-module graph. Some of its imports are ALSO used
// by the window runtime bundle. Never remove their standalone files: bundling
// the window does not make those URLs available to AudioWorkletGlobalScope.
// Walk transitive imports, so new worklet dependencies are covered automatically.
const workletAssets = new Set();
function retainWorkletModule(ref) {
  assertLocal(ref);
  if (workletAssets.has(ref)) return;
  workletAssets.add(ref);
  const source = readAsset(ref);
  const imports = source.matchAll(/^\s*import\s+(?:[^"'\n]*?\s+from\s+)?["'](\.[^"']+)["']/gm);
  for (const match of imports) {
    const specifier = match[1];
    if (!specifier.endsWith('.js')) {
      throw new Error('Compact build: unexpected worklet import ' + specifier + ' in ' + ref);
    }
    const fullPath = resolve(join(web, ref.slice(2), '..'), specifier);
    const localPath = relative(web, fullPath).split(sep).join('/');
    if (localPath.startsWith('../') || localPath.startsWith('/') || localPath === '..') {
      throw new Error('Compact build: worklet import escapes web/ ' + specifier);
    }
    retainWorkletModule('./' + localPath);
  }
}
retainWorkletModule('./audio-worklet.js');
const discarded = new Set([
  ...scripts.filter(ref => !bootstrapScripts.has(ref) && !workletAssets.has(ref)),
  ...uniqueStyles,
]);
for (const ref of discarded) rmSync(join(dist, ref.slice(2)), { force: true });

let bind = originalBind.replace(scriptPattern,
  'const DYNAMIC_SCRIPT_ASSETS = Object.freeze(' + JSON.stringify(bundles) + ');');
bind = bind.replace(stylePattern, 'const DYNAMIC_STYLE_ASSETS = Object.freeze([]);');
put('app-bind.js', bind);

let index = sourceIndex.replace(/^[ \t]*<link rel="stylesheet" href="[^"]+">[ \t]*\r?\n/gm, '');
index = index.replace('</head>', '  <link rel="stylesheet" data-brktrk-style-bundle href="./styles.bundle.css?v=0.9.0">\n</head>');
for (const href of [...index.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1])) {
  const local = href.split('?')[0];
  if (!local.startsWith('./') || !existsSync(join(dist, local.slice(2)))) {
    throw new Error('Compact build: HTML stylesheet not in output ' + href);
  }
}
put('index.html', index);

const workerPattern = /const BASE_ASSETS = \[([\s\S]*?)\];/;
const cached = assetList(mustMatch(originalWorker, workerPattern, 'service worker precache list')[1]);
const updatedAssets = [...new Set([
  ...cached.filter(ref => {
    if (discarded.has(ref)) return false;
    if (ref.startsWith('./fixtures/') || ref.endsWith('-browser-smoke.html')) return false;
    return true;
  }),
  ...workletAssets,
  ...bundles,
  './styles.bundle.css',
])];
// Each release gets a content-addressed SW cache identity. A fixed alpha2
// cache kept the old trusted engine package/JS when users refreshed a newer build.
const devCatalog = join(dist, 'engines', 'catalog-v1.json');
if (!existsSync(devCatalog)) throw new Error('Compact build: run npm run dev:engine first');
const versionHash = createHash('sha256')
  .update(originalWorker)
  .update(readFileSync(devCatalog));
for (const ref of updatedAssets) {
  if (ref === './' || ref === './sw.js') continue;
  if (!ref.startsWith('./') || !existsSync(join(dist, ref.slice(2)))) {
    throw new Error('Compact build: precache points at absent output ' + ref);
  }
  versionHash.update(ref).update(readFileSync(join(dist, ref.slice(2))));
}
const cacheVersion = versionHash.digest('hex').slice(0, 12);
const worker = originalWorker
  .replace(workerPattern, 'const BASE_ASSETS = ' + JSON.stringify(updatedAssets, null, 2) + ';')
  .replace(/brktrk-web-v0\.9\.0"/g, 'brktrk-web-v0.9.0-compact-' + cacheVersion + '"');
if (!worker.includes('brktrk-web-v0.9.0-compact-' + cacheVersion)) {
  throw new Error('Compact build: service worker release cache was not versioned');
}
put('sw.js', worker);
console.log('Compact BRKTRK: ' + scripts.length + ' runtime scripts -> ' +
  bundles.length + ' bundles; ' + uniqueStyles.length + ' styles -> 1 CSS; ' +
  updatedAssets.length + ' offline assets, ' + workletAssets.size + ' worklet modules preserved; SW cache ' + cacheVersion);
