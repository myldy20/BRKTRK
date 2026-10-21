(() => {
  "use strict";

  const PREVIEW_TOKEN = "a5.5-c1";
  const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
  const CANDIDATE_PATH_RE = /\/__physical\/([0-9a-f]{40})\/physical-candidate\.html$/;

  function candidateCommitFromLocation(href = globalThis.location?.href ?? "") {
    if (!href) throw new Error("Physical candidate bootstrap requires a browser location");
    const url = new URL(href);
    if (url.searchParams.get("preview") !== PREVIEW_TOKEN) {
      throw new Error(`Physical candidate URL must use preview=${PREVIEW_TOKEN}`);
    }
    const match = url.pathname.match(CANDIDATE_PATH_RE);
    if (!match || !COMMIT_SHA_RE.test(match[1])) {
      throw new Error("Physical candidate must be served from /__physical/<exact-sha>/physical-candidate.html");
    }
    return match[1];
  }

  function verifyDeploymentMetadata(metadata, expectedCommit) {
    if (!COMMIT_SHA_RE.test(expectedCommit)) throw new Error(`Invalid expected candidate commit: ${expectedCommit}`);
    const commit = typeof metadata?.commit === "string" ? metadata.commit : "";
    const identity = typeof metadata?.deploymentIdentity === "string" ? metadata.deploymentIdentity : "";
    if (commit !== expectedCommit || identity !== `physical-candidate:${expectedCommit}`) {
      throw new Error(`Physical candidate deployment identity mismatch for ${expectedCommit}`);
    }
    return Object.freeze({ commit, identity });
  }

  async function boot(options = {}) {
    const href = options.href ?? globalThis.location?.href;
    const expectedCommit = candidateCommitFromLocation(href);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const locationImpl = options.locationImpl ?? globalThis.location;
    if (typeof fetchImpl !== "function" || typeof locationImpl?.replace !== "function") {
      throw new Error("Physical candidate bootstrap requires fetch and location.replace");
    }

    const probe = `./build.json?brktrk-deployment=1&preview=${encodeURIComponent(PREVIEW_TOKEN)}`;
    const response = await fetchImpl(probe, { cache: "no-store" });
    if (!response?.ok) throw new Error(`Could not verify physical candidate deployment: ${response?.status ?? "unknown"}`);
    verifyDeploymentMetadata(await response.json(), expectedCommit);

    locationImpl.replace(`./index.html?preview=${encodeURIComponent(PREVIEW_TOKEN)}`);
    return expectedCommit;
  }

  globalThis.BRKTRKPhysicalCandidate = Object.freeze({
    previewToken: PREVIEW_TOKEN,
    candidateCommitFromLocation,
    verifyDeploymentMetadata,
    boot,
  });

  if (typeof document !== "undefined" && typeof location !== "undefined") {
    void boot().catch((error) => {
      console.error(error);
      document.body.textContent = `BRKTRK PHYSICAL CANDIDATE FAILED · ${error.message}`;
    });
  }
})();