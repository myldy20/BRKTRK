const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("web/sw.js", "utf8");
const candidate = "0123456789abcdef0123456789abcdef01234567";

function createWorker(scriptUrl, initialCacheKeys = []) {
  const listeners = new Map();
  const openedCaches = [];
  const matchedKeys = [];
  const deletedCaches = [];
  let globalMatchCalled = false;
  let clientsClaimed = false;

  class FakeRequest {
    constructor(input, options = {}) {
      if (input instanceof FakeRequest) {
        this.url = input.url;
        this.method = input.method;
        this.mode = input.mode;
      } else {
        this.url = new URL(String(input), scriptUrl).href;
        this.method = "GET";
        this.mode = options.mode ?? "cors";
      }
      this.cache = options.cache ?? "default";
    }
  }

  const localCache = {
    async put() {},
    async match(key) {
      matchedKeys.push(String(key));
      return { cached: true, key: String(key) };
    },
  };

  const caches = {
    async open(name) {
      openedCaches.push(name);
      return localCache;
    },
    async keys() { return [...initialCacheKeys]; },
    async delete(name) {
      deletedCaches.push(name);
      return true;
    },
    async match() {
      globalMatchCalled = true;
      throw new Error("global caches.match must not be used");
    },
  };

  const self = {
    location: {
      href: scriptUrl,
      origin: new URL(scriptUrl).origin,
    },
    clients: {
      async claim() { clientsClaimed = true; },
      async matchAll() { return []; },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    skipWaiting() {},
  };

  const context = vm.createContext({
    console,
    URL,
    Error,
    Promise,
    Request: FakeRequest,
    fetch: async () => { throw new TypeError("offline"); },
    caches,
    self,
  });
  vm.runInContext(source, context, { filename: "sw.js" });

  return {
    listeners,
    openedCaches,
    matchedKeys,
    deletedCaches,
    get globalMatchCalled() { return globalMatchCalled; },
    get clientsClaimed() { return clientsClaimed; },
    FakeRequest,
  };
}

async function exerciseFetch(worker, requestUrl) {
  let responsePromise = null;
  const request = new worker.FakeRequest(requestUrl, { mode: "cors" });
  worker.listeners.get("fetch")({
    request,
    respondWith(value) { responsePromise = Promise.resolve(value); },
  });
  assert.ok(responsePromise, "fetch handler must provide a response promise");
  return responsePromise;
}

async function exerciseActivate(worker) {
  let activationPromise = null;
  worker.listeners.get("activate")({
    waitUntil(value) { activationPromise = Promise.resolve(value); },
  });
  assert.ok(activationPromise, "activate handler must register lifecycle work");
  await activationPromise;
}

function readReleaseInfo(worker) {
  let payload = null;
  worker.listeners.get("message")({
    data: { type: "brktrk-release-info-request" },
    ports: [{ postMessage(value) { payload = value; } }],
  });
  return payload;
}

async function run() {
  const releaseWorker = createWorker("https://example.test/sw.js?v=0.9.0");
  const releaseInfo = readReleaseInfo(releaseWorker);
  assert.equal(releaseInfo.release, "0.9.0");
  assert.equal(releaseInfo.cache, "brktrk-web-v0.9.0");
  assert.equal(releaseInfo.deploymentMode, "release");
  assert.equal(releaseInfo.candidate, null);

  await exerciseFetch(releaseWorker, "https://example.test/styles.css?v=0.9.0");
  assert.equal(releaseWorker.openedCaches.at(-1), "brktrk-web-v0.9.0");
  assert.equal(
    releaseWorker.matchedKeys.at(-1),
    "https://example.test/styles.css",
    "release runtime ?v requests must collapse to the canonical install-time cache identity",
  );
  assert.equal(releaseWorker.globalMatchCalled, false, "release fallback must be cache-local");

  await exerciseFetch(releaseWorker, "https://cdn.example.invalid/styles.css?v=0.9.0");
  assert.equal(
    releaseWorker.matchedKeys.at(-1),
    "https://cdn.example.invalid/styles.css?v=0.9.0",
    "release cache-key normalization must not rewrite out-of-scope origins",
  );

  const releaseActivation = createWorker("https://example.test/sw.js?v=0.9.0", [
    "brktrk-web-v0.9.0",
    "brktrk-web-v0.8.54",
    "brktrk-web-preview-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "brktrk-engine-packages-v1",
    "unrelated-origin-cache-owner",
  ]);
  await exerciseActivate(releaseActivation);
  assert.deepEqual(
    [...releaseActivation.deletedCaches].sort(),
    [
      "brktrk-engine-packages-v1",
      "brktrk-web-preview-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "brktrk-web-v0.8.54",
    ].sort(),
    "root release activation must retire stale BRKTRK release/preview caches and the former page-owned engine archive namespace",
  );
  assert.equal(releaseActivation.deletedCaches.includes("brktrk-web-v0.9.0"), false, "release activation must preserve its current coherent cache");
  assert.equal(releaseActivation.deletedCaches.includes("unrelated-origin-cache-owner"), false, "release activation must not delete unrelated CacheStorage namespaces");
  assert.equal(releaseActivation.clientsClaimed, true, "release activation must still claim approved clients after cache retirement");

  const candidateBase = `https://example.test/__physical/${candidate}/`;

  // A root release worker has a broad origin scope, but the candidate is a
  // separate immutable build. On a network error it must not respond to a
  // candidate navigation using cached root index.html, producing a mixed
  // pre-v5 HTML / schema-v5 JS bootstrap and a missing ParameterEvent domain.
  for (const candidatePath of [
    `${candidateBase}physical-candidate.html?preview=a5.5-c1`,
    `${candidateBase}index.html?preview=a5.5-c1`,
    `${candidateBase}parameter-event-domain.js?v=0.9.0`,
  ]) {
    let rootIntercepted = false;
    releaseWorker.listeners.get("fetch")({
      request: new releaseWorker.FakeRequest(candidatePath, { mode: "navigate" }),
      respondWith() { rootIntercepted = true; },
    });
    assert.equal(rootIntercepted, false, "root Service Worker must not intercept physical-candidate URLs: " + candidatePath);
  }
  // Do not disable the true root release's offline shell fallback.
  const rootOffline = createWorker("https://example.test/sw.js?v=0.9.0");
  await exerciseFetch(rootOffline, "https://example.test/index.html?v=0.9.0");
  assert.equal(rootOffline.matchedKeys.at(-1), "https://example.test/index.html");

  const candidateWorker = createWorker(`${candidateBase}sw.js?v=0.9.0`);
  const candidateInfo = readReleaseInfo(candidateWorker);
  assert.equal(candidateInfo.release, "0.9.0");
  assert.equal(candidateInfo.cache, `brktrk-web-preview-${candidate}`);
  assert.equal(candidateInfo.deploymentMode, "physical-candidate");
  assert.equal(candidateInfo.candidate, candidate);

  await exerciseFetch(candidateWorker, `${candidateBase}styles.css?v=0.9.0`);
  assert.equal(candidateWorker.openedCaches.at(-1), `brktrk-web-preview-${candidate}`);
  const candidateKey = new URL(candidateWorker.matchedKeys.at(-1));
  assert.equal(candidateKey.pathname, `/__physical/${candidate}/styles.css`);
  assert.equal(candidateKey.searchParams.get("v"), null, "candidate cache identity must normalize inherited release version queries");
  assert.equal(candidateKey.searchParams.get("preview"), "a5.5-c1");
  assert.equal(candidateKey.searchParams.get("__brktrk_preview"), candidate);

  const unversionedCandidateKey = new URL(candidateWorker.matchedKeys.at(-1));
  unversionedCandidateKey.searchParams.delete("preview");
  unversionedCandidateKey.searchParams.delete("__brktrk_preview");
  assert.equal(unversionedCandidateKey.href, `${candidateBase}styles.css`, "versioned runtime request must collapse to the install-time asset identity before preview identity is applied");

  await exerciseFetch(candidateWorker, "https://example.test/styles.css?v=0.9.0");
  assert.equal(
    candidateWorker.matchedKeys.at(-1),
    "https://example.test/styles.css?v=0.9.0",
    "candidate worker must not rewrite same-origin requests outside its exact-SHA scope",
  );
  assert.equal(candidateWorker.globalMatchCalled, false, "candidate fallback must never search other cache namespaces");

  const candidateActivation = createWorker(`${candidateBase}sw.js?v=0.9.0`, [
    `brktrk-web-preview-${candidate}`,
    "brktrk-web-preview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "brktrk-web-v0.9.0",
    "brktrk-engine-packages-v1",
    "unrelated-origin-cache-owner",
  ]);
  await exerciseActivate(candidateActivation);
  assert.deepEqual(
    candidateActivation.deletedCaches,
    ["brktrk-web-preview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    "candidate activation may retire stale candidate caches but must not delete origin-wide root release or legacy engine namespaces",
  );
  assert.equal(candidateActivation.clientsClaimed, true, "candidate activation must still claim its own approved clients");

  const almostCandidate = createWorker(`https://example.test/__physical/not-a-sha/sw.js?v=0.9.0`);
  assert.equal(readReleaseInfo(almostCandidate).deploymentMode, "release", "only an exact-SHA path may activate physical candidate mode");

  console.log("Service Worker release/candidate path/version/cache-isolation tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});