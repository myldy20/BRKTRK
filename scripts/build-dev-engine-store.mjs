#!/usr/bin/env node
// Build the local development engine store into web/engines/.
//
// The production engine store lives outside this repository, so a developer
// machine has no engine at all: the Sound workspace can only render
// "ENGINE CATALOG UNAVAILABLE · engine catalog fetch failed with HTTP 404" and
// no sound path is reachable. This script packages engines/brk-dev-poly into a
// real `brk-engine-catalog-v1` store so the Sound, Instrument lifecycle, preset
// and realtime-parameter paths can be exercised locally and in CI.
//
// The output is gitignored and published on the `dev` channel under its own
// module/engine id. It never replaces a production package: the host resolves
// engines by exact moduleId/engineId/version and verifies the archive SHA-256
// against the catalog, exactly as it does for a production store.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SOURCE_ROOT = "engines/brk-dev-poly";
const OUTPUT_ROOT = "web/engines";
const MODULE_ID = "design.myldy.dev";
const ENGINE_ID = "brk-dev-poly";
const VERSION = "0.1.0-dev1";
// The host resolves catalog entries by exact channel equality and asks for
// "stable"; there is no fallback to the "dev" channel. Publishing here on
// "stable" keeps that A5-critical resolution path untouched. The engine stays
// unmistakable by identity rather than by channel: its own module id, its own
// engine id and a BRK DEV POLY display name. Nothing is substituted - a Project
// that references the production design.myldy.brk-wav package still fails
// closed on a machine that only has this store.
const CHANNEL = "stable";
const ABI_VERSION = 0x00010000;
const HOST_CONTRACT = Object.freeze({ id: "brktrk-synth-gateway-v1", minVersion: 1, maxVersion: 1 });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The ABI-v1 host composes its Worklet module from runtime.directJs +
// runtime.directWasm and inlines the binary as a decimal array literal, so a
// JavaScript engine still has to declare a binary artifact. Keep it to the
// 8-byte wasm preamble: anything larger is paid for twice, once as bytes and
// again as JS source characters in the composed module.
const WASM_PREAMBLE = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

// `group` is rendered by sound-edit-renderer as a per-control hint, and
// `descriptors.ui` pages become focus tabs. Both mechanisms already exist in
// the host but no engine had ever supplied them, so the Sound workspace could
// only ever draw one undifferentiated row of controls. Ordering parameters by
// signal flow is what makes that row readable as a synth.
//
// sound-edit-renderer now honours a declared `plainCurve`, so controls whose
// normalized-to-plain mapping is static can print truthful real units. Envelope
// times qualify: the dev engine has always mapped 0..1 to 1ms..4s
// exponentially. Cutoff deliberately does NOT declare a plain range here: its
// effective ceiling is also sample-rate dependent (`sampleRate * 0.45`), and a
// static hash-pinned descriptor cannot truthfully encode that live value. A
// percentage is less pretty than a confident lie.
const SHAPE_LABELS = ["SAW", "SQUARE", "SINE", "NOISE"];
const ENV_MS = { min: 1, max: 4000 };

// Precision has to follow the curve, not the unit. An exponential control
// crowds its low end, so a single catch-all tier rounded a 1.18 ms attack to
// "1 ms" (15% out) and a 1.50 ms one to "2 ms" (33% out). These tiers keep the
// displayed envelope time within 1% across the whole range.
const MS_SCALES = [
  { atLeast: 1000, divide: 1000, decimals: 2, unit: "s" },
  { atLeast: 100, divide: 1, decimals: 0, unit: "ms" },
  { atLeast: 10, divide: 1, decimals: 1, unit: "ms" },
  { divide: 1, decimals: 2, unit: "ms" },
];
const exponentialRange = (range, scales) => ({
  plainRange: [range.min, range.max],
  plainCurve: "exponential",
  plainScales: scales,
});

const PARAMETERS = [
  { id: "shape", abiId: 0x0201, defaultNormalized: 0.0, label: "SHAPE", unit: "curve", group: "OSC", values: SHAPE_LABELS },
  { id: "cutoff", abiId: 0x0202, defaultNormalized: 0.72, label: "CUTOFF", unit: "norm", group: "FILTER" },
  { id: "resonance", abiId: 0x0203, defaultNormalized: 0.18, label: "RES", unit: "norm", group: "FILTER" },
  { id: "attack", abiId: 0x0204, defaultNormalized: 0.02, label: "ATTACK", unit: "ms", group: "ENV", ...exponentialRange(ENV_MS, MS_SCALES) },
  { id: "decay", abiId: 0x0205, defaultNormalized: 0.35, label: "DECAY", unit: "ms", group: "ENV", ...exponentialRange(ENV_MS, MS_SCALES) },
  { id: "sustain", abiId: 0x0206, defaultNormalized: 0.65, label: "SUSTAIN", unit: "norm", group: "ENV" },
  { id: "release", abiId: 0x0207, defaultNormalized: 0.30, label: "RELEASE", unit: "ms", group: "ENV", ...exponentialRange(ENV_MS, MS_SCALES) },
  { id: "level", abiId: 0x0208, defaultNormalized: 0.80, label: "LEVEL", unit: "norm", group: "AMP" },
  { id: "pan", abiId: 0x0209, defaultNormalized: 0.50, label: "PAN", unit: "bipolar", group: "AMP", plainRange: [-100, 100] },
];

const STATE_BYTES = 256;

// Factory presets. `descriptors.presets` has been read by production-engine-host
// since the preset domain landed, but no engine ever declared it, so the whole
// factory-preset path - index, full-state application, later-edit-wins - could
// only be exercised against hand-built fixtures. These make it reachable from a
// clone, which is what #297 needs to be answerable outside a physical session.
//
// Each preset names every parameter by its stable id. That is deliberate: the
// binary state the DSP reads and the parameterSnapshot the UI reads are both
// derived from this one table, so the two cannot disagree about what a preset
// is. A preset that listed only some parameters would load as `applicable:
// false` and silently never apply, so the build refuses to emit one.
const PRESETS = [
  {
    id: "init",
    name: "INIT",
    values: { shape: 0.00, cutoff: 0.72, resonance: 0.18, attack: 0.02, decay: 0.35, sustain: 0.65, release: 0.30, level: 0.80, pan: 0.50 },
  },
  {
    id: "bass",
    name: "SUB BASS",
    values: { shape: 0.33, cutoff: 0.30, resonance: 0.45, attack: 0.00, decay: 0.45, sustain: 0.30, release: 0.20, level: 0.90, pan: 0.50 },
  },
  {
    id: "pad",
    name: "SOFT PAD",
    values: { shape: 0.00, cutoff: 0.55, resonance: 0.10, attack: 0.62, decay: 0.70, sustain: 0.85, release: 0.75, level: 0.70, pan: 0.50 },
  },
  {
    id: "pluck",
    name: "PLUCK",
    values: { shape: 0.00, cutoff: 0.88, resonance: 0.55, attack: 0.00, decay: 0.28, sustain: 0.00, release: 0.22, level: 0.85, pan: 0.50 },
  },
  {
    id: "noise-hit",
    name: "NOISE HIT",
    values: { shape: 1.00, cutoff: 0.95, resonance: 0.05, attack: 0.00, decay: 0.20, sustain: 0.00, release: 0.15, level: 0.75, pan: 0.50 },
  },
];

// `[abiId u16][value f32]` little-endian pairs, zero-padded to stateBytes. A
// zero abiId terminates: no parameter uses it, and the engine stops there
// rather than reading padding back as a parameter write.
const presetState = (values) => {
  const bytes = new Uint8Array(STATE_BYTES);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const parameter of PARAMETERS) {
    const value = values[parameter.id];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`preset value for ${parameter.id} must be normalized to [0,1], got ${value}`);
    }
    view.setUint16(offset, parameter.abiId, true);
    view.setFloat32(offset + 2, value, true);
    offset += 6;
  }
  if (offset >= STATE_BYTES) throw new Error(`preset state needs ${offset + 6} bytes but stateBytes is ${STATE_BYTES}`);
  return bytes;
};

for (const preset of PRESETS) {
  const missing = PARAMETERS.filter((parameter) => !Object.hasOwn(preset.values, parameter.id));
  if (missing.length) {
    throw new Error(`preset ${preset.id} omits ${missing.map((parameter) => parameter.id).join(", ")}`);
  }
  const unknown = Object.keys(preset.values).filter((id) => !PARAMETERS.some((parameter) => parameter.id === id));
  if (unknown.length) throw new Error(`preset ${preset.id} names unknown parameters ${unknown.join(", ")}`);
}

// "All" stays first so the default view is unchanged; the signal-flow pages are
// additive focus views rather than a forced extra click.
const UI_PAGES = [
  { id: "all", label: "ALL", mode: "all" },
  { id: "osc", label: "OSC", controls: ["shape"] },
  { id: "filter", label: "FILTER", controls: ["cutoff", "resonance"] },
  { id: "env", label: "ENV", controls: ["attack", "decay", "sustain", "release"] },
  { id: "amp", label: "AMP", controls: ["level", "pan"] },
];

// `groupLabels` is part of brk-sound-ui-profile-v1 and was read by nothing
// until the Sound surface started grouping controls into titled sections. The
// dev engine declares them so the labelled path is exercised by the only
// engine that can be built and run from this repository; without them the
// surface falls back to the raw group key, which is correct but never proves
// the label was consumed.
const UI_GROUP_LABELS = {
  OSC: "Oscillator",
  FILTER: "Filter",
  ENV: "Envelope",
  AMP: "Amplifier",
};

// --- minimal ustar writer -------------------------------------------------
// engine-package-tar-domain.js parses a plain ustar stream; this writes one
// rather than shelling out to tar so the build is identical on every platform.
function tarHeader(path, size) {
  const header = new Uint8Array(512);
  const write = (text, offset, length) => {
    const bytes = new TextEncoder().encode(text);
    header.set(bytes.subarray(0, length), offset);
  };
  write(path, 0, 100);
  write("0000644\0", 100, 8);
  write("0000000\0", 108, 8);
  write("0000000\0", 116, 8);
  write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  write(`${(0).toString(8).padStart(11, "0")}\0`, 136, 12);
  write("        ", 148, 8);
  write("0", 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function buildTar(files) {
  const chunks = [];
  for (const [path, bytes] of files) {
    chunks.push(tarHeader(path, bytes.byteLength));
    chunks.push(bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.byteLength; }
  return archive;
}

// --- package --------------------------------------------------------------
const encoder = new TextEncoder();
const engineJs = readFileSync(join(SOURCE_ROOT, "runtime/brk-dev-poly.js"));

const parameterDescriptor = encoder.encode(`${JSON.stringify({
  schema: "brk-engine-parameters-v1",
  engineId: ENGINE_ID,
  parameterSchemaVersion: 1,
  parameters: PARAMETERS,
}, null, 2)}\n`);

const uiDescriptor = encoder.encode(`${JSON.stringify({
  schema: "brk-engine-ui-v1",
  engineId: ENGINE_ID,
  title: "BRK DEV POLY",
  pages: UI_PAGES,
  groupLabels: UI_GROUP_LABELS,
}, null, 2)}\n`);

const presetStateFiles = PRESETS.map((preset) => [`presets/${preset.id}.state`, presetState(preset.values)]);

// stateFile is resolved relative to the index, so the index sits beside the
// state files rather than in descriptors/.
const presetDescriptor = encoder.encode(`${JSON.stringify({
  schema: "brk-preset-index-v1",
  moduleId: MODULE_ID,
  engineId: ENGINE_ID,
  stateSchemaVersion: 1,
  stateBytes: STATE_BYTES,
  presetCount: PRESETS.length,
  presets: PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    bank: "Factory",
    origin: "engine",
    readOnly: true,
    stateFile: `${preset.id}.state`,
    parameterSnapshot: Object.fromEntries(PARAMETERS.map((parameter) => [parameter.id, preset.values[parameter.id]])),
  })),
}, null, 2)}\n`);

// Bundle notices into the self-contained development engine package. Since
// users can download the resulting .tar.gz independently from the source tree,
// they must receive the exact governing GPL license and upstream MIT credits.
const licenseBytes = new Uint8Array(readFileSync("LICENSE"));
const noticeBytes = new Uint8Array(readFileSync("NOTICE.md"));
const artifactFiles = [
  ["LICENSE.txt", licenseBytes],
  ["NOTICE.txt", noticeBytes],
  ["runtime/brk-dev-poly.js", new Uint8Array(engineJs)],
  ["runtime/brk-dev-poly.wasm", WASM_PREAMBLE],
  ["descriptors/parameters.json", parameterDescriptor],
  ["descriptors/ui.json", uiDescriptor],
  ["presets/index.json", presetDescriptor],
  ...presetStateFiles,
];

const artifacts = artifactFiles.map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: sha256(bytes) }));

// contentSha256 mirrors engine-package-domain.contentDigestInput: artifacts in
// ECMAScript code-unit path order, each as `path\0size\0sha256\n`.
const contentSha256 = sha256(encoder.encode(
  [...artifacts]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((artifact) => `${artifact.path}\u0000${artifact.size}\u0000${artifact.sha256}\n`)
    .join(""),
));

const manifest = {
  schema: "brk-engine-package-v1",
  moduleId: MODULE_ID,
  engineId: ENGINE_ID,
  version: VERSION,
  displayName: "BRK DEV POLY",
  hostContract: HOST_CONTRACT,
  abiVersion: ABI_VERSION,
  stateSchemaVersion: 1,
  stateBytes: STATE_BYTES,
  parameterSchemaVersion: 1,
  contentSha256,
  runtime: {
    directJs: "runtime/brk-dev-poly.js",
    directWasm: "runtime/brk-dev-poly.wasm",
    maxModuleInstances: 16,
    wasmInitialMemoryBytes: 4194304,
    memoryGrowth: false,
  },
  descriptors: { parameters: "descriptors/parameters.json", ui: "descriptors/ui.json", presets: "presets/index.json" },
  artifacts,
  parameters: PARAMETERS,
};

const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
// engine-package-tar-domain requires every member under exactly one root
// directory and strips that prefix, so artifact paths stay manifest-relative.
const ARCHIVE_ROOT = `${ENGINE_ID}-${VERSION}`;
const tarBytes = buildTar(
  [["brk-package.json", manifestBytes], ...artifactFiles]
    .map(([path, bytes]) => [`${ARCHIVE_ROOT}/${path}`, bytes]),
);
// The browser transport gunzips before parsing the tar and pins the SHA-256 of
// the *transported* bytes, so the archive is gzipped and hashed in that order.
// mtime is fixed so repeated builds of identical sources stay byte-identical
// and the pinned hash does not churn.
const archive = new Uint8Array(gzipSync(tarBytes, { level: 9, mtime: 0 }));
const packageSha256 = sha256(archive);
const packagePath = `packages/${MODULE_ID}/${ENGINE_ID}/${VERSION}.tar.gz`;

const catalog = {
  format: "brk-engine-catalog-v1",
  trust: { mode: "same-origin-pinned-path-v1", publisher: "myldy-brksynth" },
  generatedBy: "scripts/build-dev-engine-store.mjs",
  entries: [{
    moduleId: MODULE_ID,
    engineId: ENGINE_ID,
    version: VERSION,
    channel: CHANNEL,
    status: "active",
    displayName: "BRK DEV POLY",
    abiVersion: ABI_VERSION,
    hostContract: HOST_CONTRACT,
    packageUrl: `./${packagePath}`,
    packageSha256,
    packageBytes: archive.byteLength,
    contentSha256,
    stateSchemaVersion: 1,
    parameterSchemaVersion: 1,
  }],
};

rmSync(OUTPUT_ROOT, { recursive: true, force: true });
mkdirSync(dirname(join(OUTPUT_ROOT, packagePath)), { recursive: true });
writeFileSync(join(OUTPUT_ROOT, packagePath), archive);
// Public GPL alpha engine #2: 2-operator FM instead of BRK DEV POLY's
// analog oscillator. All ABI/voice-management semantics are shared; the
// oscillator is genuinely different. The original archive above is untouched
// to preserve the exact SHA of projects already pinned to BRK DEV POLY.
const FM_ID = "brk-dev-fm";
const FM_NAME = "BRK DEV FM";
const FM_MODES = ["FM 1:2", "FM 1:3", "FM 2:5", "FM 1:7"];
function requiredReplace(source, from, to) {
  if (!source.includes(from)) throw new Error("FM engine generator source drift: " + from.slice(0, 48));
  return source.replace(from, to);
}
let fmJs = engineJs.toString("utf8");
fmJs = requiredReplace(fmJs, 'const ENGINE_ID = "brk-dev-poly";', 'const ENGINE_ID = "brk-dev-fm";');
fmJs = requiredReplace(fmJs, 'const DISPLAY_NAME = "BRK DEV POLY";', 'const DISPLAY_NAME = "BRK DEV FM";');
fmJs = requiredReplace(fmJs, 'const SHAPE_LABELS = Object.freeze(["SAW", "SQUARE", "SINE", "NOISE"]);',
  'const SHAPE_LABELS = Object.freeze(["FM 1:2", "FM 1:3", "FM 2:5", "FM 1:7"]);');
fmJs = requiredReplace(fmJs, 'displayName: "SHAPE"', 'displayName: "MODE"');
fmJs = requiredReplace(fmJs, '__BRK_DEV_POLY_DESCRIPTORS', '__BRK_DEV_FM_DESCRIPTORS');
fmJs = requiredReplace(fmJs, '__BRK_DEV_POLY_SHAPES', '__BRK_DEV_FM_SHAPES');
const oscillatorBegin = fmJs.indexOf("    oscillator() {");
const oscillatorEnd = fmJs.indexOf("\n    envelopeStep() {", oscillatorBegin);
if (oscillatorBegin < 0 || oscillatorEnd < 0) throw new Error("FM engine generator could not locate oscillator");
const fmOscillator = [
  "    oscillator() {",
  "      const phase = this.phase * Math.PI * 2;",
  "      const mode = shapeIndex(this.param(PARAM.SHAPE));",
  "      // Genuine 2-operator FM; 2:5 is inharmonic, others use integer ratios.",
  "      const ratio = [2, 3, 2.5, 7][mode];",
  "      const index = [1.2, 2.7, 4.4, 6.2][mode];",
  "      return Math.sin(phase + index * Math.sin(phase * ratio));",
  "    }",
  "",
].join("\n");
fmJs = fmJs.slice(0, oscillatorBegin) + fmOscillator + fmJs.slice(oscillatorEnd);
const fmParameters = PARAMETERS.map(p => p.id === "shape"
  ? { ...p, label: "MODE", values: FM_MODES } : { ...p });
const names = ["INIT FM", "SUB FM", "FM PAD", "FM PLUCK", "METALLIC"];
const fmPresets = PRESETS.map((p, i) => ({
  ...p, name: names[i], values: { ...p.values, shape: [0, 0.33, 0.67, 0.33, 1][i] },
}));
const jsonBytes = value => encoder.encode(JSON.stringify(value, null, 2) + "\n");
const fmArtifacts = [
  ["LICENSE.txt", licenseBytes],
  ["NOTICE.txt", noticeBytes],
  ["runtime/brk-dev-fm.js", encoder.encode(fmJs)],
  ["runtime/brk-dev-fm.wasm", WASM_PREAMBLE],
  ["descriptors/parameters.json", jsonBytes({
    schema: "brk-engine-parameters-v1", engineId: FM_ID,
    parameterSchemaVersion: 1, parameters: fmParameters,
  })],
  ["descriptors/ui.json", jsonBytes({
    schema: "brk-engine-ui-v1", engineId: FM_ID, title: FM_NAME,
    pages: UI_PAGES, groupLabels: UI_GROUP_LABELS,
  })],
  ["presets/index.json", jsonBytes({
    schema: "brk-preset-index-v1", moduleId: MODULE_ID, engineId: FM_ID,
    stateSchemaVersion: 1, stateBytes: STATE_BYTES, presetCount: fmPresets.length,
    presets: fmPresets.map(p => ({
      id: p.id, name: p.name, bank: "Factory", origin: "engine",
      readOnly: true, stateFile: p.id + ".state",
      parameterSnapshot: Object.fromEntries(fmParameters.map(param => [param.id, p.values[param.id]])),
    })),
  })],
  ...fmPresets.map(p => ["presets/" + p.id + ".state", presetState(p.values)]),
];
const fmArtifactRecords = fmArtifacts.map(([path, bytes]) => ({
  path, size: bytes.byteLength, sha256: sha256(bytes),
}));
const fmContentHash = sha256(encoder.encode(fmArtifactRecords.slice()
  .sort((l, r) => l.path < r.path ? -1 : l.path > r.path ? 1 : 0)
  .map(a => a.path + "\u0000" + a.size + "\u0000" + a.sha256 + "\n").join("")));
const fmManifest = {
  ...manifest, engineId: FM_ID, displayName: FM_NAME, contentSha256: fmContentHash,
  runtime: { ...manifest.runtime, directJs: "runtime/brk-dev-fm.js", directWasm: "runtime/brk-dev-fm.wasm" },
  artifacts: fmArtifactRecords, parameters: fmParameters,
};
const fmTar = buildTar([["brk-package.json", jsonBytes(fmManifest)], ...fmArtifacts]
  .map(([path, bytes]) => [FM_ID + "-" + VERSION + "/" + path, bytes]));
const fmArchive = new Uint8Array(gzipSync(fmTar, { level: 9, mtime: 0 }));
const fmArchivePath = "packages/" + MODULE_ID + "/" + FM_ID + "/" + VERSION + ".tar.gz";
mkdirSync(dirname(join(OUTPUT_ROOT, fmArchivePath)), { recursive: true });
writeFileSync(join(OUTPUT_ROOT, fmArchivePath), fmArchive);
catalog.entries.push({
  moduleId: MODULE_ID, engineId: FM_ID, version: VERSION, channel: CHANNEL,
  status: "active", displayName: FM_NAME,
  abiVersion: ABI_VERSION, hostContract: HOST_CONTRACT,
  packageUrl: "./" + fmArchivePath,
  packageSha256: sha256(fmArchive), packageBytes: fmArchive.byteLength,
  contentSha256: fmContentHash, stateSchemaVersion: 1, parameterSchemaVersion: 1,
});

writeFileSync(join(OUTPUT_ROOT, "catalog-v1.json"), `${JSON.stringify(catalog, null, 2)}\n`);

console.log(`Development engine store built: ${OUTPUT_ROOT}/catalog-v1.json`);
console.log(`  ${MODULE_ID}/${ENGINE_ID}@${VERSION} (#${CHANNEL})`);
console.log(`  archive ${archive.byteLength} bytes, sha256 ${packageSha256}`);