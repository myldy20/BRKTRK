// The owner watched the Sound surface sit on "VERIFYING…" on a phone (#496),
// and #500 established that this container can neither reproduce a phone nor
// host a real production engine package — so the cause could not be measured
// here, only guessed at. These timings exist so the next physical test carries
// the numbers out instead of a guess.
//
// A stage that silently never fires would be worse than no instrumentation at
// all: the report would read "the verify was instant" and send the search in
// the wrong direction. This drives the real transport against the real
// development package and asserts every stage actually reports.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

require("./engine-package-domain.js");
require("./engine-package-loader.js");
require("./engine-package-tar-domain.js");
const browser = require("./engine-package-browser.js");
const packageDomain = globalThis.BRKTRKEnginePackageDomain;

const repoRoot = join(__dirname, "..");
execFileSync(process.execPath, ["scripts/build-dev-engine-store.mjs"], { cwd: repoRoot, stdio: "pipe" });

const catalog = packageDomain.normalizeCatalog(
  JSON.parse(readFileSync(join(repoRoot, "web/engines/catalog-v1.json"), "utf8")),
);
const entry = catalog.entries[0];
const archive = new Uint8Array(readFileSync(join(repoRoot, "web/engines", entry.packageUrl.replace(/^\.\//, ""))));

// The transport pins its trust root to the page's origin, so the fixture has to
// present the package under one.
const root = browser.trustRoot("https://brktrk.myldy.ru/index.html");
const entryAtRoot = Object.freeze({
  ...entry,
  packageUrl: `https://brktrk.myldy.ru/engines/${entry.packageUrl.replace(/^\.\//, "")}`,
});

const fakeResponse = () => ({
  ok: true,
  url: entryAtRoot.packageUrl,
  clone() { return this; },
  async arrayBuffer() { return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength); },
});

const hitCache = { async match() { return fakeResponse(); }, async delete() { return true; } };
const missCache = { async match() { return null; }, async delete() { return true; } };

const collect = () => {
  const stages = [];
  return { stages, onStage: (name, ms) => stages.push([name, ms]) };
};

const names = (stages) => stages.map(([name]) => name);

(async () => {
  // --- the cached path: what a returning load actually does -----------------
  {
    const seen = collect();
    const result = await browser.loadVerifiedEntry(entryAtRoot, {
      root, host: {}, cacheStorage: hitCache, onStage: seen.onStage,
      fetchImpl: () => { throw new Error("a cached archive must not reach the network"); },
    });
    assert.equal(result.source, "verified-cache");
    assert.deepEqual(names(seen.stages), ["cacheLookup", "archiveRead", "verify"],
      "a cached load reports the lookup, the read and the verification, in that order");
    for (const [name, ms] of seen.stages) {
      assert.ok(Number.isFinite(ms) && ms >= 0, `${name} must report a real elapsed time, got ${ms}`);
    }
  }

  // --- the cold path: the network fetch has to be visible separately --------
  // It is the stage most likely to explain a phone on mobile data, and it must
  // not be folded into the verification it precedes.
  {
    const seen = collect();
    const result = await browser.loadVerifiedEntry(entryAtRoot, {
      root, host: {}, cacheStorage: missCache, onStage: seen.onStage,
      fetchImpl: async () => fakeResponse(),
    });
    assert.equal(result.source, "network");
    assert.deepEqual(names(seen.stages), ["cacheLookup", "networkFetch", "archiveRead", "verify"],
      "a cold load reports its network fetch as its own stage");
  }

  // --- observing must never be able to break loading ------------------------
  // The report is a diagnostic. A thrown observer taking the Sound surface down
  // would be a worse bug than the one it was added to find.
  {
    const result = await browser.loadVerifiedEntry(entryAtRoot, {
      root, host: {}, cacheStorage: hitCache,
      onStage: () => { throw new Error("observer exploded"); },
    });
    assert.equal(result.source, "verified-cache", "a throwing observer must not fail the load");
  }

  // --- no observer is the production default until a report is taken --------
  {
    const result = await browser.loadVerifiedEntry(entryAtRoot, { root, host: {}, cacheStorage: hitCache });
    assert.equal(result.source, "verified-cache", "the untimed path must stay exactly as it was");
  }

  // --- a failing load still reports the stage that failed -------------------
  // Timing a load that succeeds is the easy half; a report that goes blank on
  // the failure is the half that matters when something is actually wrong.
  {
    const seen = collect();
    await assert.rejects(
      () => browser.loadVerifiedEntry(entryAtRoot, {
        root, host: {}, cacheStorage: missCache, onStage: seen.onStage,
        fetchImpl: async () => { throw new Error("offline"); },
      }),
      (error) => error?.code === "package-fetch-failed",
    );
    assert.deepEqual(names(seen.stages), ["cacheLookup", "networkFetch"],
      "the stage that threw must still report how long it took before it did");
  }

  console.log("Engine package load timings report every stage, and never break a load");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
