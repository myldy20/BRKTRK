// Prove that the real verified Modal package registers in the actual BRKTRK
// AudioWorklet, not merely in a standalone test-only audio processor.
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, relative, extname } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("../web/engine-package-domain.js");
require("../web/engine-package-loader.js");
require("../web/engine-package-tar-domain.js");
require("../web/engine-package-browser.js");
require("../web/production-engine-host.js");
require("../web/engine-preset-domain.js");

const dir = resolve(process.argv[2] || "build/brk-modal-candidate/output");
const entry = JSON.parse(readFileSync(join(dir, "candidate-entry.json"), "utf8"));
const archive = new Uint8Array(readFileSync(join(dir, entry.packageUrl.replace(/^\.\//, ""))));
const parsed = globalThis.BRKTRKEnginePackageTarDomain.parseTar(gunzipSync(archive));
const loaded = await globalThis.BRKTRKEnginePackageLoader.createPackageLoader({
  readPackage: async () => ({ packageBytes: archive, manifest: parsed.manifest, files: parsed.files }),
}).load(entry);
const library = globalThis.BRKTRKEnginePresetDomain.createLibrary(loaded);
if (library?.presets?.length !== 34 || library.presets.some(p => !p.applicable)) {
  throw Error("production archive has incomplete 34-preset bank");
}
if (loaded.manifest.parameters.length !== 89) throw Error("production archive parameter count is not 89");
const moduleSource = globalThis.BRKTRKProductionEngineHost.buildWorkletModuleSource(loaded);
if (!moduleSource.includes("registerModuleRuntime")) throw Error("not production engine module source");

const expected = JSON.stringify({
  moduleId: entry.moduleId, engineId: entry.engineId,
  version: entry.version, sha: entry.packageSha256,
});
const html = readFileSync("scripts/fixtures/modal-production-worklet.html", "utf8")
  .replace("__EXPECTED__", expected);
const root = resolve("web");
const diagnosticSource = 'registerProcessor("brktrk-modal-probe",class extends AudioWorkletProcessor{constructor(){super();this.port.onmessage=()=>{const r=globalThis.BRKTRKBrkSynthAbiV1Runtime;this.port.postMessage({before:globalThis.__modalBefore||false,after:globalThis.__modalAfter||false,records:r?.runtimeRecords?.().map(x=>({engineId:x.entry?.engineId,version:x.entry?.version,descriptors:x.abiDescriptors?.parameters?.length})),failures:r?.registrationFailures?.()})}}process(){return true}});';
const serve = new Map([
  ["/index.html", ["text/html; charset=utf-8", html]],
  ["/modal-production-package.js", ["text/javascript; charset=utf-8", ["globalThis.__modalBefore=true;", moduleSource, "globalThis.__modalAfter=true;"].join("\n")]],
  ["/modal-probe.js", ["text/javascript; charset=utf-8", diagnosticSource]],
]);
const server = createServer((req, res) => {
  const path = String(req.url || "").split("?")[0];
  let payload = serve.get(path);
  if (!payload && path.startsWith("/web/")) {
    const target = resolve(root, path.slice(5));
    const check = relative(root, target);
    if (check && !check.startsWith("..") && !check.startsWith("/")) {
      try {
        payload = [extname(target) === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream",
          readFileSync(target)];
      } catch { /* return 404 */ }
    }
  }
  res.writeHead(payload ? 200 : 404, {
    "Content-Type": payload?.[0] ?? "text/plain",
    "Cache-Control": "no-store",
  });
  res.end(payload?.[1] ?? "not found");
});
await new Promise((ok, fail) => {
  server.once("error", fail);
  server.listen(0, "127.0.0.1", ok);
});
const temp = mkdtempSync(join(tmpdir(), "modal-production-worklet-"));
try {
  let passed = false;
  for (let i = 1; i <= 2 && !passed; i++) {
    const child = spawn(process.execPath, [
      "scripts/run-browser-cdp-fixture.mjs",
      "http://127.0.0.1:" + server.address().port + "/index.html",
      join(temp, "profile-" + i), join(temp, "chrome-" + i + ".stderr"),
    ], {
      env: { ...process.env, BRKTRK_CDP_DISCOVERY_ATTEMPTS: "250" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", part => stdout += part);
    child.stderr.setEncoding("utf8").on("data", part => stderr += part);
    const status = await new Promise(ok => child.once("exit", ok));
    if (status === 0 && stdout.trim() === "BRKTRK_BROWSER_TESTS_PASSED") {
      console.log("BRK_MODAL_VERIFIED_PRODUCTION_WORKLET=PASS");
      console.log(stderr.split("\n").filter(line => line.includes("Browser fixture diagnostics")).join("\n"));
      passed = true;
      break;
    }
    if (i === 1 && /DevToolsActivePort|Chrome exited before the DevTools endpoint/.test(stdout)) {
      console.error("Chromium bootstrap failed; retrying isolated profile");
      continue;
    }
    throw Error("Actual BRKTRK Worklet failed:\n" + stdout + "\n" + stderr);
  }
  if (!passed) throw Error("real production Worklet failed to register Modal");
} finally {
  await new Promise(ok => server.close(ok));
  rmSync(temp, { recursive: true, force: true });
}
