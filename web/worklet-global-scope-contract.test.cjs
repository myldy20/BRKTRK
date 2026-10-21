// The production AudioWorklet runs in AudioWorkletGlobalScope, which is neither
// Node nor a Window. Measured in Chromium 141 on 2026-09-24 by registering a
// probe processor: the scope exposes the ECMAScript built-ins, WebAssembly,
// Intl, console, MessagePort/Event/EventTarget/MessageEvent, the Streams
// classes and the worklet API (registerProcessor, AudioWorkletProcessor,
// sampleRate, currentFrame, currentTime) - and none of the names in
// ABSENT_FROM_WORKLET_SCOPE below. SharedArrayBuffer is also absent, because
// BRKTRK pages are not cross-origin isolated.
//
// Every other test runs Worklet code under Node's globals, which provide most
// of those names. That is how three defects shipped green:
//
// 1. the development engine called `new TextEncoder()` while building its
//    module, so it never registered in a real Worklet;
// 2. the ABI descriptor reader called `new TextDecoder()` inside a try that
//    returns null, so the descriptor bridge (#455/#462/#463/#468) silently
//    delivered nothing for any engine in any browser;
// 3. the Worklet's EngineRegistry re-verifies the normalized manifest the host
//    embeds in the module it builds, and normalization was not idempotent:
//    `numericId: null` became 0 on the second pass, so every engine whose
//    parameters carry no numeric id was rejected as having duplicates.
//
// This test runs the Worklet's real module graph and the real host-composed
// engine module inside a context that has only the scope's globals, then
// drives registration, the package-registry proof the host waits for,
// descriptors and audible output through it.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const repoRoot = join(__dirname, "..");
const read = (relative) => readFileSync(join(repoRoot, relative), "utf8");

const ABSENT_FROM_WORKLET_SCOPE = Object.freeze([
  "TextEncoder", "TextDecoder", "atob", "btoa", "queueMicrotask",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "structuredClone",
  "fetch", "importScripts", "XMLHttpRequest", "localStorage", "sessionStorage",
  "indexedDB", "caches", "document", "window", "navigator", "self", "performance",
  "crypto", "Blob", "URL", "MessageChannel", "Worker", "SharedArrayBuffer",
  "requestAnimationFrame",
]);

// The graph the production Worklet loads, in audio-worklet.js's own order, so
// a module added there is covered here without editing this list.
const workletEntry = read("web/audio-worklet.js");
const workletGraph = [...workletEntry.matchAll(/^import "\.\/(.+?)";$/gm)].map((match) => `web/${match[1]}`);
assert.ok(workletGraph.length >= 25, `audio-worklet.js import graph must be read, found ${workletGraph.length} modules`);
const DIAGNOSTICS_MODULE = "web/audio-worklet-diagnostics.js";
const DEV_ENGINE_RUNTIME = "engines/brk-dev-poly/runtime/brk-dev-poly.js";

// --- 1. no Worklet module names a global the scope does not have ------------

// Comments and string contents are removed first so prose and messages do not
// count; a bare identifier is flagged unless it is a property access, an object
// key or the operand of `typeof`, which is how guarded code asks safely.
function executableText(source) {
  let out = "";
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 1;
      out += `${char}${char}`;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function scopeViolations(label, source) {
  const code = executableText(source);
  const pattern = new RegExp(String.raw`(?<![.\w$])(?:${ABSENT_FROM_WORKLET_SCOPE.join("|")})\b(?!\s*:)`, "g");
  const found = [];
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    if (/typeof\s+$/.test(code.slice(Math.max(0, match.index - 16), match.index))) continue;
    found.push(`${label}:${code.slice(0, match.index).split("\n").length} uses ${match[0]}`);
  }
  return found;
}

{
  const violations = [];
  for (const file of [...workletGraph, "web/audio-worklet.js", DIAGNOSTICS_MODULE, DEV_ENGINE_RUNTIME]) {
    violations.push(...scopeViolations(file, read(file)));
  }
  assert.deepEqual(violations, [], "Worklet code must not name globals AudioWorkletGlobalScope does not provide");

  // The scan must actually be able to fail: these are the shapes of the two
  // defects it was written for, and a guarded or quoted use must not trip it.
  assert.equal(scopeViolations("fixture", "const decoder = new TextDecoder();").length, 1);
  assert.equal(scopeViolations("fixture", "const encoder = new TextEncoder();").length, 1);
  assert.equal(scopeViolations("fixture", 'const ok = typeof TextDecoder === "function"; // new TextDecoder()').length, 0);
  assert.equal(scopeViolations("fixture", 'throw new Error("fetch failed"); const now = globalThis.performance?.now?.();').length, 0);
}

// --- 2. the real module graph evaluates in a scope-shaped context -----------

const registeredProcessors = new Map();
class AudioWorkletProcessor {
  constructor() {
    this.port = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  }
}
const quietConsole = Object.freeze({ log() {}, info() {}, warn() {}, error() {}, debug() {} });
const scope = vm.createContext({
  console: quietConsole,
  registerProcessor(name, processorClass) { registeredProcessors.set(name, processorClass); },
  AudioWorkletProcessor,
  sampleRate: 48000,
  currentFrame: 0,
  currentTime: 0,
});
// A fresh V8 context carries SharedArrayBuffer; the browser scope does not.
vm.runInContext("delete globalThis.SharedArrayBuffer;", scope);
for (const name of ABSENT_FROM_WORKLET_SCOPE) {
  assert.equal(
    vm.runInContext(`typeof globalThis[${JSON.stringify(name)}]`, scope),
    "undefined",
    `the modelled Worklet scope must not provide ${name}`,
  );
}
assert.equal(vm.runInContext("typeof WebAssembly", scope), "object", "the Worklet scope provides WebAssembly");

for (const file of workletGraph) vm.runInContext(read(file), scope, { filename: file });
vm.runInContext(workletEntry.replace(/^import .*$/gm, ""), scope, { filename: "web/audio-worklet.js" });
vm.runInContext(read(DIAGNOSTICS_MODULE), scope, { filename: DIAGNOSTICS_MODULE });
assert.ok(registeredProcessors.has("brktrk-audio"), "the production processor must register in the Worklet scope");
assert.ok(registeredProcessors.has("brktrk-runtime-diagnostics"), "the diagnostics processor must register in the Worklet scope");

// --- 3. decodeUtf8 is exactly a non-fatal TextDecoder ------------------------

{
  // Node's TextDecoder is the oracle here, on the main thread where it exists.
  const { decodeUtf8 } = vm.runInContext("globalThis.BRKTRKBrkSynthAbiV1Runtime", scope);
  assert.equal(typeof decodeUtf8, "function", "the ABI runtime must expose its Worklet-safe UTF-8 decoder");
  const oracle = new TextDecoder();
  const encode = (text) => new TextEncoder().encode(text);
  const samples = [
    [], encode("CUTOFF"), encode("Hz"), encode("°"), encode("Ω · µs"), encode("音色"), encode("🎛️ drive"),
    [0x80], [0xc0, 0x80], [0xc2], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xef, 0xbf, 0xbf],
    [0xf0, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf5], [0xff, 0x41], [0xe0, 0x80, 0x41], [0x41, 0xf0, 0x9f, 0x92],
  ];
  let seed = 0x2545f491;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  for (let sample = 0; sample < 4000; sample += 1) {
    const length = Math.floor(random() * 12);
    // Bias toward the lead and continuation bytes where decoders go wrong.
    samples.push(Array.from({ length }, () => (random() < 0.5 ? 0x80 + Math.floor(random() * 0x80) : Math.floor(random() * 0x100))));
  }
  for (const bytes of samples) {
    const input = Uint8Array.from(bytes);
    assert.equal(decodeUtf8(input), oracle.decode(input), `decodeUtf8 must match TextDecoder for [${bytes.join(",")}]`);
  }
}

// --- 4. the host-composed engine module registers and plays in that scope ---

execFileSync(process.execPath, ["scripts/build-dev-engine-store.mjs"], { cwd: repoRoot, stdio: "pipe" });

const packageDomain = require("./engine-package-domain.js");
require("./engine-package-loader.js");
require("./engine-package-tar-domain.js");
const packageLoader = globalThis.BRKTRKEnginePackageLoader;
const tarDomain = globalThis.BRKTRKEnginePackageTarDomain;

class FixtureTransportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
globalThis.BRKTRKEnginePackageBrowser = Object.freeze({ EnginePackageTransportError: FixtureTransportError });
globalThis.location = { href: "http://127.0.0.1/index.html" };
require("./production-engine-host.js");
const host = globalThis.BRKTRKProductionEngineHost;

async function main() {
  const catalog = packageDomain.normalizeCatalog(JSON.parse(read("web/engines/catalog-v1.json")));
  const entry = catalog.entries[0];
  const archive = new Uint8Array(readFileSync(join(repoRoot, "web/engines", entry.packageUrl.replace(/^\.\//, ""))));
  const parsed = tarDomain.parseTar(zlib.gunzipSync(archive));
  const loader = packageLoader.createPackageLoader({
    readPackage: async () => ({ packageBytes: archive, manifest: parsed.manifest, files: parsed.files }),
    host: {},
  });
  const loaded = await loader.load(entry);
  const declaredKeys = loaded.manifest.parameters.map((parameter) => parameter.key);
  assert.ok(declaredKeys.length > 1, "the development engine must publish several parameters");
  assert.ok(
    loaded.manifest.parameters.every((parameter) => parameter.numericId === null),
    "the development engine's parameters carry no numeric id - the case the registry used to reject",
  );

  // Defect 3 at its source: the normalized manifest is what crosses into the
  // Worklet, and the Worklet verifies it again.
  const crossed = JSON.parse(JSON.stringify(loaded.manifest));
  assert.doesNotThrow(
    () => packageDomain.verifyManifestAgainstEntry(crossed, entry),
    "a normalized manifest must verify again unchanged",
  );
  assert.deepEqual(
    packageDomain.normalizeManifest(crossed, { allowMissingHostContract: true }).parameters.map((parameter) => parameter.numericId),
    loaded.manifest.parameters.map((parameter) => parameter.numericId),
    "normalizing a normalized manifest must not invent numeric parameter ids",
  );

  // A stable key can look numeric while explicitly declaring no numeric ID.
  // Another parameter may legitimately use numeric ID 0; both must survive.
  const numericKey = { ...crossed, parameters: [
    { ...crossed.parameters[0], key: "0", id: "0", numericId: null },
    { ...crossed.parameters[1], key: "other", id: "other", numericId: 0 },
  ] };
  const numericOnce = packageDomain.normalizeManifest(numericKey, { allowMissingHostContract: true });
  const numericTwice = packageDomain.normalizeManifest(numericOnce, { allowMissingHostContract: true });
  assert.deepEqual(numericTwice.parameters.map((item) => item.numericId), [null, 0]);

  // The exact module source the host hands to audioWorklet.addModule(). It is
  // an ES module with top-level await; an async strict function gives it the
  // same scoping and lets this context await its registration.
  const moduleSource = host.buildWorkletModuleSource(loaded);
  assert.deepEqual(
    scopeViolations("host-composed module", moduleSource),
    [],
    "the host-composed Worklet module must not name globals the scope lacks",
  );
  await vm.runInContext(`(async function () {\n"use strict";\n${moduleSource}\n}).call(undefined)`, scope, {
    filename: "host-composed-engine-module.js",
  });

  const runtime = vm.runInContext("globalThis.BRKTRKBrkSynthAbiV1Runtime", scope);
  const record = runtime.recordFor(loaded.entry);
  assert.ok(record, "the development engine must register through the host-composed module in the Worklet scope");

  // Defect 2: descriptors must be read, and read correctly, without TextDecoder.
  const described = record.abiDescriptors;
  assert.ok(described, "ABI descriptors must be read in the Worklet scope, not silently dropped");
  // Arrays built in the Worklet-scope realm have that realm's prototype, so copy
  // them into this one before comparing structurally.
  assert.deepEqual(Array.from(described.parameters, (parameter) => parameter.key), declaredKeys, "descriptor keys must decode to the declared parameters");
  assert.equal(described.engine?.engineId, loaded.entry.engineId, "the engine descriptor must decode the engine id");
  assert.equal(described.module?.moduleId, loaded.entry.moduleId, "the module descriptor must decode the module id");
  assert.ok(described.parameters.every((parameter) => parameter.displayName), "every descriptor must carry a decoded display name");

  // Defect 3 end to end: the processor must build an active registry holding
  // the package, which is the proof production-engine-bootstrap waits for.
  const Processor = registeredProcessors.get("brktrk-audio");
  const processor = new Processor({ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: {} });
  const posted = [];
  processor.port.postMessage = (message) => posted.push(message);
  const deliver = (message) => processor.port.onmessage({ data: vm.runInContext(`(${JSON.stringify(message)})`, scope) });
  const engineRef = {
    moduleId: loaded.entry.moduleId,
    engineId: loaded.entry.engineId,
    requestedVersion: loaded.entry.version,
    resolvedVersion: loaded.entry.version,
    resolvedPackageSha256: loaded.entry.packageSha256,
    hostContract: "brktrk-synth-gateway-v1",
  };
  deliver({
    type: "production-instruments",
    instruments: host.productionInstrumentSnapshot({
      instrumentPool: {
        0: {
          id: 0,
          name: "WORKLET SCOPE",
          engineRef,
          patchState: { schemaVersion: 1, encoding: "base64", data: null },
          parameterSnapshot: {},
        },
      },
    }),
  });
  deliver({ type: "production-package-registry-request", requestId: "worklet-scope-contract" });
  const registry = posted.find((message) => message?.type === "production-package-registry" && message.requestId === "worklet-scope-contract");
  assert.ok(registry, "the processor must answer the package-registry proof");
  assert.equal(registry.pendingInstrumentSync, false);
  assert.deepEqual(
    Array.from(registry.packages, (item) => [item.moduleId, item.engineId, item.version, item.packageSha256]),
    [[loaded.entry.moduleId, loaded.entry.engineId, loaded.entry.version, loaded.entry.packageSha256]],
    "the active registry must hold the registered package, or the host times out waiting for it",
  );

  // Audible output from a performer built by the Worklet-scope runtime. The
  // buffers are made inside the scope so nothing depends on cross-realm arrays.
  const performer = runtime.createPerformerFactory(record)({ track: 0, instrumentId: 0, sampleRate: 48000 });
  const [left, right] = vm.runInContext("[new Float32Array(256), new Float32Array(256)]", scope);
  const peak = () => Math.max(...left.map(Math.abs), ...right.map(Math.abs));
  performer.process({ frameCount: 256, left, right, accumulate: false });
  assert.equal(peak(), 0, "an idle performer must be silent");
  performer.handleEvent({ type: "note-on", pitch: 60, velocity: 100, sampleOffset: 0 });
  performer.process({ frameCount: 256, left, right, accumulate: false });
  assert.ok(peak() > 0.001, `a note must be audible from the Worklet-scope runtime, saw peak ${peak()}`);
  performer.destroy();

  console.log(`Worklet global-scope contract passed (${workletGraph.length + 2} Worklet modules, host-composed engine module, registry proof, descriptors, audio)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
