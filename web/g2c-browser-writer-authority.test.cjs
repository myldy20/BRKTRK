const assert = require('node:assert/strict');
const { createBrowserWriterAuthority, physicalCandidateShellMismatch, install, LOCK_NAME } = require('./browser-writer-authority.js');

// Each client has its own agent lifetime, just as separate windows do. A
// pending callback keeps the lock; killing its agent releases it externally.
function lockService() {
  let owner = null;
  const requests = [];
  function client(id) {
    return {
      request(name, options, callback) {
        assert.equal(name, LOCK_NAME);
        assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
        requests.push(id);
        return Promise.resolve().then(() => {
          if (owner) return callback(null);
          owner = id;
          return Promise.resolve(callback({ name, mode: 'exclusive' })).finally(() => {
            if (owner === id) owner = null;
          });
        });
      },
    };
  }
  return { client, terminate(id) { if (owner === id) owner = null; }, requests };
}

(async () => {
  const service = lockService();
  const first = createBrowserWriterAuthority({ locks: service.client('first'), ownerId: 'first' });
  const second = createBrowserWriterAuthority({ locks: service.client('second'), ownerId: 'second' });
  const results = await Promise.all([first.acquire(), second.acquire(), second.acquire()]);
  assert.deepEqual(results, [true, false, false], 'simultaneous startup has one writer');
  assert.deepEqual(service.requests, ['first', 'second'], 'repeat clicks share one acquisition');
  assert.equal(first.snapshot().mode, 'writer');
  assert.equal(second.snapshot().mode, 'blocked');
  assert.equal(first.snapshot().ownerId, 'first');
  assert.equal(second.canWrite(), false);
  let journal = 'dirty revision';
  assert.throws(() => second.withAuthorizedWrite(() => { journal = null; }), { code: 'BRKTRK_WRITER_BLOCKED' });
  assert.equal(journal, 'dirty revision', 'a clean blocked context cannot delete a foreign journal');
  const storage = require('./project-storage.js');
  const recovery = require('./project-recovery.js');
  const records = new Map([[storage.STORAGE_KEY, '{invalid'], [recovery.JOURNAL_KEY, '{foreign-invalid']]);
  let writes = 0;
  const local = {
    getItem: key => records.get(key) ?? null,
    setItem(key, value) { writes += 1; records.set(key, value); },
    removeItem(key) { writes += 1; records.delete(key); },
  };
  globalThis.BRKTRKBrowserWriterAuthority = second;
  assert.throws(() => storage.writeCanonical(local, {}), { code: 'BRKTRK_WRITER_BLOCKED' });
  assert.equal(storage.bootstrapStorage(local).kind, 'blocked');
  assert.equal(records.get(storage.STORAGE_KEY), '{invalid', 'blocked migration must not quarantine or erase the owner copy');
  let persistenceListener;
  let cleanListener;
  const controller = recovery.createController({ BRKTRKBrowserWriterAuthority: second }, {
    localStorage: local,
    projectStore: { subscribe(channel, listener) { persistenceListener = listener; } },
    fileSession: {
      installed: true,
      snapshot: () => ({ dirty: false }),
      recoveryContext() {},
      adoptRecovery() { throw new Error('Blocked tab must not adopt a foreign journal'); },
      discardRecovery() { throw new Error('Blocked tab must not discard a foreign journal'); },
      subscribe(listener) { cleanListener = listener; },
    },
  });
  assert.equal(controller.boot.reason, 'browser-writer-blocked');
  persistenceListener();
  cleanListener({ dirty: false });
  controller.writeNow();
  controller.discardRecovery();
  assert.equal(records.get(recovery.JOURNAL_KEY), '{foreign-invalid', 'blocked recovery must not quarantine, replace or remove a foreign journal');
  assert.equal(writes, 0);
  delete globalThis.BRKTRKBrowserWriterAuthority;
  let finishSave;
  const save = first.withAuthorizedWrite(() => new Promise(resolve => { finishSave = resolve; }));
  assert.equal(await second.acquire(), false, 'takeover cannot preempt an asynchronous save');
  finishSave();
  await save;
  assert.equal(await second.acquire(), false, 'completion does not surrender the editor lifetime lock');
  service.terminate('first');
  assert.equal(second.canWrite(), false, 'close/crash never silently promotes a waiting editor');
  assert.equal(await second.acquire(), true, 'explicit retry can own the released lock');
  assert.equal(second.withAuthorizedWrite(() => 'saved'), 'saved');
  second.retire();
  assert.equal(second.canWrite(), false, 'a history-restored document cannot reuse stale authority');
  assert.equal(await second.acquire(), false, 'retired runtime requires a fresh page');
  const unsupported = createBrowserWriterAuthority({ ownerId: 'unsupported' });
  assert.equal(await unsupported.acquire(), false);
  assert.equal(unsupported.snapshot().mode, 'unavailable');
  const denied = createBrowserWriterAuthority({ ownerId: 'denied', locks: { request() { throw new Error('denied'); } } });
  assert.equal(await denied.acquire(), false);
  assert.equal(denied.snapshot().mode, 'unavailable');
  assert.match(denied.snapshot().lastError, /denied/);
  // Regression: an accepted-release SW can return the old root index.html
  // at a new /__physical/<sha>/ URL if navigation fetch temporarily fails.
  // Only the new relative ProjectStore bytes know schema-v5 ParameterEvents.
  // Recognize this shell mismatch *before* acquiring a writer or migrating data.
  const commit = "a".repeat(40);
  const physicalLocation = { pathname: "/__physical/" + commit + "/physical-candidate.html" };
  const candidateIndex = { pathname: "/__physical/" + commit + "/index.html" };
  const template = (scripts) => ({
    content: {
      querySelectorAll() {
        return scripts.map(src => ({ getAttribute() { return src; } }));
      },
    },
  });
  const staleTemplate = template(["./production-instrument-domain.js?v=0.9.0", "./project-storage.js?v=0.9.0"]);
  const validTemplate = template(["./production-instrument-domain.js?v=0.9.0", "./parameter-event-domain.js?v=0.9.0", "./project-storage.js?v=0.9.0"]);
  assert.equal(physicalCandidateShellMismatch(physicalLocation, validTemplate), null);
  assert.equal(physicalCandidateShellMismatch(candidateIndex, validTemplate), null);
  assert.equal(physicalCandidateShellMismatch({ pathname: "/index.html" }, staleTemplate), null, "accepted root keeps its own historical shell");
  assert.equal(physicalCandidateShellMismatch(physicalLocation, staleTemplate).commit, commit);
  assert.equal(physicalCandidateShellMismatch(candidateIndex, staleTemplate).commit, commit);

  const recoveryKey = "brktrk:physical-shell-retry:" + commit;
  const validHtml = '<template id="browserWriterRuntime"><script src="./parameter-event-domain.js?v=0.9.0"></script></template>';
  async function recover({ html = validHtml, alreadyRetried = false } = {}) {
    const data = new Map(alreadyRetried ? [[recoveryKey, "attempted"]] : []);
    let redirected = null;
    let failure = null;
    let fetchCount = 0;
    const root = {
      location: { ...physicalLocation, replace(value) { redirected = value; } },
      document: { querySelector() { return staleTemplate; } },
      sessionStorage: {
        getItem(key) { return data.get(key) ?? null; },
        setItem(key, value) { data.set(key, value); },
      },
      BRKTRKBootstrapInput: { markStartupFailure(error) { failure = error.message; } },
      fetch: async (url) => {
        fetchCount++;
        if (url.startsWith("./index.html")) return { ok: true, async text() { return html; } };
        return { ok: true, async json() { return { commit, deploymentIdentity: "physical-candidate:" + commit }; } };
      },
    };
    const result = install(root);
    assert.equal(result, null, "mismatched shell must not install BrowserWriterAuthority or open Project");
    await new Promise(resolve => setImmediate(resolve));
    return { redirected, failure, data, fetchCount };
  }
  const repaired = await recover();
  assert.equal(repaired.redirected, "./index.html?preview=a5.5-c1&shell-recovery=1");
  assert.equal(repaired.failure, null);
  assert.equal(repaired.data.get(recoveryKey), "attempted", "one-shot redirect is bounded");
  const rejected = await recover({ html: '<script src="./project-storage.js?v=0.9.0"></script>' });
  assert.equal(rejected.redirected, null);
  assert.match(rejected.failure, /Exact candidate HTML was not returned/);
  assert.equal(rejected.data.has(recoveryKey), false, "no retry key before complete identity proof");
  const bounded = await recover({ alreadyRetried: true });
  assert.equal(bounded.redirected, null);
  assert.equal(bounded.fetchCount, 0, "second fallback must fail closed without a loop");
  assert.match(bounded.failure, /already been attempted/);

  console.log('G2C browser writer authority PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
