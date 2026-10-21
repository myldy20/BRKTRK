const assert = require("node:assert/strict");
const events = require("./parameter-event-domain.js");
const targets = require("./parameter-event-target-domain.js");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const engineRef = Object.freeze({
  moduleId: "design.myldy.test",
  engineId: "brk-test",
  resolvedVersion: "1.2.3",
  resolvedPackageSha256: SHA_A.toUpperCase(),
});
const instrumentPool = {
  2: { id: 2, engineRef },
  4: { id: 4, engineRef: { moduleId: "design.myldy.test", engineId: "brk-test" } },
};
const view = Object.freeze({
  entry: Object.freeze({
    moduleId: "design.myldy.test",
    engineId: "brk-test",
    version: "1.2.3",
    packageSha256: SHA_A,
  }),
  parameters: Object.freeze([
    Object.freeze({ id: "amp.gain", type: "continuous" }),
    Object.freeze({ id: "osc.wave", type: "enum", values: ["sine", "saw"] }),
    Object.freeze({ id: "filter.cutoff", type: "continuous" }),
  ]),
  ui: Object.freeze({
    interaction: Object.freeze({
      continuous: Object.freeze({ policy: "parameter-ramp", defaultSmoothingMs: 8 }),
      discrete: Object.freeze({ policy: "parameter-value", defaultSmoothingMs: 0 }),
    }),
    smoothingMsByKey: Object.freeze({ "filter.cutoff": 12 }),
  }),
});

assert.deepEqual(targets.exactIdentityFromRef(engineRef), {
  moduleId: "design.myldy.test",
  engineId: "brk-test",
  version: "1.2.3",
  packageSha256: SHA_A,
});
assert.equal(targets.sameIdentity(
  targets.exactIdentityFromRef(engineRef),
  targets.exactIdentityFromView(view),
), true);

assert.deepEqual(targets.interactionForView(view, "amp.gain").capabilities, undefined);
assert.deepEqual(
  {
    discrete: targets.interactionForView(view, "amp.gain").discrete,
    policy: targets.interactionForView(view, "amp.gain").policy,
    smoothingMs: targets.interactionForView(view, "amp.gain").smoothingMs,
    rampAllowed: targets.interactionForView(view, "amp.gain").rampAllowed,
  },
  { discrete: false, policy: "parameter-ramp", smoothingMs: 8, rampAllowed: true },
);
assert.deepEqual(
  {
    discrete: targets.interactionForView(view, "osc.wave").discrete,
    policy: targets.interactionForView(view, "osc.wave").policy,
    rampAllowed: targets.interactionForView(view, "osc.wave").rampAllowed,
  },
  { discrete: true, policy: "parameter-value", rampAllowed: false },
);
assert.equal(targets.interactionForView(view, "filter.cutoff").smoothingMs, 12);

const authored = [
  { instrumentId: 2, parameterId: "filter.cutoff", value: 0.72, interpolationOut: "linear" },
  { instrumentId: 2, parameterId: "amp.gain", value: 0.4, interpolationOut: "step" },
  { instrumentId: 2, parameterId: "osc.wave", value: 0.5, interpolationOut: "linear" },
];
const authoredBefore = structuredClone(authored);
const prepared = targets.prepareParameterEvents(authored, {
  instrumentPool,
  packageViewFor: () => view,
});
assert.equal(prepared.ok, true);
assert.equal(prepared.total, 3);
assert.equal(prepared.resolvedCount, 3);
assert.equal(prepared.unresolvedCount, 0);
assert.deepEqual(authored, authoredBefore, "target preparation must not mutate durable authored events");
assert.deepEqual(prepared.resolved.map((row) => row.event.parameterId), ["amp.gain", "filter.cutoff", "osc.wave"], "target preparation must inherit canonical event ordering");
assert.equal(prepared.resolved[0].target.engine.packageSha256, SHA_A);
assert.equal(prepared.resolved[0].target.capabilities.rampAllowed, true);
assert.equal(prepared.resolved[1].target.capabilities.smoothingMs, 12);
assert.equal(prepared.resolved[2].event.interpolationOut, "linear", "PE1 must preserve authored interpolation intent");
assert.equal(prepared.resolved[2].target.capabilities.rampAllowed, false, "PE1 reports capability instead of silently rewriting authored interpolation");

for (const [label, event, options, code] of [
  ["missing instrument",
    { instrumentId: 7, parameterId: "amp.gain", value: 0.5 },
    { instrumentPool, packageViewFor: () => view },
    "instrument-missing"],
  ["unresolved engine identity",
    { instrumentId: 4, parameterId: "amp.gain", value: 0.5 },
    { instrumentPool, packageViewFor: () => view },
    "exact-engine-identity-missing"],
  ["package unavailable",
    { instrumentId: 2, parameterId: "amp.gain", value: 0.5 },
    { instrumentPool, packageViewFor: () => null },
    "package-view-unavailable"],
  ["package resolver unavailable",
    { instrumentId: 2, parameterId: "amp.gain", value: 0.5 },
    { instrumentPool },
    "package-view-unavailable"],
  ["package resolver error",
    { instrumentId: 2, parameterId: "amp.gain", value: 0.5 },
    { instrumentPool, packageViewFor: () => { throw new Error("catalog cold"); } },
    "package-view-error"],
  ["package mismatch",
    { instrumentId: 2, parameterId: "amp.gain", value: 0.5 },
    { instrumentPool, packageViewFor: () => ({ ...view, entry: { ...view.entry, packageSha256: SHA_B } }) },
    "package-identity-mismatch"],
  ["parameter unavailable",
    { instrumentId: 2, parameterId: "missing.key", value: 0.5 },
    { instrumentPool, packageViewFor: () => view },
    "parameter-unavailable"],
  ["string value remains durable but unresolved for engine delivery",
    { instrumentId: 2, parameterId: "amp.gain", value: "half" },
    { instrumentPool, packageViewFor: () => view },
    "parameter-value-not-normalized"],
  ["out of range value remains durable but unresolved for engine delivery",
    { instrumentId: 2, parameterId: "amp.gain", value: 1.25 },
    { instrumentPool, packageViewFor: () => view },
    "parameter-value-not-normalized"],
]) {
  const result = targets.prepareParameterEvents([event], options);
  assert.equal(result.ok, false, label);
  assert.equal(result.resolvedCount, 0, label);
  assert.equal(result.unresolvedCount, 1, label);
  assert.equal(result.unresolved[0].code, code, label);
  assert.deepEqual(result.unresolved[0].event, events.serializeParameterEvents([event])[0], label + " must preserve the normalized durable event");
}

const mixed = targets.prepareParameterEvents([
  { instrumentId: 2, parameterId: "amp.gain", value: 0.2 },
  { instrumentId: 2, parameterId: "gone.parameter", value: 0.3 },
], { instrumentPool, packageViewFor: () => view });
assert.equal(mixed.ok, false);
assert.equal(mixed.resolvedCount, 1);
assert.equal(mixed.unresolvedCount, 1);
assert.equal(mixed.targets.length, 2, "PE1 must report every durable target rather than dropping unresolved locks");

console.log("PE1 exact-package ParameterEvent target preparation tests passed");
