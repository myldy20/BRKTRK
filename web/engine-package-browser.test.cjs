const assert = require("node:assert/strict");
require("./engine-package-domain.js");
require("./engine-package-loader.js");
const tar = require("./engine-package-tar-domain.js");
const browser = require("./engine-package-browser.js");

function tarHeader(name, size, type = "0") {
  const header = Buffer.alloc(512, 0);
  Buffer.from(name).copy(header, 0, 0, 100);
  Buffer.from("0000644\0").copy(header, 100);
  Buffer.from("0000000\0").copy(header, 108);
  Buffer.from("0000000\0").copy(header, 116);
  Buffer.from(size.toString(8).padStart(11, "0") + "\0").copy(header, 124);
  Buffer.from("00000000000\0").copy(header, 136);
  Buffer.from("        ").copy(header, 148);
  header[156] = type.charCodeAt(0);
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
  return header;
}

function tarArchive(files) {
  const chunks = [];
  for (const [name, value] of files) {
    const data = Buffer.from(value);
    chunks.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

const manifest = JSON.stringify({ schema: "brk-engine-package-v1", moduleId: "fixture.module", engineId: "fixture", version: "1.0.0" });
const archive = tarArchive([
  ["fixture-1.0.0/brk-package.json", manifest],
  ["fixture-1.0.0/runtime/module.js", "export default 1;"],
]);
const parsed = tar.parseTar(archive);
assert.equal(parsed.root, "fixture-1.0.0");
assert.equal(parsed.manifest.engineId, "fixture");
assert.equal(Buffer.from(parsed.files["runtime/module.js"]).toString(), "export default 1;");
assert.throws(() => tar.parseTar(tarArchive([["fixture/../evil", "x"], ["fixture/brk-package.json", manifest]])), /unsafe tar path/);

const root = browser.trustRoot("https://brktrk.myldy.ru/index.html");
assert.deepEqual(root, { origin: "https://brktrk.myldy.ru", pathPrefix: "/engines/" });
assert.equal(browser.assertTrustedUrl("https://brktrk.myldy.ru/engines/packages/pkg.tar.gz", root, { packageOnly: true }).pathname, "/engines/packages/pkg.tar.gz");
assert.throws(() => browser.assertTrustedUrl("https://evil.example/engines/packages/pkg.tar.gz", root, { packageOnly: true }), /escaped pinned trust root/);
assert.throws(() => browser.assertTrustedUrl("https://brktrk.myldy.ru/not-engines/pkg.tar.gz", root), /escaped pinned trust root/);

const trusted = {
  format: "brk-engine-catalog-v1",
  trust: { mode: browser.TRUST_MODE, publisher: browser.TRUST_PUBLISHER },
  entries: [],
};
assert.equal(browser.validateCatalogTrust(trusted, "https://brktrk.myldy.ru/engines/catalog-v1.json", root).entries.length, 0);
assert.throws(
  () => browser.validateCatalogTrust({ ...trusted, trust: { mode: "hash-only", publisher: browser.TRUST_PUBLISHER } }, "https://brktrk.myldy.ru/engines/catalog-v1.json", root),
  (error) => error?.code === "untrusted-catalog",
  "catalog trust failure must expose the stable untrusted-catalog error code",
);

console.log("M5A A3 browser package trust / bounded tar checks passed");
