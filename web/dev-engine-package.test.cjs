// The development engine store is the only engine a developer machine has:
// the production store lives outside this repository, so without it the Sound
// workspace can only render "ENGINE CATALOG UNAVAILABLE" and no sound path is
// reachable at all. This test proves two things that a catalog JSON alone
// cannot: the built store passes the real production package loader, and the
// engine it ships actually renders audio through the real ABI-v1 runtime.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

require("./engine-package-domain.js");
require("./engine-package-loader.js");
require("./engine-package-tar-domain.js");
// Load the chain the production Worklet loads. audio-worklet.js imports the
// base runtime and then brk-synth-runtime-lifetime-extension.js, which
// REPLACES registerModuleRuntime and the global API with its own. Requiring
// only the base runtime here would test a code path production never takes -
// which is exactly how an earlier version of this test passed while the
// descriptor read was dead in the real Worklet.
require("./brk-synth-abi-v1-worklet.js");
require("./brk-synth-runtime-lifetime-extension.js");
const abi = globalThis.BRKTRKBrkSynthAbiV1Runtime;

const packageDomain = globalThis.BRKTRKEnginePackageDomain;
const packageLoader = globalThis.BRKTRKEnginePackageLoader;
const tarDomain = globalThis.BRKTRKEnginePackageTarDomain;

const repoRoot = join(__dirname, "..");
execFileSync(process.execPath, ["scripts/build-dev-engine-store.mjs"], { cwd: repoRoot, stdio: "pipe" });

// --- the built store must satisfy the production catalog/package contract ---

const catalog = packageDomain.normalizeCatalog(
  JSON.parse(readFileSync(join(repoRoot, "web/engines/catalog-v1.json"), "utf8")),
);
assert.equal(catalog.entries.length, 1, "development store publishes exactly one engine");

const entry = catalog.entries[0];
// Identity, not channel, is what keeps this engine distinct from production:
// the host resolves only the "stable" channel, so the dev store publishes
// there and must never borrow a production module/engine id.
assert.equal(entry.moduleId, "design.myldy.dev", "development engine must use its own module id");
assert.equal(entry.engineId, "brk-dev-poly", "development engine must use its own engine id");
assert.notEqual(entry.moduleId, "design.myldy.brk-wav", "development engine must not claim the production module id");

const archive = new Uint8Array(readFileSync(join(repoRoot, "web/engines", entry.packageUrl.replace(/^\.\//, ""))));
// The transported archive is gzipped, exactly as the browser fetches it.
const parsed = tarDomain.parseTar(require("node:zlib").gunzipSync(archive));

const loader = packageLoader.createPackageLoader({
  readPackage: async () => ({ packageBytes: archive, manifest: parsed.manifest, files: parsed.files }),
  host: {},
});

async function main() {
  // Verifies the archive SHA-256 against the catalog and every artifact hash
  // against the manifest, exactly as the browser host does.
  const loaded = await loader.load(entry);
  assert.equal(String(loaded.manifest.abiVersion), "0x00010000", "engine must declare ABI v1");
  assert.equal(loaded.manifest.parameters.length, 9, "engine must publish its full parameter set");
  assert.ok(loaded.files[loaded.manifest.runtime.directJs], "package must ship its declared direct JS runtime");
  assert.ok(loaded.files["LICENSE.txt"], "development package must ship its GPL license");
  assert.ok(loaded.files["NOTICE.txt"], "development package must ship copyright and donor notices");
  assert.equal(new TextDecoder().decode(loaded.files["LICENSE.txt"]), readFileSync(join(repoRoot, "LICENSE"), "utf8"), "packaged license must match root");
  assert.match(new TextDecoder().decode(loaded.files["NOTICE.txt"]), /GPL-3\.0-only/, "package notice must identify GPLv3");
  assert.ok(loaded.files[loaded.manifest.runtime.directWasm], "package must ship its declared direct binary");

  // sound-edit-renderer has always supported per-parameter `group` hints and
  // `ui.pages` focus tabs, but no engine had ever supplied either, so both were
  // dead paths and the Sound workspace could only draw one undifferentiated row
  // of nine controls. Keep this engine exercising them.
  const uiPath = loaded.manifest.descriptors.ui;
  assert.ok(uiPath && loaded.files[uiPath], "package must ship a UI descriptor");
  const ui = JSON.parse(new TextDecoder().decode(loaded.files[uiPath]));
  const pageIds = ui.pages.map((page) => page.id);
  assert.deepEqual(pageIds, ["all", "osc", "filter", "env", "amp"], "UI pages must follow the signal flow");
  assert.equal(ui.pages[0].mode, "all", "the default page must stay the full control list");

  // Every parameter belongs to exactly one focus page, and every page control
  // resolves: a typo here silently drops a control out of the focused view.
  const declared = new Set(loaded.manifest.parameters.map((parameter) => parameter.id));
  const covered = new Set();
  for (const page of ui.pages.slice(1)) {
    for (const id of page.controls) {
      assert.ok(declared.has(id), `UI page ${page.id} references unknown parameter ${id}`);
      assert.ok(!covered.has(id), `parameter ${id} appears on more than one focus page`);
      covered.add(id);
    }
  }
  assert.equal(covered.size, declared.size, "every parameter must appear on exactly one focus page");
  for (const parameter of loaded.manifest.parameters) {
    assert.ok(parameter.group, `parameter ${parameter.id} must declare a signal-flow group`);
  }

  // "SHAPE 0%" names nothing a musician can act on. sound-edit-renderer will
  // show enum labels when a parameter declares `values`, picking one with
  // round(value * (count - 1)); the engine quantizes identically, so the label
  // on screen is always the waveform that sounds.
  const shape = loaded.manifest.parameters.find((parameter) => parameter.id === "shape");
  assert.deepEqual(shape.values, ["SAW", "SQUARE", "SINE", "NOISE"], "SHAPE must publish waveform names");

  const cutoff = loaded.manifest.parameters.find((parameter) => parameter.id === "cutoff");
  assert.ok(!cutoff.plainRange, "CUTOFF must stay normalized until the descriptor can see the live sample rate");
  assert.ok(!cutoff.plainCurve, "CUTOFF must not claim a static curve/range that the sample-rate clamp can invalidate");

  const pan = loaded.manifest.parameters.find((parameter) => parameter.id === "pan");
  assert.deepEqual(pan.plainRange, [-100, 100], "PAN is linear and should read as a bipolar position");
  assert.ok(!pan.plainCurve, "PAN is linear and must not claim a curve");

  const envIds = ["attack", "decay", "release"];
  for (const id of envIds) {
    const parameter = loaded.manifest.parameters.find((candidate) => candidate.id === id);
    assert.deepEqual(parameter.plainRange, [1, 4000], `${id} must declare the engine's 1ms..4s range`);
    assert.equal(parameter.plainCurve, "exponential", `${id} must declare its exponential curve`);
  }

  // --- the shipped engine must render audio through the real ABI runtime ---

  const engineSource = new TextDecoder().decode(loaded.files[loaded.manifest.runtime.directJs]);
  assert.match(engineSource, /const LICENSE_ID = "GPL-3\.0-only";/, "engine ABI must report GPLv3, not proprietary");
  // The host composes the Worklet module by evaluating the package JS and then
  // awaiting a global Module() factory; do the same rather than requiring the
  // source directly, so this exercises the real hosting shape.
  new Function(engineSource)();
  assert.equal(typeof globalThis.Module, "function", "engine package must expose a Module factory");
  const module = await globalThis.Module({ wasmBinary: loaded.files[loaded.manifest.runtime.directWasm] });

  abi.registerModuleRuntime({ entry: loaded.entry, manifest: loaded.manifest, module });
  const factory = abi.createPerformerFactory(abi.recordFor(loaded.entry));
  const performer = factory({ track: 0, instrumentId: 0, sampleRate: 48000 });

  const frames = 256;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const peak = (buffer) => buffer.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
  const finite = (buffer) => buffer.every((sample) => Number.isFinite(sample));

  // Silence before any note: a performer that hums at rest would sum across
  // eight Tracks into a constant noise floor.
  performer.process({ frameCount: frames, left, right, accumulate: false });
  assert.equal(peak(left), 0, "idle performer must render silence on the left channel");
  assert.equal(peak(right), 0, "idle performer must render silence on the right channel");

  performer.handleEvent({ type: "note-on", pitch: 60, velocity: 100, sampleOffset: 0 });
  performer.process({ frameCount: frames, left, right, accumulate: false });
  assert.ok(finite(left) && finite(right), "rendered audio must not contain NaN or Infinity");
  const attackPeak = Math.max(peak(left), peak(right));
  assert.ok(attackPeak > 0.001, `note-on must produce audible output, saw peak ${attackPeak}`);

  // Sustain must keep sounding: an envelope that collapses would make every
  // row a click rather than a note.
  performer.process({ frameCount: frames, left, right, accumulate: false });
  assert.ok(Math.max(peak(left), peak(right)) > 0.001, "held note must keep sounding");

  // Release must actually decay to silence, or notes would never free up.
  performer.handleEvent({ type: "note-off", sampleOffset: 0 });
  let releasePeak = 1;
  for (let block = 0; block < 400 && releasePeak > 0.0005; block += 1) {
    performer.process({ frameCount: frames, left, right, accumulate: false });
    releasePeak = Math.max(peak(left), peak(right));
  }
  assert.ok(releasePeak <= 0.0005, `note-off must decay to silence, stalled at ${releasePeak}`);

  // A realtime parameter edit must reach the DSP: this is the path the Sound
  // controls drive, and a no-op here is indistinguishable from a dead control.
  performer.handleEvent({ type: "note-on", pitch: 60, velocity: 100, sampleOffset: 0 });
  performer.process({ frameCount: frames, left, right, accumulate: false });
  const openPeak = Math.max(peak(left), peak(right));
  performer.handleEvent({ type: "parameter", parameterId: "level", value: 0, rampFrames: 0, sampleOffset: 0 });
  performer.process({ frameCount: frames, left, right, accumulate: false });
  const mutedPeak = Math.max(peak(left), peak(right));
  assert.ok(mutedPeak < openPeak, `level parameter must change rendered output (${openPeak} -> ${mutedPeak})`);

  // Each waveform name must actually select a different waveform: a label that
  // does not change the sound is worse than a percentage, because it claims to.
  assert.deepEqual(
    globalThis.__BRK_DEV_POLY_SHAPES,
    shape.values,
    "engine waveform table and package descriptor must not drift apart",
  );

  // The renderer contract is intentionally generic. A package may describe a
  // static exponential mapping, but an unsupported or mathematically invalid
  // mapping must degrade to the normalized percentage instead of inventing a
  // plausible-looking value.
  const renderer = require("./sound-edit-renderer.js");
  assert.equal(renderer.displayValue(cutoff, 0.72), "72%", "sample-rate-dependent CUTOFF must remain an honest percentage");
  assert.equal(renderer.displayValue(pan, 0.5), "0.00", "linear PAN mapping must remain unchanged");

  // A control that throws takes the whole Sound surface down rather than
  // degrading, so a malformed descriptor must still render something.
  for (const decimals of [-1, 0, 99]) {
    const malformed = { id: "malformed", plainRange: [1, 100], plainScales: [{ divide: 1, decimals, unit: "Hz" }] };
    assert.doesNotThrow(
      () => renderer.displayValue(malformed, 0.5),
      `a descriptor declaring decimals ${decimals} must not break the Sound surface`,
    );
  }
  assert.equal(
    renderer.displayValue({ id: "nonpositive", plainRange: [0, 100], plainCurve: "exponential" }, 0.5),
    "50%",
    "an exponential curve with a non-positive bound must fall back to a percentage, not NaN",
  );
  assert.equal(
    renderer.displayValue({ id: "unknown-curve", plainRange: [1, 100], plainCurve: "logarithmic" }, 0.5),
    "50%",
    "a curve the renderer cannot evaluate must read as a percentage, not as a linear value it never was",
  );

  const parseShown = (text) => {
    const [, number, unit] = /^(-?[\d.]+)\s*(\w+)?$/.exec(String(text).trim()) ?? [];
    const scale = { s: 1000, ms: 1 }[unit] ?? 1;
    return Number(number) * scale;
  };
  const engineEnvelopeMs = (normalized) => Math.pow(4000, normalized);

  // Sweep the whole travel densely. The bottom of an exponential time control
  // is where coarse formatting lies most dramatically: 1.50 ms rounded to
  // 2 ms is a 33% error even while values above 100 ms look fine.
  const attack = loaded.manifest.parameters.find((candidate) => candidate.id === "attack");
  const STEPS = 400;
  for (let step = 0; step <= STEPS; step += 1) {
    const normalized = step / STEPS;
    const shownMs = parseShown(renderer.displayValue(attack, normalized));
    const actualMs = engineEnvelopeMs(normalized);
    assert.ok(
      Math.abs(shownMs - actualMs) / actualMs < 0.01,
      `ATTACK at ${normalized} shows ${shownMs}ms but the engine mapping is ${actualMs}ms`,
    );
  }

  const shapeFingerprints = new Map();
  for (let index = 0; index < shape.values.length; index += 1) {
    const normalized = index / (shape.values.length - 1);
    performer.handleEvent({ type: "parameter", parameterId: "shape", value: normalized, rampFrames: 0, sampleOffset: 0 });
    performer.handleEvent({ type: "parameter", parameterId: "level", value: 1, rampFrames: 0, sampleOffset: 0 });
    performer.handleEvent({ type: "note-on", pitch: 57, velocity: 127, sampleOffset: 0 });
    performer.process({ frameCount: frames, left, right, accumulate: false });
    // Round hard so this compares waveform identity, not float noise.
    const fingerprint = [...left.slice(0, 64)].map((sample) => Math.round(sample * 64)).join(",");
    for (const [name, seen] of shapeFingerprints) {
      assert.notEqual(fingerprint, seen, `${shape.values[index]} renders identically to ${name}`);
    }
    shapeFingerprints.set(shape.values[index], fingerprint);
    performer.handleEvent({ type: "kill", sampleOffset: 0 });
    performer.process({ frameCount: frames, left, right, accumulate: false });
  }

  performer.destroy();

  // --- ABI descriptor surface -----------------------------------------------
  // BRK ABI v1 lets a host ask the engine binary what its parameters are,
  // instead of trusting a JSON file that can drift from the DSP. BRKSNTH's own
  // host treats this as authoritative; BRKTRK currently calls none of the three
  // descriptor exports, which is why real-engine parameters whose ranges live
  // in the binary can only render as percentages (see #455).
  //
  // The struct layouts below are the ABI's, not this engine's invention:
  // brk_string_ref is {offset u32, byte_size u32}, and the 96-byte parameter
  // descriptor size is fixed by the ABI. Reading them back at these exact
  // offsets is what proves the engine is a faithful ABI citizen rather than
  // merely self-consistent.
  const MODULE_DESCRIPTOR_BYTES = 84;
  const ENGINE_DESCRIPTOR_BYTES = 76;
  const PARAMETER_DESCRIPTOR_BYTES = 96;

  const descriptorCapacity = 256;
  const descriptorPtr = module._malloc(descriptorCapacity);
  const heapView = new DataView(module.HEAPU8.buffer);
  const readStringRef = (offset) => {
    const stringOffset = heapView.getUint32(offset, true);
    const byteSize = heapView.getUint32(offset + 4, true);
    return new TextDecoder().decode(module.HEAPU8.subarray(stringOffset, stringOffset + byteSize));
  };

  assert.equal(
    module._brk_module_descriptor(descriptorPtr, descriptorCapacity),
    MODULE_DESCRIPTOR_BYTES,
    "brk_module_descriptor must write the ABI's struct size",
  );
  assert.equal(readStringRef(descriptorPtr + 16), loaded.entry.moduleId, "module descriptor must report the package module id");
  assert.equal(heapView.getUint32(descriptorPtr + 12, true), 1, "development module publishes exactly one engine");

  assert.equal(
    module._brk_engine_descriptor(0, descriptorPtr, descriptorCapacity),
    ENGINE_DESCRIPTOR_BYTES,
    "brk_engine_descriptor must write the ABI's struct size",
  );
  assert.equal(readStringRef(descriptorPtr + 8), loaded.entry.engineId, "engine descriptor must report the package engine id");
  assert.equal(
    heapView.getUint32(descriptorPtr + 28, true),
    loaded.manifest.parameters.length,
    "engine descriptor parameter count must match the shipped parameter set",
  );
  assert.equal(
    heapView.getUint32(descriptorPtr + 32, true),
    Number(loaded.manifest.stateSchemaVersion),
    "engine descriptor state schema must match the package manifest",
  );

  // A capacity too small must report the required size rather than writing
  // past the buffer a host supplied.
  assert.equal(
    module._brk_engine_descriptor(0, descriptorPtr, 4),
    ENGINE_DESCRIPTOR_BYTES,
    "an undersized buffer must report the required size instead of writing",
  );
  assert.equal(module._brk_engine_descriptor(7, descriptorPtr, descriptorCapacity), 0, "an unknown engine index must report nothing");
  assert.equal(
    module._brk_parameter_descriptor(0, loaded.manifest.parameters.length, descriptorPtr, descriptorCapacity),
    0,
    "a parameter index past the end must report nothing",
  );

  // The anti-drift check. The engine and the package descriptor are two
  // statements about the same parameters, written in different places by
  // different code. Nothing else in the repository requires them to agree, and
  // a host that trusts one while the DSP obeys the other shows a value the
  // engine never uses.
  for (const [index, declared] of loaded.manifest.parameters.entries()) {
    assert.equal(
      module._brk_parameter_descriptor(0, index, descriptorPtr, descriptorCapacity),
      PARAMETER_DESCRIPTOR_BYTES,
      `parameter ${index} must write the ABI's 96-byte descriptor`,
    );
    assert.equal(heapView.getUint32(descriptorPtr, true), PARAMETER_DESCRIPTOR_BYTES, `parameter ${index} must report its own struct size`);
    assert.equal(readStringRef(descriptorPtr + 16), declared.id, `parameter ${index} key must match the package descriptor`);
    assert.equal(
      heapView.getUint32(descriptorPtr + 4, true),
      Number(declared.abiId),
      `parameter ${declared.id} abiId must match the package descriptor`,
    );
    assert.equal(
      readStringRef(descriptorPtr + 40),
      String(declared.group),
      `parameter ${declared.id} group must match the package descriptor`,
    );
    assert.ok(
      Math.abs(heapView.getFloat32(descriptorPtr + 48, true) - Number(declared.defaultNormalized)) < 1e-6,
      `parameter ${declared.id} default must match the package descriptor`,
    );
    const plainMin = heapView.getFloat32(descriptorPtr + 52, true);
    const plainMax = heapView.getFloat32(descriptorPtr + 56, true);
    assert.ok(plainMax > plainMin, `parameter ${declared.id} must report an ordered plain range`);
    // Where the package also states a range, the two must be the same range.
    if (Array.isArray(declared.plainRange) && declared.plainRange.length >= 2) {
      assert.ok(
        Math.abs(plainMin - Number(declared.plainRange[0])) < 1e-3 && Math.abs(plainMax - Number(declared.plainRange[1])) < 1e-3,
        `parameter ${declared.id} plain range disagrees: engine ${plainMin}..${plainMax}, package ${declared.plainRange.join("..")}`,
      );
    }
  }

  // --- the host reads what the engine says about itself ----------------------
  // Reading the descriptors directly above proves the engine answers. This
  // proves the ABI runtime asks: registerModuleRuntime now records what the
  // module reports, which is the first half of #455. An engine that does not
  // implement the calls must still register unchanged.
  const registered = abi.recordFor(loaded.entry);
  assert.ok(
    registered?.abiDescriptors,
    "the registration path production actually uses must carry what the engine reported over the ABI",
  );
  const reported = registered.abiDescriptors;

  assert.equal(reported.module.moduleId, loaded.entry.moduleId, "module descriptor must agree with package identity");
  assert.equal(reported.engine.engineId, loaded.entry.engineId, "engine descriptor must agree with package identity");
  assert.equal(
    reported.parameters.length,
    loaded.manifest.parameters.length,
    "the runtime must read every parameter the engine declares",
  );

  // The point of reading the binary is that it carries presentation truth the
  // package JSON does not. Assert the fields that motivated #455 actually
  // arrive, rather than only that the call returned something.
  const attackFromAbi = reported.parameters.find((parameter) => parameter.key === "attack");
  assert.ok(attackFromAbi, "ABI descriptors must name parameters by their stable key");
  assert.equal(attackFromAbi.unit, "ms", "a real unit must survive the read");
  assert.ok(
    attackFromAbi.plainMax > attackFromAbi.plainMin,
    `ABI plain range must be ordered, saw ${attackFromAbi.plainMin}..${attackFromAbi.plainMax}`,
  );
  assert.equal(attackFromAbi.groupKey, "ENV", "group key must survive the read");

  for (const declared of loaded.manifest.parameters) {
    const fromAbi = reported.parameters.find((parameter) => parameter.key === declared.id);
    assert.ok(fromAbi, `engine did not report parameter ${declared.id}`);
    assert.equal(fromAbi.abiId, Number(declared.abiId), `${declared.id} abiId disagrees between ABI and package`);
  }

  // An engine without the descriptor calls is the common case today - every
  // published engine predates this - so it must register exactly as before
  // rather than fail closed over a presentation detail.
  const silentModule = { ...module, _brk_parameter_descriptor: undefined, _brk_module_descriptor: undefined, _brk_engine_descriptor: undefined };
  assert.equal(
    abi.readModuleDescriptors(silentModule),
    null,
    "an engine that does not implement the descriptor calls must read as null, not throw",
  );
  // ...and so must one that answers but lies about its struct size.
  const lyingModule = { ...module, _brk_parameter_descriptor: () => 12 };
  assert.equal(
    abi.readModuleDescriptors(lyingModule),
    null,
    "a descriptor call reporting the wrong struct size must be refused, not misread",
  );

  // A synthetic module, so these properties can be driven directly rather than
  // by contorting the development engine into shapes it does not have.
  const syntheticModule = ({ engineParameters, growOnMalloc = false, declaredCount = null }) => {
    let heap = new Uint8Array(64 * 1024);
    const encoder = new TextEncoder();
    let cursor = 8192;
    const intern = (view, at, text) => {
      const bytes = encoder.encode(String(text ?? ""));
      heap.set(bytes, cursor);
      view.setUint32(at, cursor, true);
      view.setUint32(at + 4, bytes.byteLength, true);
      cursor += bytes.byteLength + 8;
    };
    const self = {
      get HEAPU8() { return heap; },
      _malloc: () => {
        if (growOnMalloc) {
          // Emscripten replaces HEAPU8 when memory grows; a reader that cached
          // a DataView over the old buffer would now be reading a stale one.
          const grown = new Uint8Array(heap.length * 2);
          grown.set(heap);
          heap = grown;
        }
        return 1024;
      },
      _free: () => {},
      _brk_engine_descriptor: (engineIndex, dst) => {
        const list = engineParameters[engineIndex];
        if (!list) return 0;
        const view = new DataView(heap.buffer);
        heap.fill(0, dst, dst + 76);
        view.setUint32(dst, 76, true);
        intern(view, dst + 8, `engine-${engineIndex}`);
        view.setUint32(dst + 28, Number.isInteger(declaredCount) ? declaredCount : list.length, true);
        return 76;
      },
      _brk_parameter_descriptor: (engineIndex, parameterIndex, dst) => {
        const list = engineParameters[engineIndex];
        const entry = list?.[parameterIndex];
        if (!entry) return 0;
        if (entry === "broken") return 7;
        const view = new DataView(heap.buffer);
        heap.fill(0, dst, dst + 96);
        view.setUint32(dst, 96, true);
        view.setUint32(dst + 4, entry.abiId, true);
        intern(view, dst + 16, entry.key);
        intern(view, dst + 32, entry.unit ?? "");
        view.setFloat32(dst + 52, entry.plainMin ?? 0, true);
        view.setFloat32(dst + 56, entry.plainMax ?? 1, true);
        return 96;
      },
    };
    return self;
  };

  // A package selects its engine with manifest.engineIndex and performers are
  // created with it, so reading engine 0 regardless would attach one engine's
  // ids, ranges and units to a runtime playing another.
  const twoEngineModule = syntheticModule({
    engineParameters: {
      0: [{ key: "wrong", abiId: 0x0001, unit: "dB", plainMin: -60, plainMax: 12 }],
      1: [{ key: "right", abiId: 0x0002, unit: "Hz", plainMin: 30, plainMax: 18000 }],
    },
  });
  assert.equal(abi.readModuleDescriptors(twoEngineModule, 1).parameters[0].key, "right", "engineIndex must select which engine is read");
  assert.equal(abi.readModuleDescriptors(twoEngineModule, 0).parameters[0].key, "wrong", "engine 0 must still be readable when it is the selected one");

  // A partial read is worse than none: an engine declaring several parameters
  // that fails partway would otherwise be recorded with only the prefix, and a
  // consumer treating descriptors as authoritative would drop the rest.
  const truncatingModule = syntheticModule({
    engineParameters: { 0: [{ key: "a", abiId: 1 }, "broken", { key: "c", abiId: 3 }] },
  });
  assert.equal(
    abi.readModuleDescriptors(truncatingModule, 0),
    null,
    "a declared parameter count that is not fully read must reject the whole descriptor set",
  );

  // #463: an engine declaring more parameters than this reader will ever read
  // is an unsupported descriptor set. Discarding the out-of-range count and
  // reading the first 4096 as if they were complete recreates exactly the
  // silent partial read the check above exists to prevent, with the truncation
  // hidden because the declared count was thrown away on the way in.
  const oversizedModule = syntheticModule({
    engineParameters: { 0: [{ key: "a", abiId: 1 }, { key: "b", abiId: 2 }] },
    declaredCount: 5000,
  });
  assert.equal(
    abi.readModuleDescriptors(oversizedModule, 0),
    null,
    "a declared parameter count beyond the read limit must reject the set, not silently truncate it",
  );

  // The limit itself stays readable; only counts beyond it are refused.
  const atLimitModule = syntheticModule({
    engineParameters: { 0: [{ key: "a", abiId: 1 }, { key: "b", abiId: 2 }] },
    declaredCount: 2,
  });
  assert.equal(abi.readModuleDescriptors(atLimitModule, 0).parameters.length, 2,
    "an in-range declared count must still be read in full");

  // An engine whose _malloc grows memory detaches any previously built heap
  // view. The read must still work rather than silently returning null.
  const growingModule = syntheticModule({
    engineParameters: { 0: [{ key: "cutoff", abiId: 0x0202, unit: "Hz", plainMin: 30, plainMax: 18000 }] },
    growOnMalloc: true,
  });
  const afterGrowth = abi.readModuleDescriptors(growingModule, 0);
  assert.ok(afterGrowth, "an engine that grows memory on _malloc must still report its descriptors");
  assert.equal(afterGrowth.parameters[0].unit, "Hz", "descriptors read after memory growth must not be stale");

  // --- factory presets ------------------------------------------------------
  // production-engine-host has read `descriptors.presets` since the preset
  // domain landed, but no engine ever declared it, so the factory-preset path
  // could only be exercised against hand-built fixtures. Now a clone can reach
  // it: library construction, full-state application, and later-edit-wins -
  // the questions #297 asks, which have never been answerable without a
  // physical session.

  const presetDomain = require("./engine-preset-domain.js");
  const library = presetDomain.createLibrary(loaded);
  assert.ok(library, "a package declaring descriptors.presets must build a preset library");
  assert.equal(library.stateBytes, Number(loaded.manifest.stateBytes), "preset index and manifest must agree on state size");
  assert.ok(library.presetCount >= 2, `preset library needs more than one preset to be worth anything, saw ${library.presetCount}`);
  for (const preset of library.presets) {
    // An incomplete parameterSnapshot loads as applicable:false and then never
    // applies, silently. That failure looks exactly like a preset that does
    // nothing, so assert it here rather than discover it by ear.
    assert.ok(preset.applicable, `preset ${preset.id} is not applicable: ${preset.unavailableReason}`);
    assert.equal(preset.patchState.schemaVersion, Number(loaded.manifest.stateSchemaVersion), `preset ${preset.id} state schema must match the package`);
  }

  // The real production application path: stage the verified bytes into the
  // module heap and commit them through _brk_instance_state_read, exactly as
  // brk-synth-prepared-state-extension does for a Prepared Instrument.
  require("./brk-synth-prepared-state-extension.js");
  const preparedAbi = globalThis.BRKTRKBrkSynthAbiV1Runtime;
  const preparedFactory = preparedAbi.createPerformerFactory(preparedAbi.recordFor(loaded.entry));
  let nextInstrumentId = 1;
  const freshPerformer = () => preparedFactory({ track: 0, instrumentId: nextInstrumentId++, sampleRate: 48000 });
  const stateBytesOf = (preset) => new Uint8Array(Buffer.from(preset.patchState.data, "base64"));

  const renderNote = (subject, blocks = 4) => {
    const out = [];
    subject.handleEvent({ type: "note-on", pitch: 60, velocity: 100, sampleOffset: 0 });
    for (let block = 0; block < blocks; block += 1) {
      subject.process({ frameCount: frames, left, right, accumulate: false });
      out.push(...left, ...right);
    }
    return Float32Array.from(out);
  };
  const rms = (buffer) => Math.sqrt(buffer.reduce((sum, sample) => sum + sample * sample, 0) / buffer.length);
  const applyPresetState = (subject, preset) => {
    subject.stagePreparedState({ stateBytes: stateBytesOf(preset), stateSchemaVersion: preset.patchState.schemaVersion });
    subject.commitPreparedState();
  };

  const presetRenders = new Map();
  for (const preset of library.presets) {
    // The binary state the DSP reads and the parameterSnapshot the Sound
    // surface reads are two encodings of one preset. If they disagree the
    // control lies about the sound - the same class of defect as a wrong unit,
    // and invisible to any test that checks only one of them. Applying each and
    // requiring bit-identical audio is what proves they agree; the engine's
    // noise is a seeded xorshift, so even NOISE renders reproducibly.
    const fromState = freshPerformer();
    applyPresetState(fromState, preset);
    const stateAudio = renderNote(fromState);

    const fromSnapshot = freshPerformer();
    for (const [parameterId, value] of Object.entries(preset.parameterSnapshot)) {
      fromSnapshot.handleEvent({ type: "parameter", parameterId, value, rampFrames: 0, sampleOffset: 0 });
    }
    const snapshotAudio = renderNote(fromSnapshot);

    assert.deepEqual(
      [...stateAudio],
      [...snapshotAudio],
      `preset ${preset.id}: the state file and the parameterSnapshot describe different sounds`,
    );
    assert.ok(rms(stateAudio) > 0.0005, `preset ${preset.id} must be audible, rendered RMS ${rms(stateAudio)}`);

    for (const [otherId, otherAudio] of presetRenders) {
      // A factory bank whose presets all sound the same is decoration.
      assert.ok(
        [...stateAudio].some((sample, index) => sample !== otherAudio[index]),
        `preset ${preset.id} renders identically to ${otherId}`,
      );
    }
    presetRenders.set(preset.id, stateAudio);
    fromState.destroy();
    fromSnapshot.destroy();
  }

  // #297 asks whether a later live edit wins over an applied full state and
  // survives the note lifecycle. Answering that has always needed a physical
  // session, because no engine in the repository had presets to apply.
  const quiet = library.presets.find((preset) => preset.id === "pad") ?? library.presets[0];
  const edited = freshPerformer();
  applyPresetState(edited, quiet);
  const beforeEdit = rms(renderNote(edited));
  edited.handleEvent({ type: "kill", sampleOffset: 0 });
  edited.process({ frameCount: frames, left, right, accumulate: false });

  edited.handleEvent({ type: "parameter", parameterId: "attack", value: 0, rampFrames: 0, sampleOffset: 0 });
  edited.handleEvent({ type: "parameter", parameterId: "level", value: 1, rampFrames: 0, sampleOffset: 0 });
  const afterEdit = rms(renderNote(edited));
  assert.ok(afterEdit > beforeEdit, `a later live edit must beat the applied preset (${beforeEdit} -> ${afterEdit})`);

  // ...and must survive release and retrigger, rather than the preset quietly
  // reasserting itself on the next note. A preset that reasserted would land
  // back at beforeEdit, which is ~19x quieter, so the 5% band is not tight.
  edited.handleEvent({ type: "note-off", sampleOffset: 0 });
  for (let block = 0; block < 400; block += 1) edited.process({ frameCount: frames, left, right, accumulate: false });
  const afterRetrigger = rms(renderNote(edited));
  assert.ok(
    Math.abs(afterRetrigger - afterEdit) / afterEdit < 0.05,
    `live edit must survive release and retrigger (${afterEdit} -> ${afterRetrigger})`,
  );
  edited.destroy();

  // State is a fixed-size block, so every preset is zero-padded. A zero abiId
  // is not a parameter; reading it back as one would write junk over the very
  // state just applied.
  const firstPreset = library.presets[0];
  const padded = freshPerformer();
  const withTrailingJunk = stateBytesOf(firstPreset);
  const junkView = new DataView(withTrailingJunk.buffer);
  // One pair past the terminator, write LEVEL 0. Reading past the terminator
  // would silence the voice, so this assertion is the difference between
  // stopping there and not.
  const pastTerminator = (loaded.manifest.parameters.length + 1) * 6;
  junkView.setUint16(pastTerminator, 0x0208, true);
  junkView.setFloat32(pastTerminator + 2, 0, true);
  padded.stagePreparedState({ stateBytes: withTrailingJunk, stateSchemaVersion: firstPreset.patchState.schemaVersion });
  padded.commitPreparedState();
  assert.deepEqual(
    [...renderNote(padded)],
    [...presetRenders.get(firstPreset.id)],
    "bytes after the zero terminator must not reach the DSP",
  );
  padded.destroy();

  console.log("Development engine package and DSP contract tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});