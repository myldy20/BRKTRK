const assert = require("node:assert/strict");
const fs = require("node:fs");
require("./engine-package-domain.js");
require("./engine-package-loader.js");
require("./engine-package-tar-domain.js");
const browser = require("./engine-package-browser.js");

const sha = "a".repeat(40);
const base = `https://brktrk.myldy.ru/__physical/${sha}/index.html?preview=a5.5-c1`;
const url = new URL(`https://brktrk.myldy.ru/__physical/${sha}/engines/packages/bundle-abc.tar.gz?v=0.9.0`);
const exact = browser.candidatePackageCacheKey(url);
const candidateCache = `brktrk-web-preview-${sha}`;
assert.equal(exact, `https://brktrk.myldy.ru/__physical/${sha}/engines/packages/bundle-abc.tar.gz?preview=a5.5-c1&__brktrk_preview=${sha}`);
assert.equal(browser.candidatePackageCacheKey(new URL("https://brktrk.myldy.ru/engines/packages/foo.tar.gz")),null,
  "accepted root package URL must preserve ordinary release cache identity");
assert.equal(browser.candidatePackageCacheKey(new URL(`https://brktrk.myldy.ru/__physical/not-a-commit/engines/packages/foo.tar.gz`)),null,
  "only exact candidate SHA paths can use the candidate cache key");
const sw = fs.readFileSync(require.resolve("./sw.js"),"utf8");
assert.match(sw,/const PREVIEW_KEY_PARAM = "__brktrk_preview"/);
assert.match(sw,/const PREVIEW_TOKEN = "a5\.5-c1"/);
assert.match(sw,/url\.searchParams\.delete\("v"\)/);

const map = new Map([[exact,new Response("pinned archive bytes")]]);
const lookups=[],deleted=[],storesDeleted=[];
const storage = {
  async match(key) {
    lookups.push(String(key));
    return map.get(String(key))?.clone() ?? null;
  },
  async keys(){return [candidateCache,"brktrk-web-v0.9.0"];},
  async open(name){
    return { async delete(key) {
      deleted.push([name,String(key)]);
      return map.delete(String(key));
    } };
  },
  async delete(name) { storesDeleted.push(name); return true; }
};
(async()=>{
  const cached=await browser.cachedPackageResponse(storage,url);
  assert.ok(cached && await cached.text()==="pinned archive bytes","candidate must resolve its existing SW cache archive on first lookup");
  assert.equal(lookups[0],exact,"candidate must look for SW's canonical preview key before triggering a network fetch");
  assert.equal(lookups.length,1,"SW preview key hit must not probe bare or alternate keyspace");
  const rootUrl=new URL("https://brktrk.myldy.ru/engines/packages/bundle.tar.gz");
  await browser.cachedPackageResponse(storage,rootUrl);
  assert.equal(lookups.at(-1),rootUrl.href,"root release continues to use the exact bare URL");

  // A wrong-hash cached package must be rejected and removed from the actual
  // candidate SW key, then invoke the network path. No trusted metadata is
  // accepted or used to execute a module before the sha check.
  const entry={
    moduleId:"design.myldy.cache-test", engineId:"cache-test",version:"1.0.0",
    channel:"stable",hostContract:{id:"brk-synth-host-v1",minVersion:1,maxVersion:1},
    abiVersion:"0x00010000",stateSchemaVersion:65536,parameterSchemaVersion:1,
    packageUrl:url.href,packageSha256:"b".repeat(64),status:"active"
  };
  let networkRequests=0;
  await assert.rejects(
    browser.loadVerifiedEntry(entry,{
      root:browser.trustRoot(base),
      cacheStorage:storage,
      fetchImpl:async()=>{networkRequests++;throw new Error("network deliberately unavailable");},
    }),/package fetch failed/,
  );
  assert.equal(networkRequests,1,"corrupt cache must retry network once, never trust unverified bytes");
  assert.equal(map.has(exact),false,"corrupt physical candidate key must be evicted, not left to poison subsequent loads");
  assert.ok(deleted.some(([name,key])=>name===candidateCache&&key===exact),
    "candidate's real normalized SW cache key must be the eviction target");
  assert.deepEqual(storesDeleted, [browser.LEGACY_CACHE_NAME], "never delete the active single-owner candidate cache");
  console.log("Physical candidate SW package cache parity, fast hit and corrupt eviction PASS");
})().catch(error=>{console.error(error);process.exitCode=1});
