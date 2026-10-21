const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("web/physical-candidate-entrypoint.js", "utf8");
const context = vm.createContext({ console, URL, globalThis: null });
context.globalThis = context;
vm.runInContext(source, context, { filename: "physical-candidate-entrypoint.js" });

const api = context.BRKTRKPhysicalCandidate;
assert.ok(api, "physical candidate bootstrap API must be installed");
assert.equal(api.previewToken, "a5.5-c1");

const candidate = "0123456789abcdef0123456789abcdef01234567";
const base = `https://example.test/__physical/${candidate}/physical-candidate.html?preview=a5.5-c1`;
assert.equal(api.candidateCommitFromLocation(base), candidate);
assert.throws(
  () => api.candidateCommitFromLocation(`https://example.test/physical-candidate.html?preview=a5.5-c1`),
  /must be served from \/__physical\//,
);
assert.throws(
  () => api.candidateCommitFromLocation(`https://example.test/__physical/${candidate}/physical-candidate.html?preview=wrong`),
  /must use preview=a5.5-c1/,
);

assert.deepEqual(
  { ...api.verifyDeploymentMetadata({ commit: candidate, deploymentIdentity: `physical-candidate:${candidate}` }, candidate) },
  { commit: candidate, identity: `physical-candidate:${candidate}` },
);
assert.throws(
  () => api.verifyDeploymentMetadata({ commit: "f".repeat(40), deploymentIdentity: `physical-candidate:${candidate}` }, candidate),
  /identity mismatch/,
);

async function run() {
  let requested = null;
  let requestOptions = null;
  let replacement = null;
  const result = await api.boot({
    href: base,
    locationImpl: { replace(value) { replacement = value; } },
    fetchImpl: async (url, options) => {
      requested = url;
      requestOptions = options;
      return {
        ok: true,
        async json() {
          return { commit: candidate, deploymentIdentity: `physical-candidate:${candidate}` };
        },
      };
    },
  });
  assert.equal(result, candidate);
  assert.equal(requested, "./build.json?brktrk-deployment=1&preview=a5.5-c1");
  assert.deepEqual({ ...requestOptions }, { cache: "no-store" });
  assert.equal(replacement, "./index.html?preview=a5.5-c1");

  await assert.rejects(
    api.boot({
      href: base,
      locationImpl: { replace() { throw new Error("must not redirect on bad metadata"); } },
      fetchImpl: async () => ({
        ok: true,
        async json() { return { commit: "f".repeat(40), deploymentIdentity: `physical-candidate:${candidate}` }; },
      }),
    }),
    /identity mismatch/,
  );

  console.log("Physical candidate entrypoint tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});