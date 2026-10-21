const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function createPolicy(fetchImpl) {
  const source = fs.readFileSync(require.resolve("./sw.js"), "utf8");
  const listeners = new Map();
  const context = {
    URL,
    Request,
    Response,
    fetch: fetchImpl,
    caches: { open: async () => { throw new Error("unexpected caches.open during policy test"); } },
    self: {
      location: { href: "https://example.test/sw.js" },
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener(type, listener) { listeners.set(type, listener); },
    },
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${source}\n;globalThis.__g7SwPolicy = { cacheKey, trustedEnginePackageUrl, trustedEngineCatalog, engineCatalogPackageUrls, isEnginePackageRequest, ensureCatalogPackagesCached, pruneEnginePackageCache, reconcileEngineStoreCache };`, context);
  return context.__g7SwPolicy;
}

class FakeCache {
  constructor(initial = []) {
    this.map = new Map(initial.map(([key, body]) => [String(key), new Response(body)]));
    this.deleted = [];
    this.puts = [];
  }
  keyOf(value) { return value instanceof Request ? value.url : String(value); }
  async match(value) {
    const response = this.map.get(this.keyOf(value));
    return response ? response.clone() : undefined;
  }
  async put(value, response) {
    const key = this.keyOf(value);
    this.puts.push(key);
    this.map.set(key, response.clone());
  }
  async delete(value) {
    const key = this.keyOf(value);
    this.deleted.push(key);
    return this.map.delete(key);
  }
  async keys() { return [...this.map.keys()].map((key) => new Request(key)); }
}

const trust = { mode: "same-origin-pinned-path-v1", publisher: "myldy-brksynth" };
const entry = (name, sha) => ({
  moduleId: `design.myldy.${name}`,
  engineId: name,
  version: "1.0.0",
  packageUrl: `./packages/${name}-${sha}.tar.gz`,
  packageSha256: sha.repeat(64).slice(0, 64),
});

(async () => {
  const catalog = { format: "brk-engine-catalog-v1", trust, entries: [entry("a", "a"), entry("b", "b")] };
  const staleUrl = "https://example.test/engines/packages/stale-cccc.tar.gz";
  const aUrl = "https://example.test/engines/packages/a-a.tar.gz";
  const bUrl = "https://example.test/engines/packages/b-b.tar.gz";
  const unrelatedUrl = "https://example.test/index.html";
  const fetched = [];
  const policy = createPolicy(async (request) => {
    fetched.push(request.url);
    if (request.url === bUrl) return new Response("package-b", { status: 200 });
    throw new Error(`unexpected network fetch ${request.url}`);
  });
  const cache = new FakeCache([
    [staleUrl, "stale"],
    [aUrl, "package-a"],
    [unrelatedUrl, "shell"],
  ]);

  await policy.reconcileEngineStoreCache(cache, new Response(JSON.stringify(catalog)), "fixture catalog");
  assert.deepEqual(fetched, [bUrl], "catalog reconciliation must fetch only missing exact packages");
  assert.equal(await cache.match(aUrl) instanceof Response, true, "current cached exact package must survive reconciliation");
  assert.equal(await cache.match(bUrl) instanceof Response, true, "new exact package must be durable before catalog commit");
  assert.equal(await cache.match(staleUrl), undefined, "package URL absent from current trusted catalog must be retired");
  assert.equal(await cache.match(unrelatedUrl) instanceof Response, true, "package GC must not delete ordinary release assets");
  const cachedCatalog = await cache.match("https://example.test/engines/catalog-v1.json");
  assert.ok(cachedCatalog, "trusted catalog must be cached after every referenced package is durable");
  assert.equal((await cachedCatalog.json()).entries.length, 2);

  const failingCatalog = { format: "brk-engine-catalog-v1", trust, entries: [entry("a", "a"), entry("d", "d")] };
  const failingPolicy = createPolicy(async (request) => {
    if (request.url.includes("/d-d.tar.gz")) throw new Error("fixture package fetch failed");
    throw new Error(`unexpected network fetch ${request.url}`);
  });
  const beforeCatalog = JSON.stringify(await (await cache.match("https://example.test/engines/catalog-v1.json")).json());
  await assert.rejects(
    () => failingPolicy.reconcileEngineStoreCache(cache, new Response(JSON.stringify(failingCatalog)), "failing fixture catalog"),
    /fixture package fetch failed/,
  );
  const afterCatalog = JSON.stringify(await (await cache.match("https://example.test/engines/catalog-v1.json")).json());
  assert.equal(afterCatalog, beforeCatalog, "catalog must not advance when a newly referenced exact package cannot be made durable");
  assert.equal(await cache.match(bUrl) instanceof Response, true, "failed catalog refresh must not prune the previously coherent offline package set");

  const invalidCatalog = { format: "brk-engine-catalog-v1", trust: { mode: "wrong", publisher: "wrong" }, entries: [] };
  await assert.rejects(
    () => policy.reconcileEngineStoreCache(cache, new Response(JSON.stringify(invalidCatalog)), "invalid fixture catalog"),
    /pinned host trust root/,
    "untrusted catalog must never drive package-cache GC",
  );

  console.log("A5 #349 catalog-bounded Service Worker engine package cache regression passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});