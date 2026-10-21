(() => {
  'use strict';

  // Deliberately independent of release, URL, candidate and project identity:
  // every cooperating BRKTRK editor in this origin shares one writer.
  const LOCK_NAME = 'brktrk:browser-writer:v1';
  const CONTEXT_KEY = `${LOCK_NAME}:context`;

  function createBrowserWriterAuthority({ locks, ownerId, onChange = () => {} } = {}) {
    let mode = 'pending';
    let lastError = null;
    let attempt = null;
    const snapshot = () => Object.freeze({
      version: 1, mechanism: 'web-locks', lockName: LOCK_NAME,
      ownerId, mode, canWrite: mode === 'writer', lastError,
      takeoverPolicy: 'close-owner-then-explicit-retry',
    });
    const publish = () => onChange(snapshot());

    function acquire() {
      if (mode === 'writer') return Promise.resolve(true);
      if (mode === 'retired') return Promise.resolve(false);
      if (attempt) return attempt;
      let complete;
      attempt = new Promise(resolve => { complete = resolve; });
      const result = attempt;
      mode = 'pending';
      lastError = null;
      publish();
      Promise.resolve().then(() => {
        if (!locks?.request) throw new Error('Web Locks requires a supported browser and a secure connection.');
        return locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, lock => {
          if (mode === 'retired') { complete(false); return; }
          mode = lock ? 'writer' : 'blocked';
          attempt = null;
          publish();
          complete(Boolean(lock));
          // No timeout, heartbeat, steal or voluntary pagehide release. Save,
          // gestures and late durability callbacks stay inside this lifetime.
          // The browser releases the lock when this document is destroyed.
          if (lock) return new Promise(() => {});
        });
      }).catch(error => {
        if (mode !== 'retired') mode = 'unavailable';
        lastError = String(error?.message ?? error);
        attempt = null;
        publish();
        complete(false);
      });
      return result;
    }

    function withAuthorizedWrite(callback) {
      if (mode !== 'writer') {
        const error = new Error('BRKTRK is open in another tab, or browser writer access is unavailable.');
        error.code = 'BRKTRK_WRITER_BLOCKED';
        throw error;
      }
      return callback();
    }

    function retire() {
      mode = 'retired';
      publish();
    }

    return Object.freeze({ acquire, canWrite: () => mode === 'writer', snapshot, withAuthorizedWrite, retire });
  }

  // The accepted root Service Worker can have an older cached index shell
  // while the exact physical-candidate URL resolves newer relative JS assets.
  // That mixed document is not a valid writer: do not open Project storage.
  function physicalCandidateShellMismatch(location, template) {
    const match = String(location?.pathname ?? '').match(/^\/__physical\/([0-9a-f]{40})\/(?:index|physical-candidate)\.html$/);
    if (!match) return null;
    const sources = [...template.content.querySelectorAll('script[src]')].map(node => node.getAttribute('src') ?? '');
    if (sources.some(source => /\/parameter-event-domain\.js(?:\?|$)/.test(source))) return null;
    return Object.freeze({ commit: match[1] });
  }

  function install(root = globalThis) {
    const doc = root.document;
    const template = doc.querySelector('#browserWriterRuntime');
    if (!template) throw new Error('Browser writer runtime template is missing');

    const mismatch = physicalCandidateShellMismatch(root.location, template);
    const retryKey = mismatch ? 'brktrk:physical-shell-retry:' + mismatch.commit : null;
    if (mismatch) {
      // A read-only, one-shot repair. Network fetch does not take the writer
      // lock or mutate any Project; only navigate after verifying candidate
      // HTML and the exact immutable deployment identity. No retry loop.
      const fail = (reason) => root.BRKTRKBootstrapInput?.markStartupFailure?.(
        new Error('Physical candidate received an older cached HTML shell. ' + reason
          + ' Retry with a cache-bypassing reload or an incognito window; your Projects were not changed.'),
      );
      if (root.sessionStorage?.getItem?.(retryKey) === 'attempted') {
        fail('Automatic recovery has already been attempted.');
        return null;
      }
      void (async () => {
        const response = await root.fetch('./index.html?preview=a5.5-c1', { cache: 'no-store' });
        if (!response.ok) throw new Error('Exact candidate HTML could not be fetched');
        const html = await response.text();
        if (!/<script\s+src=["']\.\/parameter-event-domain\.js(?:\?|["'])/.test(html)) {
          throw new Error('Exact candidate HTML was not returned');
        }
        const probe = await root.fetch('./build.json?brktrk-deployment=1&preview=a5.5-c1', { cache: 'no-store' });
        if (!probe.ok) throw new Error('Exact candidate metadata could not be fetched');
        const metadata = await probe.json();
        if (metadata.commit !== mismatch.commit
          || metadata.deploymentIdentity !== 'physical-candidate:' + mismatch.commit) {
          throw new Error('Exact candidate deployment identity mismatch');
        }
        root.sessionStorage?.setItem?.(retryKey, 'attempted');
        root.location.replace('./index.html?preview=a5.5-c1&shell-recovery=1');
      })().catch(error => fail(String(error?.message ?? error)));
      return null;
    }
    const validCandidate = String(root.location?.pathname ?? '').match(/^\/__physical\/([0-9a-f]{40})\/index\.html$/);
    if (validCandidate) root.sessionStorage?.removeItem?.('brktrk:physical-shell-retry:' + validCandidate[1]);

    const panel = doc.createElement('section');
    panel.id = 'browserWriterStatus';
    panel.setAttribute('aria-labelledby', 'browserWriterTitle');
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;gap:16px;padding:24px;box-sizing:border-box;background:#05080d;color:#dce7f2;font:16px/1.5 system-ui;text-align:center;overflow:auto';
    const title = doc.createElement('h1');
    title.id = 'browserWriterTitle';
    title.style.cssText = 'font-size:22px;margin:0';
    const message = doc.createElement('p');
    message.style.cssText = 'max-width:32em;margin:0';
    message.setAttribute('role', 'status');
    const retry = doc.createElement('button');
    retry.id = 'browserWriterRetry';
    retry.type = 'button';
    retry.textContent = 'TRY AGAIN';
    retry.style.cssText = 'min-height:48px;padding:12px 24px;font:inherit;cursor:pointer';
    panel.append(title, message, retry);
    doc.body.append(panel);
    let started = false;
    let resolveRuntime;
    const runtimeReady = new Promise(resolve => { resolveRuntime = resolve; });

    function render(view) {
      doc.body.dataset.browserWriter = view.mode;
      if (view.mode === 'writer' || view.mode === 'blocked') {
        try { root.sessionStorage?.setItem(CONTEXT_KEY, view.mode); } catch {}
      }
      if (view.mode === 'writer') {
        panel.remove();
        return;
      }
      if (!panel.isConnected) doc.body.append(panel);
      if (started) root.BRKTRKBootstrapInput?.block('browser-writer-unavailable');
      const blocked = view.mode === 'blocked';
      title.textContent = blocked ? 'BRKTRK IS OPEN IN ANOTHER TAB' : 'BRKTRK · CHECKING WRITER ACCESS';
      message.textContent = blocked
        ? 'This tab cannot edit or save. Save your work and close the other BRKTRK tab or window, then try again here.'
        : 'Checking whether this tab can open the editor…';
      if (view.mode === 'unavailable') {
        title.textContent = 'BROWSER WRITER ACCESS UNAVAILABLE';
        message.textContent = `${view.lastError} The editor has not opened. Reload to try again.`;
      } else if (view.mode === 'retired') {
        title.textContent = 'BRKTRK · RELOADING EDITOR';
        message.textContent = 'Checking writer access again before restoring the editor.';
      }
      retry.hidden = !blocked;
      retry.disabled = !blocked;
      if (blocked) retry.focus();
    }

    let predecessorWasWriter = false;
    try {
      const navigation = root.performance?.getEntriesByType?.('navigation')?.[0];
      predecessorWasWriter = navigation?.type === 'reload'
        && root.sessionStorage?.getItem(CONTEXT_KEY) === 'writer';
    } catch {}
    const nativeLocks = root.navigator?.locks;
    // A reload successor can start before Chromium has released the destroyed
    // predecessor Document's Web Lock. Queue only when this document is an
    // actual reload and this browsing context previously settled as writer.
    // sessionStorage alone is insufficient because window.open/duplicate can
    // copy it into a distinct top-level context. Fresh/blocked contexts keep
    // ifAvailable arbitration and never auto-promote.
    const locks = predecessorWasWriter && nativeLocks?.request ? {
      request(name, options, callback) {
        return nativeLocks.request(name, { mode: options.mode }, callback);
      },
    } : nativeLocks;
    const authority = createBrowserWriterAuthority({
      locks,
      ownerId: root.crypto?.randomUUID?.() ?? 'unavailable',
      onChange: render,
    });
    root.BRKTRKBrowserWriterAuthority = Object.freeze({ ...authority, runtimeReady });

    // A non-writer page has no editor runtime, dirty Project, gestures or file
    // I/O to preserve. If another writer safely activates a replacement worker,
    // retire this stale bootstrap immediately and reload it under the new
    // controller. The active writer is deliberately ignored here: #368 owns
    // its explicit safety gate and reload boundary after controllerchange.
    root.navigator?.serviceWorker?.addEventListener?.('controllerchange', () => {
      if (authority.canWrite()) return;
      authority.retire();
      root.BRKTRKBootstrapInput?.block('browser-writer-service-worker-update');
      root.location?.reload?.();
    });

    async function start() {
      if (!(await authority.acquire()) || started) return;
      started = true;
      try {
        for (const source of template.content.querySelectorAll('script[src]')) {
          const preload = doc.createElement('link');
          preload.rel = 'preload';
          preload.as = 'script';
          preload.href = source.getAttribute('src');
          doc.head.append(preload);
        }
        // Cloning an inert script does not execute it. Create fresh classic
        // scripts and preserve the existing order, including the late runtime
        // boundary previously provided by the HTML parser's DOMContentLoaded.
        for (const source of template.content.querySelectorAll('script[src]')) {
          authority.withAuthorizedWrite(() => {});
          await new Promise((resolve, reject) => {
            const script = doc.createElement('script');
            script.src = source.getAttribute('src');
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Could not load ${script.src}`));
            doc.body.append(script);
          });
        }
        resolveRuntime();
        const settings = doc.querySelector('#settingsDialog .settings-actions');
        if (settings) {
          const status = doc.createElement('div');
          status.id = 'browserWriterOwner';
          status.className = 'storage-status';
          status.textContent = 'BROWSER WRITER · THIS TAB';
          status.title = authority.snapshot().ownerId;
          settings.insertAdjacentElement('beforebegin', status);
        }
      } catch (error) {
        root.BRKTRKBootstrapInput?.markStartupFailure(error);
      }
    }

    retry.addEventListener('click', () => { void start(); });
    root.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      // Never resume a cached model under remembered ownership. Keep the old
      // document inert until navigation destroys it and reacquire from scratch.
      authority.retire();
      root.BRKTRKBootstrapInput?.block('browser-writer-history-restore');
      root.location.reload();
    });
    void start();
    return root.BRKTRKBrowserWriterAuthority;
  }

  const api = Object.freeze({ LOCK_NAME, createBrowserWriterAuthority, physicalCandidateShellMismatch, install });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && typeof document !== 'undefined') install(globalThis);
})();
