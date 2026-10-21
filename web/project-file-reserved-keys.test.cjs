const assert = require("node:assert/strict");
require("./production-instrument-domain.js");
require("./parameter-event-domain.js");
const storage = require("./project-storage.js");
const file = require("./project-file.js");

// HARD-04 (#377). Measured first, then fixed. Before this, a project-level
// `constructor` survived every canonical boundary and shadowed the real one:
// typeof project.constructor stopped being "function". No prototype pollution
// was ever involved - JSON.parse makes these own data properties - so the rule
// is about object semantics, not security.

const base = storage.migrateProject({
  schemaVersion: 2,
  tempo: 138,
  song: [[7]],
  chains: { 7: [{ phrase: 9, transpose: 0 }] },
  phrases: { 9: [{ note: 61, velocity: 87, instrument: 3, fx: [0, 0, 0] }] },
}).project;

const POISON = { polluted: "yes" };
const envelopeText = (extra = "") => JSON.stringify({
  format: file.FILE_FORMAT,
  formatVersion: file.FILE_FORMAT_VERSION,
  project: base,
}).replace(/^\{/, `{${extra}`);
const inject = (obj, key) => JSON.parse(
  JSON.stringify(obj).replace(/^\{/, `{${JSON.stringify(key)}:${JSON.stringify(POISON)},`),
);

assert.deepEqual([...file.RESERVED_STRUCTURAL_KEYS], ["__proto__", "prototype", "constructor"]);
assert.equal(file.RESERVED_KEY_POLICY, "reject-reserved-structural-keys-at-boundary-records");

// The whole point: refused at the boundary rather than preserved.
for (const key of file.RESERVED_STRUCTURAL_KEYS) {
  assert.throws(
    () => file.prepareOpen(envelopeText(`${JSON.stringify(key)}:${JSON.stringify(POISON)},`)),
    (error) => error instanceof TypeError && new RegExp(`envelope boundary: ${key.replace("$", "\\$")}`).test(error.message),
    `envelope-level ${key} must be refused by name`,
  );
  assert.throws(
    () => file.prepareOpen(JSON.stringify({
      format: file.FILE_FORMAT,
      formatVersion: file.FILE_FORMAT_VERSION,
      project: inject(base, key),
    })),
    (error) => error instanceof TypeError && /project boundary/.test(error.message),
    `project-level ${key} must be refused by name`,
  );
}

// The same rule on the way out, so BRKTRK can never write a file it would then
// refuse to open. A one-sided check is how a format grows a dialect.
for (const key of file.RESERVED_STRUCTURAL_KEYS) {
  assert.throws(
    () => file.createEnvelope(inject(base, key)),
    /project boundary/,
    `saving a project carrying ${key} must be refused`,
  );
  assert.throws(
    () => file.createEnvelope(base, { unknownEnvelope: inject({ keep: 1 }, key) }),
    /envelope boundary/,
    `saving an envelope carrying ${key} must be refused`,
  );
}

// Nothing was polluted before the fix and nothing is now; the rule exists for
// shadowing, and claiming otherwise would overstate it.
assert.equal({}.polluted, undefined);

// Ordinary unknown data still round-trips untouched. Narrowing the guarantee
// on one axis must not quietly narrow it on the others.
{
  const unknown = { vendorNote: "keep me", nested: { deep: [1, 2, { ok: true }] } };
  const opened = file.prepareOpen(envelopeText(`"vendorNote":${JSON.stringify(unknown.vendorNote)},"nested":${JSON.stringify(unknown.nested)},`));
  assert.equal(opened.unknownEnvelope.vendorNote, "keep me");
  assert.deepEqual(opened.unknownEnvelope.nested, unknown.nested);
  const envelope = file.createEnvelope(opened.project, { unknownEnvelope: opened.unknownEnvelope });
  assert.equal(envelope.vendorNote, "keep me");
  assert.deepEqual(envelope.nested, unknown.nested);
}

// The room left for a future need: these names are only reserved as structural
// keys on the boundary records. Nested inside a value they are ordinary data
// and survive, so a real requirement has somewhere to go without reopening the
// shadowing hazard.
{
  const nested = JSON.parse('{"payload":{"constructor":"a string","__proto__":{"harmless":true}}}');
  const opened = file.prepareOpen(envelopeText(`"vendor":${JSON.stringify(nested)},`));
  assert.equal(opened.unknownEnvelope.vendor.payload.constructor, "a string");
  assert.equal(typeof opened.project.constructor, "function", "the project record itself is unaffected");
  assert.equal({}.polluted, undefined);
}

// A clean project is still perfectly openable and savable.
{
  const opened = file.prepareOpen(envelopeText());
  assert.equal(opened.project.tempo, 138);
  assert.equal(typeof opened.project.constructor, "function");
  const envelope = file.createEnvelope(opened.project);
  assert.equal(envelope.format, file.FILE_FORMAT);
}

// Exported policy cannot be mutated to bypass either boundary.
assert.equal(Object.isFrozen(file.RESERVED_STRUCTURAL_KEYS), true);
assert.throws(() => file.RESERVED_STRUCTURAL_KEYS.splice(0), TypeError);

// Legacy browser copies migrate without losing any of the formerly accepted
// values, then remain portable and idempotent. No ambient prototype assignment.
for (const key of file.RESERVED_STRUCTURAL_KEYS) {
  const original = inject(base, key);
  const migrated = storage.migrateProject(original).project;
  assert.equal(Object.hasOwn(migrated, key), false);
  assert.equal(Object.getPrototypeOf(migrated), Object.prototype);
  assert.deepEqual(migrated.compatibilityExtensions[storage.RESERVED_FIELDS_EXTENSION], [{ key, value: POISON }]);
  assert.deepEqual(storage.migrateProject(migrated).project, migrated);
  assert.deepEqual(file.prepareOpen(file.serializeProject(migrated)).project, migrated);
  const live = JSON.parse(JSON.stringify(original));
  storage.installRuntimeProject(live);
  assert.equal(Object.getPrototypeOf(live), Object.prototype);
  assert.equal(typeof live.constructor, "function");
}

{
  const raw = JSON.stringify(inject(base, "__proto__"));
  const entries = new Map([[storage.STORAGE_KEY, raw]]);
  const local = { getItem: k => entries.get(k) ?? null, setItem: (k,v) => entries.set(k,v), removeItem: k => entries.delete(k) };
  assert.equal(storage.bootstrapStorage(local).kind, "migrated");
  const migrated = JSON.parse(local.getItem(storage.STORAGE_KEY));
  assert.equal(Object.hasOwn(migrated, "__proto__"), false);
  assert.deepEqual(file.prepareOpen(file.serializeProject(migrated)).project, migrated);
  assert.equal(storage.bootstrapStorage(local).kind, "ready");
}

// Execute the actual boot -> app model -> runtime installation order when
// the safety migration cannot be written. Disk bytes stay intact, but live
// objects are still migrated and can be exported rather than becoming trapped.
{
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const raw = JSON.stringify(inject(base, "constructor"));
  const entries = new Map([[storage.STORAGE_KEY, raw]]);
  const local = {
    getItem: key => entries.get(key) ?? null,
    setItem: () => { throw new Error("simulated migration write failure"); },
    removeItem: key => entries.delete(key),
  };
  const context = vm.createContext({
    localStorage: local,
    BRKTRKProductionInstrumentDomain: globalThis.BRKTRKProductionInstrumentDomain,
    BRKTRKParameterEventDomain: globalThis.BRKTRKParameterEventDomain,
    console: { warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, addEventListener() {},
    document: { body: { dataset: {} } },
  });
  for (const name of ["project-storage.js", "app-model.js", "project-storage-runtime.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, name), "utf8"), context, { filename: name });
  }
  assert.equal(context.BRKTRKProjectStorageBoot.kind, "migration-write-failed");
  assert.equal(local.getItem(storage.STORAGE_KEY), raw);
  const live = JSON.parse(vm.runInContext("JSON.stringify(model)", context));
  assert.equal(Object.hasOwn(live, "constructor"), false);
  assert.deepEqual(live.compatibilityExtensions[storage.RESERVED_FIELDS_EXTENSION], [{ key: "constructor", value: POISON }]);
  assert.deepEqual(file.prepareOpen(file.serializeProject(live)).project, live);
}

// Collision cannot silently overwrite compatible unknown data. Boot preserves
// the byte-exact source in its verified quarantine before removing active bytes.
{
  const original = inject(base, "constructor");
  original.compatibilityExtensions = { [storage.RESERVED_FIELDS_EXTENSION]: { vendor: "keep exactly" } };
  const raw = JSON.stringify(original);
  const entries = new Map([[storage.STORAGE_KEY, raw]]);
  const local = { getItem: k => entries.get(k) ?? null, setItem: (k,v) => entries.set(k,v), removeItem: k => entries.delete(k) };
  const result = storage.bootstrapStorage(local, { now: 377 });
  assert.equal(result.kind, "recovery");
  assert.equal(local.getItem(result.backupKey), raw);
  assert.equal(local.getItem(storage.STORAGE_KEY), null);
  assert.throws(() => storage.installRuntimeProject(original), /conflicts/);
  assert.equal(JSON.stringify(original), raw, "failed installation is atomic");
}

console.log("HARD-04 reserved structural key boundary tests passed");

