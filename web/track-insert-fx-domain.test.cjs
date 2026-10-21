const assert = require("node:assert/strict");
const fx = require("./track-insert-fx-domain.js");

assert.equal(fx.SLOT_COUNT, 2);
assert.deepEqual(fx.MODULES.map((entry) => entry.id), ["off", "chorus", "phaser", "saturation", "bitcrusher"]);
assert.deepEqual(fx.MODULES.map((entry) => entry.parameters.length), [0, 5, 5, 4, 4]);

assert.deepEqual([...fx.defaultValues("chorus")].slice(0, 5), [82, 115, 210, 96, 128]);
assert.deepEqual([...fx.defaultValues("phaser")].slice(0, 5), [60, 160, 144, 128, 0]);
assert.deepEqual([...fx.defaultValues("saturation")].slice(0, 4), [80, 220, 128, 255]);
assert.deepEqual([...fx.defaultValues("bitcrusher")].slice(0, 4), [8, 3, 220, 192]);

assert.equal(fx.mapValue("saturation", 2, 0), -12);
assert.equal(fx.mapValue("saturation", 2, 128), 0);
assert.equal(fx.mapValue("saturation", 2, 255), 12);
assert.equal(fx.mapValue("bitcrusher", 0, 99), 12, "discrete bit depth must clamp to donor max");
assert.equal(fx.describeValue("bitcrusher", 0, 8), "12 bit");
assert.equal(fx.describeValue("bitcrusher", 1, 3), "4x");
assert.equal(fx.describeValue("phaser", 4, 4), "8 stages");

{
  const normalized = fx.normalizeChain([
    { module: "saturation", bypass: false, values: [80, 220, 128, 255] },
    { module: "bogus", bypass: true, values: [255] },
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].module, "saturation");
  assert.equal(normalized[1].module, "off");
  assert.equal(normalized[1].bypass, true);
  assert.equal(normalized[0].values.length, 8);
}

function source(frames = 1024) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = Math.sin(i * 0.11) * 0.7;
    right[i] = Math.sin(i * 0.13) * 0.5;
  }
  return { left, right };
}
function difference(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total;
}
function finite(buffer) {
  return [...buffer].every(Number.isFinite);
}

for (const module of ["saturation", "bitcrusher", "chorus", "phaser"]) {
  const chain = fx.createChain(48000);
  const input = source();
  const originalLeft = new Float32Array(input.left);
  const originalRight = new Float32Array(input.right);
  chain.sync([{ module, values: fx.defaultValues(module) }, { module: "off" }]);
  for (let offset = 0; offset < input.left.length; offset += 128) {
    chain.process(input.left.subarray(offset, offset + 128), input.right.subarray(offset, offset + 128), 128);
  }
  assert.ok(finite(input.left) && finite(input.right), `${module} must remain finite`);
  assert.ok(difference(input.left, originalLeft) + difference(input.right, originalRight) > 1e-4,
    `${module} must audibly change the signal at donor defaults`);
  const diagnostics = chain.diagnostics();
  assert.equal(diagnostics.slots[0].configuredModule, module);
  assert.equal(diagnostics.slots[0].module, module);
  assert.equal(diagnostics.slots[0].switching, false);
  assert.ok(diagnostics.slots[0].wet > 0.99, `${module} must fade fully in`);
}

{
  const chain = fx.createChain(48000);
  const warm = source(512);
  chain.sync([{ module: "saturation" }, { module: "off" }]);
  for (let i = 0; i < 4; i += 1) chain.process(warm.left.subarray(i*128,(i+1)*128), warm.right.subarray(i*128,(i+1)*128),128);
  assert.ok(chain.diagnostics().slots[0].wet > 0.99);

  chain.sync([{ module: "bitcrusher" }, { module: "off" }]);
  const transition = source(512);
  let previousWet = chain.diagnostics().slots[0].wet;
  for (let i = 0; i < 4; i += 1) {
    chain.process(transition.left.subarray(i*128,(i+1)*128), transition.right.subarray(i*128,(i+1)*128),128);
    const current = chain.diagnostics().slots[0];
    assert.ok(current.wet >= 0 && current.wet <= 1);
    if (current.switching) assert.ok(current.wet <= previousWet + 1e-9, "module switch must fade down before reset");
    previousWet = current.wet;
  }
  assert.equal(chain.diagnostics().slots[0].module, "bitcrusher");
}

console.log("Track Insert FX Wave A donor descriptor + DSP contract passed");
