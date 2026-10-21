import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [url, profile, stderrPath] = process.argv.slice(2);
if (!url || !profile || !stderrPath) {
  console.error("Usage: node scripts/run-browser-cdp-fixture.mjs <url> <profile> <stderr-path>");
  process.exit(2);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const discoveryAttempts = positiveIntegerEnv("BRKTRK_CDP_DISCOVERY_ATTEMPTS", 100);
const handshakeAttempts = positiveIntegerEnv("BRKTRK_CDP_HANDSHAKE_ATTEMPTS", 1);
const handshakeTimeoutMs = positiveIntegerEnv("BRKTRK_CDP_HANDSHAKE_TIMEOUT_MS", 5000);
const discoveryFetchTimeoutMs = positiveIntegerEnv("BRKTRK_CDP_DISCOVERY_FETCH_TIMEOUT_MS", 2000);
const commandTimeoutMs = positiveIntegerEnv("BRKTRK_CDP_COMMAND_TIMEOUT_MS", 10000);
const chromeArgs = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--autoplay-policy=no-user-gesture-required",
  "--remote-allow-origins=*",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  url,
];

let browserStderr = "";
let chromeExited = false;
const chrome = spawn("google-chrome", chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.setEncoding("utf8");
chrome.stderr.on("data", (chunk) => { browserStderr += chunk; });
chrome.on("exit", () => { chromeExited = true; });

async function stopChrome(socket) {
  try { socket?.close(); } catch {}
  if (!chromeExited) chrome.kill("SIGTERM");
  for (let attempt = 0; attempt < 10 && !chromeExited; attempt += 1) await delay(100);
  if (!chromeExited) chrome.kill("SIGKILL");
  for (let attempt = 0; attempt < 10 && !chromeExited; attempt += 1) await delay(100);
  writeFileSync(stderrPath, browserStderr, "utf8");
}

function readChromeDebugPort() {
  const raw = readFileSync(`${profile}/DevToolsActivePort`, "utf8");
  const port = Number(raw.split(/\r?\n/, 1)[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid Chrome DevTools port: ${String(port)}`);
  }
  return port;
}

async function findPageTarget() {
  let lastError = null;
  // Most fixtures retain the historical 10s discovery budget. A caller may
  // explicitly widen only this infrastructure phase under its own process
  // guard; fixture-owned assertions keep their existing deadline.
  for (let attempt = 0; attempt < discoveryAttempts; attempt += 1) {
    if (chromeExited) throw new Error("Chrome exited before the DevTools endpoint became available");
    try {
      const debugPort = readChromeDebugPort();
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(discoveryFetchTimeoutMs),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.url === url)
          ?? targets.find((target) => target.type === "page" && target.url.includes("073-audio-lifecycle-browser-smoke.html"))
          ?? targets.find((target) => target.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error("Could not discover the lifecycle fixture page target");
}

async function openCdpSocket(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket.close(); } catch {}
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = () => fail(new Error("Chrome DevTools WebSocket failed"));
    const timeout = setTimeout(
      () => {
        const error = new Error("Timed out connecting to Chrome DevTools");
        error.code = "BRKTRK_CDP_INFRA_TIMEOUT";
        fail(error);
      },
      handshakeTimeoutMs,
    );
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

async function connectCdp(webSocketDebuggerUrl) {
  if (typeof WebSocket !== "function") throw new Error("Node WebSocket support is unavailable");
  let socket = null;
  let lastError = null;
  // A caller may explicitly retry only this infrastructure handshake under
  // its own process guard. Generic fixtures retain the historical one attempt.
  for (let attempt = 1; attempt <= handshakeAttempts; attempt += 1) {
    try {
      socket = await openCdpSocket(webSocketDebuggerUrl);
      break;
    } catch (error) {
      lastError = error;
      if (attempt < handshakeAttempts) await delay(1000);
    }
  }
  if (!socket) throw lastError ?? new Error("Could not connect to Chrome DevTools");

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timeout } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timeout);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        const error = new Error(`Chrome DevTools command timed out: ${method}`);
        error.code = "BRKTRK_CDP_INFRA_TIMEOUT";
        reject(error);
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timeout });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      }
    });
  }

  return { socket, send };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response?.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description
      ?? response.exceptionDetails.exception?.value
      ?? response.exceptionDetails.text
      ?? "Runtime evaluation failed";
    throw new Error(String(description));
  }
  return response?.result?.value;
}

async function trustedPhraseLongPressDiagnostics(cdp) {
  return evaluate(cdp, `(() => {
    const frame = document.querySelector("#app");
    const app = frame?.contentWindow;
    const doc = frame?.contentDocument;
    if (!frame || !app || !doc) return { error: "app-frame-missing" };
    const cell = doc.querySelector('[data-pane="phrase"][data-row="0"][data-col="0"]');
    if (!cell) return { error: "phrase-cell-missing" };
    const frameRect = frame.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const x = frameRect.left + cellRect.left + cellRect.width / 2;
    const y = frameRect.top + cellRect.top + cellRect.height / 2;
    const localX = cellRect.left + cellRect.width / 2;
    const localY = cellRect.top + cellRect.height / 2;
    const innerHit = doc.elementFromPoint(localX, localY);
    return {
      point: { x, y, localX, localY },
      frame: { left: frameRect.left, top: frameRect.top, width: frameRect.width, height: frameRect.height },
      cell: { left: cellRect.left, top: cellRect.top, width: cellRect.width, height: cellRect.height },
      outerHit: document.elementFromPoint(x, y)?.id ?? document.elementFromPoint(x, y)?.tagName ?? null,
      innerHit: {
        tag: innerHit?.tagName ?? null,
        pane: innerHit?.dataset?.pane ?? innerHit?.closest?.('[data-pane]')?.dataset?.pane ?? null,
        row: innerHit?.dataset?.row ?? innerHit?.closest?.('[data-row]')?.dataset?.row ?? null,
        col: innerHit?.dataset?.col ?? innerHit?.closest?.('[data-col]')?.dataset?.col ?? null,
        className: String(innerHit?.className ?? ""),
      },
      workspace: app.state?.p3?.activeWorkspace ?? null,
      pane: app.state?.focus?.pane ?? null,
      selection: app.BRKTRKSelectionClipboard?.getSelection?.() ?? null,
      mediaPhone: app.matchMedia?.("(max-width: 760px)")?.matches ?? null,
      released: app.__m42bTrustedProbe?.released === true,
      events: app.__m42bTrustedProbe?.events ?? [],
    };
  })()`);
}

async function dispatchTrustedPhraseLongPress(cdp) {
  const prepared = await evaluate(cdp, `(() => {
    const frame = document.querySelector("#app");
    const app = frame?.contentWindow;
    const doc = frame?.contentDocument;
    const cell = doc?.querySelector('[data-pane="phrase"][data-row="0"][data-col="0"]');
    if (!frame || !app || !doc || !cell) return null;
    app.__m42bTrustedProbe = { events: [], released: false };
    for (const type of ["pointerdown", "pointerup", "pointercancel", "contextmenu", "click"]) {
      doc.addEventListener(type, (event) => {
        const targetCell = event.target?.closest?.('[data-pane="phrase"][data-row][data-col]');
        if (!targetCell) return;
        app.__m42bTrustedProbe.events.push({
          type,
          trusted: event.isTrusted,
          pointerId: event.pointerId ?? null,
          pointerType: event.pointerType ?? null,
          button: event.button ?? null,
          row: targetCell.dataset.row,
          workspace: app.state?.p3?.activeWorkspace ?? null,
          pane: app.state?.focus?.pane ?? null,
          selection: app.BRKTRKSelectionClipboard?.getSelection?.() ?? null,
        });
      }, true);
    }
    const frameRect = frame.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    return {
      x: frameRect.left + cellRect.left + cellRect.width / 2,
      y: frameRect.top + cellRect.top + cellRect.height / 2,
    };
  })()`);
  if (!prepared || !Number.isFinite(prepared.x) || !Number.isFinite(prepared.y)) {
    throw new Error("trusted long-press target cell was not available");
  }

  const before = await trustedPhraseLongPressDiagnostics(cdp);
  console.error(`M4.2B trusted long-press before: ${JSON.stringify(before)}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: prepared.x, y: prepared.y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: prepared.x, y: prepared.y, button: "left", clickCount: 1,
  });

  // Release as soon as the real product long-press has actually entered
  // selection mode. A fixed hold duration can leave the button physically down
  // after the fixture has already observed `active` and started its own settle
  // timer, allowing later Copy/retarget clicks to race the eventual release.
  let held = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(20);
    held = await trustedPhraseLongPressDiagnostics(cdp);
    if (held?.selection?.active) break;
  }
  console.error(`M4.2B trusted long-press held: ${JSON.stringify(held)}`);
  if (!held?.selection?.active) {
    throw new Error(`trusted production long-press never entered selection mode: ${JSON.stringify({ before, held })}`);
  }

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: prepared.x, y: prepared.y, button: "left", clickCount: 1,
  });
  await delay(80);
  const released = await trustedPhraseLongPressDiagnostics(cdp);
  console.error(`M4.2B trusted long-press released: ${JSON.stringify(released)}`);
  if (!released?.selection?.active) {
    throw new Error(`trusted production long-press routing did not survive release: ${JSON.stringify({ before, held, released })}`);
  }

  await evaluate(cdp, `(() => {
    const app = document.querySelector("#app")?.contentWindow;
    if (!app?.__m42bTrustedProbe) return false;
    app.__m42bTrustedProbe.released = true;
    return true;
  })()`);
}

let cdp = null;
let finalResult = "BRKTRK_BROWSER_TESTS_FAILED: lifecycle CDP runner did not complete";
let exitCode = 1;
try {
  const target = await findPageTarget();
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  if (url.includes('/g2c-browser-writer-authority-browser-smoke.html')) {
    const { checkBrowserWriterAuthority } = await import('./check-browser-writer-authority-cdp.mjs');
    await checkBrowserWriterAuthority({ cdp, connectCdp, evaluate, debugPort: readChromeDebugPort(), url });
  }

  // Assertions and fixture semantics are unchanged; the larger wall-time budget
  // only tolerates shared home-runner scheduling/Chrome startup variance.
  const deadline = Date.now() + 60000;
  let lastObserved = "";
  let trustedLongPressDispatched = false;
  const trustedSoundPhases = new Set();
  while (Date.now() < deadline) {
    if (chromeExited) throw new Error("Chrome exited while the lifecycle fixture was running");
    const observed = await evaluate(cdp, 'document.querySelector("#result")?.textContent ?? "NO_RESULT"');
    if (observed !== lastObserved) {
      console.error(`Lifecycle fixture: ${observed}`);
      lastObserved = observed;
    }
    if (observed === "BRKTRK_BROWSER_TESTS_STAGE: TRUSTED_LONG_PRESS_READY" && !trustedLongPressDispatched) {
      trustedLongPressDispatched = true;
      await dispatchTrustedPhraseLongPress(cdp);
      continue;
    }
    if (url.includes("/m5a-a4a-production-sound-browser-smoke.html")
      && String(observed).startsWith("BRKTRK_BROWSER_TESTS_STAGE: TRUSTED_SOUND_")) {
      const phase = observed === "BRKTRK_BROWSER_TESTS_STAGE: TRUSTED_SOUND_KNOB_READY"
        ? "mouse" : observed === "BRKTRK_BROWSER_TESTS_STAGE: TRUSTED_SOUND_TOUCH_READY"
        ? "touch" : null;
      if (phase && !trustedSoundPhases.has(phase)) {
        trustedSoundPhases.add(phase);
        const { checkTrustedSoundKnob } = await import("./check-sound-knob-cdp.mjs");
        await checkTrustedSoundKnob({ cdp, evaluate, phase });
        continue;
      }
    }
    if (observed === "BRKTRK_BROWSER_TESTS_PASSED") {
      const diagnostics = await evaluate(cdp, 'document.querySelector("#result")?.dataset?.diagnostics ?? ""');
      if (diagnostics) console.error(`Browser fixture diagnostics: ${diagnostics}`);
      finalResult = observed;
      exitCode = 0;
      break;
    }
    if (String(observed).startsWith("BRKTRK_BROWSER_TESTS_FAILED:")) {
      finalResult = observed;
      break;
    }
    if (String(observed).startsWith("FAILED:")) {
      finalResult = `BRKTRK_BROWSER_TESTS_FAILED: ${observed}`;
      break;
    }
    await delay(100);
  }
  if (exitCode !== 0 && !finalResult.startsWith("BRKTRK_BROWSER_TESTS_FAILED:")) {
    finalResult = `BRKTRK_BROWSER_TESTS_FAILED: real-time lifecycle fixture timeout at ${finalResult}`;
  }
} catch (error) {
  finalResult = `BRKTRK_BROWSER_TESTS_FAILED: ${error instanceof Error ? error.message : String(error)}`;
  if (error?.code === "BRKTRK_CDP_INFRA_TIMEOUT") exitCode = 75;
} finally {
  await stopChrome(cdp?.socket);
}

console.log(finalResult);
process.exit(exitCode);
