import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const wasmDir = process.env.BRKTRK_MODAL_WASM_BUILD_DIR || "build/brk-modal-wasm";
const fixtures = process.env.BRKTRK_MODAL_FIXTURE_DIR || "build/brk-modal-fixtures";
const glue = readFileSync(join(wasmDir, "brk_modal_module.js"), "utf8");
const wasm = readFileSync(join(wasmDir, "brk_modal_module.wasm"));
const state = readFileSync(join(fixtures, "state.bin"));
if (state.length !== 768) throw new Error("Modal fixture must contain exactly 768 state bytes");
const processor = readFileSync("scripts/fixtures/modal-worklet-tail.js", "utf8");
const html = readFileSync("scripts/fixtures/modal-worklet-test.html", "utf8");
const js = glue
  + "\nconst __brkWasmBytes = new Uint8Array(" + JSON.stringify([...wasm]) + ");\n"
  + "const __brkState = new Uint8Array(" + JSON.stringify([...state]) + ");\n"
  + "const __brkModulePromise = Module({wasmBinary: __brkWasmBytes});\n"
  + processor;
const paths = new Map([
  ["/modal-worklet-test.html", ["text/html; charset=utf-8", html]],
  ["/modal-qualification-worklet.js", ["text/javascript; charset=utf-8", js]],
]);
const server = createServer((req, res) => {
  const record = paths.get(String(req.url || "").split("?")[0]);
  if (!record) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": record[0], "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin" });
  res.end(record[1]);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const tmp = mkdtempSync(join(tmpdir(), "brktrk-modal-worklet-"));
let done = false;
try {
  for (let attempt = 1; attempt <= 2 && !done; attempt++) {
    const url = "http://127.0.0.1:" + port + "/modal-worklet-test.html";
    const child = spawn(process.execPath, [
      "scripts/run-browser-cdp-fixture.mjs", url,
      join(tmp, "profile-" + attempt), join(tmp, "chrome-" + attempt + ".stderr"),
    ], { env: { ...process.env, BRKTRK_CDP_DISCOVERY_ATTEMPTS: "250" },
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.on("exit", resolve));
    if (code === 0 && stdout.trim() === "BRKTRK_BROWSER_TESTS_PASSED") {
      console.log("BRK_MODAL_REAL_AUDIO_WORKLET=PASS");
      console.log(stderr.trim().split("\n").filter(line =>
        line.includes("Browser fixture diagnostics")).join("\n"));
      done = true;
      break;
    }
    if (attempt < 2 && /DevToolsActivePort|Chrome exited before the DevTools endpoint/.test(stdout)) {
      console.error("Chrome infrastructure startup failed; retrying with fresh profile");
      continue;
    }
    throw new Error("Modal real AudioWorklet failed:\n" + stdout + "\n" + stderr);
  }
  if (!done) throw new Error("Modal AudioWorklet never passed");
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
}
