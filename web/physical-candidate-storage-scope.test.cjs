const assert = require("node:assert/strict");
const storageScope = require("./physical-candidate-storage-scope.js");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  key(index) { return [...this.map.keys()][Number(index)] ?? null; }
  clear() { this.map.clear(); }
}

function fakeDocument() {
  const attributes = new Map([["href", "./manifest.webmanifest?v=0.9.0"]]);
  const manifest = {
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
  const htmlAttributes = new Map();
  return {
    manifest,
    querySelector(selector) { return selector === 'link[rel="manifest"]' ? manifest : null; },
    documentElement: {
      setAttribute(name, value) { htmlAttributes.set(name, String(value)); },
      getAttribute(name) { return htmlAttributes.get(name) ?? null; },
    },
  };
}

assert.equal(storageScope.candidateCommit("/"), null);
assert.equal(storageScope.candidateCommit(`/__physical/${COMMIT}/index.html`), COMMIT);
assert.equal(storageScope.namespacePrefix(COMMIT, "local"), `__brktrk_physical__:${COMMIT}:local:`);
assert.throws(() => storageScope.namespacePrefix("bad", "local"), /Invalid physical candidate storage commit/);

const localStorage = new FakeStorage();
const sessionStorage = new FakeStorage();
localStorage.setItem("brktrk-web-v2-alpha-1", "accepted-project");
sessionStorage.setItem("accepted-session", "accepted-session-value");
const document = fakeDocument();
const root = {
  location: { pathname: `/__physical/${COMMIT}/index.html` },
  Storage: FakeStorage,
  localStorage,
  sessionStorage,
  document,
};

const installed = storageScope.installStorageNamespace(root);
assert.equal(installed.active, true);
assert.equal(installed.commit, COMMIT);
assert.equal(document.manifest.getAttribute("href"), `./physical-candidate.webmanifest?preview=a5.5-c1&candidate=${COMMIT}`);
assert.equal(document.documentElement.getAttribute("data-physical-candidate"), COMMIT);

// Accepted same-origin values must become invisible through the candidate Storage API.
assert.equal(localStorage.getItem("brktrk-web-v2-alpha-1"), null);
assert.equal(sessionStorage.getItem("accepted-session"), null);

localStorage.setItem("brktrk-web-v2-alpha-1", "candidate-project");
sessionStorage.setItem("runtime", "candidate-session");
assert.equal(localStorage.getItem("brktrk-web-v2-alpha-1"), "candidate-project");
assert.equal(sessionStorage.getItem("runtime"), "candidate-session");
assert.equal(localStorage.map.get(`__brktrk_physical__:${COMMIT}:local:brktrk-web-v2-alpha-1`), "candidate-project");
assert.equal(sessionStorage.map.get(`__brktrk_physical__:${COMMIT}:session:runtime`), "candidate-session");
assert.equal(localStorage.map.get("brktrk-web-v2-alpha-1"), "accepted-project");
assert.equal(sessionStorage.map.get("accepted-session"), "accepted-session-value");

assert.equal(localStorage.key(0), "brktrk-web-v2-alpha-1");
localStorage.clear();
assert.equal(localStorage.getItem("brktrk-web-v2-alpha-1"), null);
assert.equal(localStorage.map.get("brktrk-web-v2-alpha-1"), "accepted-project", "candidate clear must preserve accepted storage");

// A non-candidate browsing context remains unscoped.
class RootStorage extends FakeStorage {}
const acceptedLocal = new RootStorage();
const acceptedSession = new RootStorage();
acceptedLocal.setItem("shared", "release");
const accepted = storageScope.installStorageNamespace({
  location: { pathname: "/index.html" },
  Storage: RootStorage,
  localStorage: acceptedLocal,
  sessionStorage: acceptedSession,
  document: fakeDocument(),
});
assert.deepEqual(accepted, { active: false, commit: null });
assert.equal(acceptedLocal.getItem("shared"), "release");

console.log("A5.5 exact-SHA candidate Web Storage + manifest isolation checks passed");
