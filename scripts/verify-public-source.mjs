import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const tests = [
  "web/audio-lifecycle-controls-stop.test.cjs",
  "web/audio-lifecycle-failure-reason.test.cjs",
  "web/audio-lifecycle-policy.test.cjs",
  "web/audio-lifecycle-readiness-gate.test.cjs",
  "web/audio-readiness.test.cjs",
  "web/audio-worklet-lifecycle.test.cjs",
  "web/audio-worklet-plan.test.cjs",
  "web/audio-worklet-realtime-window.test.cjs",
  "web/audio-worklet-timeline.test.cjs",
  "web/audio-worklet-timing.test.cjs",
  "web/audio-worklet-trace-parity.test.cjs",
  "web/bootstrap-input-gate.test.cjs",
  "web/brk-synth-abi-v1-deferred-parameter.test.cjs",
  "web/brk-synth-abi-v1-note-velocity.test.cjs",
  "web/brk-synth-abi-v1-worklet.test.cjs",
  "web/brk-synth-prepared-lifecycle-reservation.test.cjs",
  "web/command-dispatcher.test.cjs",
  "web/command-state.test.cjs",
  "web/contextual-sheet-viewport.test.cjs",
  "web/dev-engine-package.test.cjs",
  "web/engine-candidate-cache-key.test.cjs",
  "web/engine-package-browser.test.cjs",
  "web/engine-package-host-compatibility.test.cjs",
  "web/engine-package-semver-order.test.cjs",
  "web/engine-preset-domain.test.cjs",
  "web/engine-registry-exact-package.test.cjs",
  "web/event-plan-compiler.test.cjs",
  "web/event-trace-domain.test.cjs",
  "web/field-schema.test.cjs",
  "web/fx-slot-context-contract.test.cjs",
  "web/g0-live-parameter-authority.test.cjs",
  "web/g0-sound-range-input-authority.test.cjs",
  "web/g1-durable-gesture-finalize.test.cjs",
  "web/g1-gesture-attribution.test.cjs",
  "web/g1-gesture-boundary-exit.test.cjs",
  "web/g1-live-parameter-history.test.cjs",
  "web/g1-open-clean-baseline.test.cjs",
  "web/g1-overlapping-gesture-history.test.cjs",
  "web/g2a-external-file-conflict.test.cjs",
  "web/g2a-project-resource-bounds.test.cjs",
  "web/g2a-save-revision.test.cjs",
  "web/g2b-fresh-reference-command.test.cjs",
  "web/g2b-fresh-reference-identity.test.cjs",
  "web/g2c-browser-writer-authority.test.cjs",
  "web/hierarchy-context-renderer.test.cjs",
  "web/i1-transport-domain.test.cjs",
  "web/input-safety.test.cjs",
  "web/k3c-prepared-transport-adapter.test.cjs",
  "web/keyboard-command-resolver.test.cjs",
  "web/m42b-row-value-preservation.test.cjs",
  "web/m5a-a2-abi-normalization.test.cjs",
  "web/m5a-a2-control-vocabulary.test.cjs",
  "web/m5a-a2-engine-gateway.test.cjs",
  "web/m5a-a2-k4-gateway.test.cjs",
  "web/mix-context-renderer.test.cjs",
  "web/mixer-transport-safety.test.cjs",
  "web/navigation-entry-state.test.cjs",
  "web/note-lifecycle-domain.test.cjs",
  "web/occurrence-context-renderer.test.cjs",
  "web/output-latency-domain.test.cjs",
  "web/p3-contract.test.cjs",
  "web/parameter-event-domain.test.cjs",
  "web/parameter-event-target-domain.test.cjs",
  "web/paste-target-input-router.test.cjs",
  "web/performer-registry-asset.test.cjs",
  "web/phrase-condition-presentation.test.cjs",
  "web/phrase-fx-domain.test.cjs",
  "web/phrase-fx-runtime-domain.test.cjs",
  "web/phrase-fx-surface.test.cjs",
  "web/phrase-row-operations.test.cjs",
  "web/phrase-row-presentation.test.cjs",
  "web/playback-context-policy.test.cjs",
  "web/pointer-workspace-focus.test.cjs",
  "web/prepared-entry-transaction.test.cjs",
  "web/prepared-instrument-application-state.test.cjs",
  "web/prepared-instrument-state-domain.test.cjs",
  "web/prepared-instrument-state-worklet-domain.test.cjs",
  "web/production-audio-processor-extension.test.cjs",
  "web/production-audio-runtime-asset.test.cjs",
  "web/production-audio-runtime-sparse-instrument.test.cjs",
  "web/production-audio-runtime.test.cjs",
  "web/production-engine-bootstrap.test.cjs",
  "web/production-engine-catalog-preflight.test.cjs",
  "web/production-engine-host-add-module-failure-retention.test.cjs",
  "web/production-engine-host-retention.test.cjs",
  "web/production-engine-host-retirement-sync.test.cjs",
  "web/production-engine-host-status.test.cjs",
  "web/production-engine-prepared-state-host-extension.test.cjs",
  "web/production-engine-store-sync-prepared-state.test.cjs",
  "web/production-engine-store-sync.test.cjs",
  "web/production-instrument-domain.test.cjs",
  "web/production-instrument-engine-replace.test.cjs",
  "web/production-instrument-store.test.cjs",
  "web/project-file-operation-state.test.cjs",
  "web/project-file-reserved-keys.test.cjs",
  "web/project-file-session-store.test.cjs",
  "web/project-file-session.test.cjs",
  "web/project-instrument-preset.test.cjs",
  "web/project-phrase-step.test.cjs",
  "web/project-recovery.test.cjs",
  "web/project-schema-v4-unknown-collision.test.cjs",
  "web/project-storage-orphan-recovery.test.cjs",
  "web/project-storage-runtime.test.cjs",
  "web/project-storage.test.cjs",
  "web/project-structure-runtime.test.cjs",
  "web/project-structure.test.cjs",
  "web/project-transport-policy.test.cjs",
  "web/project-user-preset.test.cjs",
  "web/sample-asset-domain.test.cjs",
  "web/sample-asset-host.test.cjs",
  "web/sample-asset-surface.test.cjs",
  "web/selection-clipboard.test.cjs",
  "web/song-playback-gate.test.cjs",
  "web/song-transport-policy.test.cjs",
  "web/sound-edit-renderer.test.cjs",
  "web/sound-edit-targeted-render.test.cjs",
  "web/sound-preset-live-prepared-policy.test.cjs",
  "web/store-subscriber-snapshot.test.cjs",
  "web/stores.test.cjs",
  "web/structural-duplicate-repoint.test.cjs",
  "web/structural-reference-graph.test.cjs",
  "web/structural-row-operations.test.cjs",
  "web/sw-cache-isolation.test.cjs",
  "web/sw-engine-package-cache-gc.test.cjs",
  "web/sw-update-handover-registration-race.test.cjs",
  "web/sw-update-handover.test.cjs",
  "web/synth-gateway-prepared-lifecycle-pair.test.cjs",
  "web/synth-gateway-prepared-lifecycle.test.cjs",
  "web/table-source-domain.test.cjs",
  "web/timing-domain.test.cjs",
  "web/timing-map-domain.test.cjs",
  "web/touch-action-policy.test.cjs",
  "web/track-insert-fx-domain.test.cjs",
  "web/track-insert-fx-store.test.cjs",
  "web/track-mix-domain.test.cjs",
  "web/track-mix-resume-reapply.test.cjs",
  "web/track-mix-worklet.test.cjs",
  "web/transport-runtime-state.test.cjs",
  "web/undo-redo-project-data.test.cjs",
  "web/undo-redo.test.cjs",
  "web/worklet-failure-evidence.test.cjs",
  "web/worklet-global-scope-contract.test.cjs",
  "web/workspace-context-renderer.test.cjs"
];
const fail = (s) => { throw new Error("Public source verification: " + s); };
const read = (p) => readFileSync(p, "utf8");
if (Number(process.versions.node.split(".")[0]) < 22) fail("Node.js 22+ required");
const pkg = JSON.parse(read("package.json"));
if (pkg.license !== "GPL-3.0-only") fail("package license must be GPL-3.0-only");
if (!read("LICENSE").startsWith("GNU GENERAL PUBLIC LICENSE\nVersion 3")) fail("complete GPLv3 LICENSE missing");
if (read("LICENSE") !== read("web/LICENSE.txt")) fail("web LICENSE diverges");
const devEngineSource = read("engines/brk-dev-poly/runtime/brk-dev-poly.js");
if (!devEngineSource.includes('const LICENSE_ID = "GPL-3.0-only";')) fail("development engine still declares proprietary licensing");
for (const p of ["NOTICE.md", "web/NOTICE.txt"]) {
  if (!read(p).includes("MIT License") || !read(p).includes("GPL-3.0-only")) fail("notice missing: " + p);
}
for (const p of [
  "README.md", "CONTRIBUTING.md", "MIGRATION.md", "web/index.html", "web/sw.js",
  "web/manifest.webmanifest", "engines/brk-dev-poly/runtime/brk-dev-poly.js",
  "scripts/build-dev-engine-store.mjs",
  "scripts/public-browser-smoke.sh", "scripts/run-browser-cdp-fixture.mjs",
  "web/public-source-browser-smoke.html",
]) if (!existsSync(p)) fail("missing required file: " + p);
for (const p of [
  "docs/history", "docs/releases", "HANDOFF_PROMPT_FOR_CHATGPT.md",
  ".github/workflows/assistant-ci-control.yml", ".github/workflows/deploy-server.yml",
  "scripts/deploy-server-local.sh",
]) if (existsSync(p)) fail("private history/deployment material found: " + p);
// High-confidence secret tripwires. Manual review remains mandatory.
const sensitiveFile = /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|[^/]+\.(?:pem|p12|pfx|key))$/i;
const secretText = /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b/;
const checked = [];
function scanFiles(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const filename = join(dir, item.name);
    if (sensitiveFile.test(filename)) fail("sensitive filename: " + filename);
    if (item.isDirectory()) scanFiles(filename);
    else if (item.isSymbolicLink()) fail("unexpected symbolic link: " + filename);
    else if (item.isFile()) {
      checked.push(filename);
      if (secretText.test(read(filename))) fail("credential-shaped text found in " + filename);
    }
  }
}
for (const dir of ["web", "engines", "fixtures"]) scanFiles(dir);
const availableTests = readdirSync("web").filter((f) => f.endsWith(".test.cjs"));
if (availableTests.length < 143) fail("public source lost runtime regression files");
const workflows = readdirSync(".github/workflows").filter((name) => name.endsWith(".yml")).sort();
if (JSON.stringify(workflows) !== JSON.stringify(["ci.yml", "pages.yml"])) {
  fail("expected only public CI and Pages workflows");
}
const ci = read(".github/workflows/ci.yml");
if (!ci.includes("runs-on: ubuntu-24.04") || !ci.includes("contents: read")
    || /self-hosted|pull_request_target|id-token:\s*write|myldy-home|myldy-vps|\/srv\/www\/brktrk/.test(ci)) {
  fail("public CI has unsafe host selector/permissions");
}
const pages = read(".github/workflows/pages.yml");
if (!pages.includes("runs-on: ubuntu-24.04") ||
    !pages.includes("permissions:") || !pages.includes("pages: write") ||
    !pages.includes("id-token: write") || !pages.includes("path: dist") || !pages.includes("npm run build:web") || !pages.includes("BRKTRK_WEB_DIR=dist") ||
    !pages.includes("npm run dev:engine") || !pages.includes("npm run test:browser") ||
    !pages.includes("branches: [main]") ||
    /self-hosted|pull_request_target|\/srv\/www|myldy-vps|myldy-home/.test(pages)) {
  fail("Pages publication has unsafe runner, trigger, build or permissions");
}
const assets = [...read("web/sw.js").matchAll(/^\s*"(\.\/[^"]+)"\s*,?\s*$/gm)].map((m) => m[1]);
if (assets.length < 100) fail("service worker asset list unexpectedly short");
if (existsSync("web/fixtures/a5-physical-owner-project.brktrk")) {
  fail("internal owner physical project fixture accidentally included");
}
for (const name of readdirSync("web").filter((f) => f.endsWith("-browser-smoke.html"))) {
  if (name !== "public-source-browser-smoke.html" && !assets.includes("./" + name)) {
    fail("orphan internal browser fixture in public export: " + name);
  }
}
for (const a of assets) {
  if (a !== "./" && !existsSync(join("web", a.slice(2)))) fail("missing PWA asset: " + a);
}
for (const file of tests) {
  if (!existsSync(file)) fail("missing test: " + file);
  const r = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  if (r.status !== 0 || r.error) {
    console.error(r.stdout?.slice(-1800) || "", r.stderr?.slice(-1800) || "");
    fail(file + " failed (" + (r.error?.message || r.status) + ")");
  }
  console.log("PASS " + file);
}
console.log("Public BRKTRK source PASS: " + tests.length + " representative tests");
