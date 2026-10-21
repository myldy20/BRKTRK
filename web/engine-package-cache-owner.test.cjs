const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
require("./engine-package-domain.js");
require("./engine-package-loader.js");
require("./engine-package-tar-domain.js");
const browser = require("./engine-package-browser.js");

async function main() {
  assert.equal(browser.LEGACY_CACHE_NAME, "brktrk-engine-packages-v1");

  const deletedNamespaces = [];
  const storage = {
    async delete(name) { deletedNamespaces.push(name); return true; },
    async keys() { return ["brktrk-web-v0.8.55", "unrelated-cache"]; },
    async open() { throw new Error("retiring the legacy namespace must not open a cache"); },
    async match() { return null; },
  };

  assert.equal(await browser.retireLegacyPackageCache(storage), true);
  assert.equal(await browser.retireLegacyPackageCache(storage), true);
  assert.deepEqual(deletedNamespaces, [browser.LEGACY_CACHE_NAME],
    "legacy duplicate archive namespace must be retired once per CacheStorage owner");

  const source = readFileSync(require.resolve("./engine-package-browser.js"), "utf8");
  assert.ok(source.includes("cacheStorage.match(packageUrl.href)"),
    "offline package reverify must read the exact package URL from the existing release/candidate cache");
  assert.ok(!source.includes("__cache__/"),
    "package transport must not invent a second exact-SHA archive keyspace");
  assert.ok(!source.includes("cache.put("),
    "package transport must never persist another copy of engine archive bytes");
  assert.ok(!source.includes("cacheStorage.open(LEGACY_CACHE_NAME)"),
    "legacy package cache may be deleted but must never be reopened as an archive owner");

  console.log("A5 #349 single-owner persistent engine archive cache regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
