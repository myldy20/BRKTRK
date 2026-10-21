const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const source = readFileSync(require.resolve("./song-playback-gate.js"), "utf8");

async function runGate({ scope = "song", installProduction = true } = {}) {
  const calls = [];
  let now = 0;
  const body = { dataset: {} };
  const sandbox = {
    console,
    state: { scope },
    document: { body },
    performance: { now: () => now },
    setStatus: (message, tone) => calls.push({ type: "status", message, tone }),
    window: {
      setTimeout(resolve, delay) {
        now += delay;
        if (installProduction && now >= 16 && !sandbox.BRKTRKTransport) {
          sandbox.BRKTRKTransport = {};
          sandbox.togglePlayback = async (forceSong) => {
            calls.push({ type: "production", forceSong });
            return "production";
          };
        }
        resolve();
      },
    },
    togglePlayback: async (forceSong) => {
      calls.push({ type: "legacy", forceSong });
      return "legacy";
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "song-playback-gate.js" });
  const result = await sandbox.togglePlayback(false);
  return { calls, result, body, sandbox };
}

(async () => {
  const song = await runGate({ scope: "song", installProduction: true });
  assert.equal(song.result, "production");
  assert.equal(song.calls.some((entry) => entry.type === "legacy"), false);
  assert.equal(song.calls.filter((entry) => entry.type === "production").length, 1);
  assert.equal(song.body.dataset.songPlaybackGate, "ready");

  const phrase = await runGate({ scope: "phrase", installProduction: false });
  assert.equal(phrase.result, "legacy");
  assert.equal(phrase.calls.filter((entry) => entry.type === "legacy").length, 1);

  const failed = await runGate({ scope: "song", installProduction: false });
  assert.equal(failed.result, false);
  assert.equal(failed.calls.some((entry) => entry.type === "legacy"), false);
  assert.equal(failed.calls.some((entry) => entry.type === "status" && entry.tone === "danger"), true);
  assert.equal(failed.body.dataset.songPlaybackGate, "failed");

  const index = readFileSync(require.resolve("./index.html"), "utf8");
  assert.match(index, /<script src="\.\/song-playback-gate\.js\?v=[^"]+"><\/script>/);
  assert.ok(index.indexOf("./song-playback-gate.js") > index.indexOf("./p35-context-transport.js"));

  const appModel = readFileSync(require.resolve("./app-model.js"), "utf8");
  assert.ok(appModel.includes("Math.max(1, ...lengths) * PHRASE_ROWS"), "test must continue identifying the retired user-facing padding implementation");
  assert.ok(source.includes("legacySongPlaybackBlocked: true"));
  assert.equal(source.includes("legacyTogglePlayback(forceSong)"), true);
  console.log("Song playback readiness gate tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});