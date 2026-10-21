const RELEASE = "0.9.0";
const RELEASE_CACHE = "brktrk-web-v0.9.0";
const RELEASE_CACHE_PREFIX = "brktrk-web-v";
const PREVIEW_CACHE_PREFIX = "brktrk-web-preview-";
const LEGACY_ENGINE_PACKAGE_CACHE = "brktrk-engine-packages-v1";
const PREVIEW_KEY_PARAM = "__brktrk_preview";
const PREVIEW_TOKEN = "a5.5-c1";
const SCRIPT_URL = new URL(self.location.href);
const SCOPE_URL = new URL("./", SCRIPT_URL);
const ENGINE_ROOT_URL = new URL("./engines/", SCOPE_URL);
const ENGINE_PACKAGES_URL = new URL("./packages/", ENGINE_ROOT_URL);
const ENGINE_CATALOG = "./engines/catalog-v1.json";
const ENGINE_CATALOG_URL = new URL(ENGINE_CATALOG, SCOPE_URL);
const ENGINE_TRUST_MODE = "same-origin-pinned-path-v1";
const ENGINE_TRUST_PUBLISHER = "myldy-brksynth";
const CANDIDATE_PATH_RE = /\/__physical\/([0-9a-f]{40})\/sw\.js$/;
const CANDIDATE = SCRIPT_URL.pathname.match(CANDIDATE_PATH_RE)?.[1] ?? null;
const IS_PHYSICAL_CANDIDATE = CANDIDATE !== null;
const CACHE = IS_PHYSICAL_CANDIDATE ? `${PREVIEW_CACHE_PREFIX}${CANDIDATE}` : RELEASE_CACHE;
const CACHE_PREFIX = RELEASE_CACHE_PREFIX;
const DEPLOYMENT_PROBE = `./build.json?brktrk-deployment=1&preview=${encodeURIComponent(PREVIEW_TOKEN)}`;
const BASE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./p2.css",
  "./p3.css",
  "./p3-0-1.css",
  "./p35.css",
  "./phrase-fx-surface.css",
  "./ux1-visual-foundation.css",
  "./ux1-desktop-shell.css",
  "./ux1-context-sheet.css",
  "./ux1-sound-workbench.css",
  "./release-identity.css",
  "./p36.css",
  "./mobile-context-picker.css",
  "./value-dock.css",
  "./note-entry-ui.css",
  "./touch-actions.css",
  "./track-mixer.css",
  "./track-insert-fx.css",
  "./honest-surface.css",
  "./undo-redo.css",
  "./selection-clipboard.css",
  "./phrase-row-operations.css",
  "./physical-candidate-storage-scope.js",
  "./browser-writer-authority.js",
  "./production-instrument-domain.js",
  "./parameter-event-domain.js",
  "./sample-asset-domain.js",
  "./sample-asset-store.js",
  "./sample-asset-host.js",
  "./sample-asset-surface.js",
  "./project-storage.js",
  "./project-file.js",
  "./project-file-session-store.js",
  "./project-file-session.js",
  "./project-file-session-ui.js",
  "./project-recovery.js",
  "./app-model.js",
  "./project-storage-runtime.js",
  "./audio-readiness.js",
  "./p3-contract.js",
  "./app-input.js",
  "./phrase-condition-presentation.js",
  "./app-render.js",
  "./phrase-fx-surface.js",
  "./bootstrap-input-gate.js",
  "./app-bind.js",
  "./p2.js",
  "./p3.js",
  "./p3-0-1.js",
  "./playback-context-policy.js",
  "./p35-context-transport.js",
  "./song-playback-gate.js",
  "./song-transport-policy.js",
  "./project-transport-policy.js",
  "./event-plan-compiler.js",
  "./timing-domain.js",
  "./timing-map-domain.js",
  "./table-source-domain.js",
  "./production-timeline-domain.js",
  "./production-timeline-template.js",
  "./production-timeline-bind-budget-extension.js",
  "./note-lifecycle-domain.js",
  "./phrase-fx-domain.js",
  "./phrase-fx-runtime-domain.js",
  "./event-trace-domain.js",
  "./production-execution-template.js",
  "./realtime-execution-queue.js",
  "./realtime-event-window-domain.js",
  "./engine-package-domain.js",
  "./engine-package-loader.js",
  "./engine-package-tar-domain.js",
  "./engine-package-browser.js",
  "./engine-preset-domain.js",
  "./prepared-instrument-state-domain.js",
  "./prepared-instrument-application-state.js",
  "./engine-registry-domain.js",
  "./performer-registry-domain.js",
  "./synth-gateway-domain.js",
  "./brk-synth-abi-v1-worklet.js",
  "./brk-synth-prepared-state-extension.js",
  "./brk-synth-r6-realtime-extension.js",
  "./brk-synth-runtime-lifetime-extension.js",
  "./prepared-instrument-state-worklet-domain.js",
  "./prepared-instrument-state-gateway-extension.js",
  "./synth-gateway-r6-realtime-extension.js",
  "./production-audio-runtime.js",
  "./production-r6-realtime-extension.js",
  "./production-runtime-lifetime-extension.js",
  "./production-prepared-lifecycle-pair-runtime-extension.js",
  "./production-track-note-owner-runtime-extension.js",
  "./production-prepared-state-runtime-extension.js",
  "./production-audio-processor-extension.js",
  "./production-prepared-timeline-processor-extension.js",
  "./production-prepared-execution-processor-extension.js",
  "./production-engine-host.js",
  "./production-engine-prepared-state-host-extension.js",
  "./production-engine-bootstrap.js",
  "./production-engine-store-sync.js",
  "./production-engine-diagnostics.js",
  "./p36-transport.js",
  "./k3c-transport-adapter.js",
  "./stores.js",
  "./transport-runtime-state.js",
  "./audio-lifecycle-policy.js",
  "./audio-lifecycle-domain.js",
  "./audio-lifecycle.js",
  "./audio-lifecycle-controls.js",
  "./audio-lifecycle-ui.js",
  "./i1-transport-domain.js",
  "./project-phrase-step.js",
  "./project-instrument-preset.js",
  "./project-user-preset.js",
  "./project-structure.js",
  "./phrase-step-renderer.js",
  "./structural-renderer.js",
  "./sound-edit-renderer.js",
  "./sound-preset-surface.js",
  "./sound-preset-live-prepared-policy.js",
  "./navigation-entry-state.js",
  "./store-runtime-adapters.js",
  "./phrase-row-presentation.js",
  "./structural-reference-graph.js",
  "./track-mix-domain.js",
  "./track-insert-fx-domain.js",
  "./track-mix-runtime.js",
  "./track-insert-fx-runtime.js",
  "./output-latency-domain.js",
  "./track-mixer.js",
  "./track-insert-fx-surface.js",
  "./project-playback-refresh.js",
  "./architecture-convergence-c3.js",
  "./i1-transport.js",
  "./i1-scope-controls.js",
  "./follow-hold-policy.js",
  "./mixer-transport-safety.js",
  "./transport-state-ui.js",
  "./field-schema.js",
  "./phrase-fx-semantic-surface.js",
  "./honest-surface.js",
  "./hierarchy-context-renderer.js",
  "./mix-context-renderer.js",
  "./occurrence-context-renderer.js",
  "./workspace-context-renderer.js",
  "./project-structure-runtime.js",
  "./command-state.js",
  "./transport-command-bridge.js",
  "./command-dispatcher.js",
  "./value-dock.js",
  "./phrase-condition-surface.js",
  "./phrase-fx-phone-editor.js",
  "./prepared-entry-transaction.js",
  "./note-entry-ui.js",
  "./paste-target-input-router.js",
  "./command-bindings.js",
  "./debug-snapshot.js",
  "./undo-redo.js",
  "./selection-clipboard.js",
  "./structural-row-operations.js",
  "./keyboard-command-resolver.js",
  "./phrase-row-operations.js",
  "./input-safety.js",
  "./touch-action-policy.js",
  "./touch-actions.js",
  "./mobile-context-picker.js",
  "./contextual-sheet-viewport.js",
  "./sw-update-handover.js",
  "./audio-worklet.js",
  "./audio-worklet-runtime.js",
  "./audio-worklet-diagnostics.js",
  "./debug-snapshot-browser-smoke.html",
  "./k3c-audio-facade-browser-smoke.html",
  "./m42a-undo-redo-browser-smoke.html",
  "./m42a-phone-actions-browser-smoke.html",
  "./m42b-selection-clipboard-browser-smoke.html",
  "./m42b-selection-clipboard-full-browser-smoke.html",
  "./m42b2-phrase-row-operations-browser-smoke.html",
  "./m42b2p-keyboard-resolver-browser-smoke.html",
  "./m43a-a3-recovery-browser-smoke.html",
  "./fixtures/p36-transport-project.json",
  "./manifest.webmanifest",
  "./version.json",
  "./LICENSE.txt",
  "./NOTICE.txt",
  "./icon.svg"
];
const CANDIDATE_ASSETS = [
  "./physical-candidate.html",
  "./physical-candidate-entrypoint.js",
  "./physical-candidate.webmanifest"
];
const ASSETS = IS_PHYSICAL_CANDIDATE ? [...BASE_ASSETS, ...CANDIDATE_ASSETS] : BASE_ASSETS;

function absoluteUrl(requestLike) {
  if (requestLike instanceof Request) return requestLike.url;
  return new URL(String(requestLike), self.location.href).href;
}

function cacheKey(requestLike) {
  const url = new URL(absoluteUrl(requestLike));
  const inScope = url.origin === SCOPE_URL.origin && url.pathname.startsWith(SCOPE_URL.pathname);
  // Runtime assets are requested with the release identity as ?v=<version>,
  // while install-time precache uses canonical unversioned paths. The release
  // query selects browser freshness, not distinct bytes inside this immutable
  // release cache, so normalize it for every same-scope release request.
  if (inScope) url.searchParams.delete("v");
  if (IS_PHYSICAL_CANDIDATE && inScope) {
    // Candidate identity is the exact SHA, not the inherited release query.
    // Keep candidate cache identity isolated even when the copied accepted
    // index still asks for assets with the accepted release ?v= value.
    url.searchParams.set("preview", PREVIEW_TOKEN);
    url.searchParams.set(PREVIEW_KEY_PARAM, CANDIDATE);
  }
  return url.href;
}

async function fetchFresh(requestLike) {
  const input = requestLike instanceof Request ? requestLike : absoluteUrl(requestLike);
  return fetch(new Request(input, { cache: "no-store" }));
}

function trustedEnginePackageUrl(value) {
  const url = new URL(String(value ?? ""), ENGINE_ROOT_URL);
  if (url.origin !== ENGINE_PACKAGES_URL.origin || !url.pathname.startsWith(ENGINE_PACKAGES_URL.pathname)) {
    throw new Error(`Engine package URL escaped pinned packages root: ${url.href}`);
  }
  return url;
}

function trustedEngineCatalog(catalog, context = "Service Worker engine catalog") {
  if (catalog?.format !== "brk-engine-catalog-v1") throw new Error(`${context} has unexpected format`);
  if (catalog?.trust?.mode !== ENGINE_TRUST_MODE || catalog?.trust?.publisher !== ENGINE_TRUST_PUBLISHER) {
    throw new Error(`${context} metadata does not match the pinned host trust root`);
  }
  if (!Array.isArray(catalog.entries)) throw new Error(`${context} entries must be an array`);
  return catalog;
}

async function readTrustedEngineCatalog(response, context) {
  let catalog;
  try { catalog = await response.clone().json(); }
  catch { throw new Error(`${context} is invalid JSON`); }
  return trustedEngineCatalog(catalog, context);
}

function engineCatalogPackageUrls(catalog) {
  const urls = new Map();
  for (const entry of catalog.entries) {
    const packageUrl = trustedEnginePackageUrl(entry?.packageUrl);
    urls.set(cacheKey(packageUrl.href), packageUrl);
  }
  return urls;
}

function isEngineCatalogRequest(requestLike) {
  const url = new URL(absoluteUrl(requestLike));
  return url.origin === ENGINE_CATALOG_URL.origin && url.pathname === ENGINE_CATALOG_URL.pathname;
}

function isEnginePackageRequest(requestLike) {
  const url = new URL(absoluteUrl(requestLike));
  return url.origin === ENGINE_PACKAGES_URL.origin && url.pathname.startsWith(ENGINE_PACKAGES_URL.pathname);
}

async function ensureCatalogPackagesCached(cache, packageUrls) {
  await Promise.all([...packageUrls.entries()].map(async ([key, packageUrl]) => {
    if (await cache.match(key)) return;
    const response = await fetchFresh(packageUrl.href);
    if (!response.ok) throw new Error(`Could not pre-cache trusted engine package ${packageUrl.pathname}: ${response.status}`);
    const finalUrl = trustedEnginePackageUrl(response.url || packageUrl.href);
    if (finalUrl.href !== packageUrl.href) throw new Error(`Trusted engine package redirected during cache reconcile: ${packageUrl.href} -> ${finalUrl.href}`);
    await cache.put(key, response);
  }));
}

async function pruneEnginePackageCache(cache, allowedPackageKeys) {
  let deleted = 0;
  for (const request of await cache.keys()) {
    if (!isEnginePackageRequest(request)) continue;
    const key = cacheKey(request);
    if (allowedPackageKeys.has(key)) continue;
    if (await cache.delete(request)) deleted += 1;
  }
  return deleted;
}

async function reconcileEngineStoreCache(cache, catalogResponse, context = "Service Worker engine catalog") {
  const catalog = await readTrustedEngineCatalog(catalogResponse, context);
  const packageUrls = engineCatalogPackageUrls(catalog);
  // Commit the new catalog only after every newly referenced exact package is
  // already durable. Offline readers therefore never observe a catalog whose
  // exact package URL is missing from the sole persistent archive owner.
  await ensureCatalogPackagesCached(cache, packageUrls);
  await cache.put(cacheKey(ENGINE_CATALOG), catalogResponse.clone());
  // Old exact package URLs are retired only after the new coherent catalog is
  // committed. A transient deletion failure can retain extra bytes until the
  // next online catalog refresh, but can never make the offline set incomplete.
  await pruneEnginePackageCache(cache, new Set(packageUrls.keys()));
  return catalog;
}

async function installEngineStore(cache) {
  const catalogResponse = await fetchFresh(ENGINE_CATALOG);
  if (!catalogResponse.ok) throw new Error(`Could not pre-cache trusted engine catalog: ${catalogResponse.status}`);
  await reconcileEngineStoreCache(cache, catalogResponse, "Trusted engine catalog during Service Worker install");
}

async function verifyPhysicalCandidate(cache) {
  if (!IS_PHYSICAL_CANDIDATE) return;
  const response = await fetchFresh(DEPLOYMENT_PROBE);
  if (!response.ok) throw new Error(`Could not verify physical candidate metadata: ${response.status}`);
  const metadata = await response.clone().json();
  const expectedIdentity = `physical-candidate:${CANDIDATE}`;
  if (metadata?.commit !== CANDIDATE || metadata?.deploymentIdentity !== expectedIdentity) {
    throw new Error(`Physical candidate metadata mismatch for ${CANDIDATE}`);
  }
  await cache.put(cacheKey(DEPLOYMENT_PROBE), response);
}

async function installReleaseCache() {
  const cache = await caches.open(CACHE);
  await verifyPhysicalCandidate(cache);
  await Promise.all([
    ...ASSETS.map(async (asset) => {
      const response = await fetchFresh(asset);
      if (!response.ok) throw new Error(`Could not pre-cache ${asset}: ${response.status}`);
      await cache.put(cacheKey(asset), response);
    }),
    installEngineStore(cache),
  ]);
}

self.addEventListener("install", (event) => {
  // A replacement worker must remain waiting until the current writer tab
  // explicitly approves a safe handover. First install still activates through
  // the browser's normal no-active-worker lifecycle.
  event.waitUntil(installReleaseCache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const releaseCaches = keys.filter((key) => key.startsWith(RELEASE_CACHE_PREFIX));
    const previewCaches = keys.filter((key) => key.startsWith(PREVIEW_CACHE_PREFIX));
    const previousReleaseCaches = IS_PHYSICAL_CANDIDATE
      ? previewCaches.filter((key) => key !== CACHE)
      : [
          ...releaseCaches.filter((key) => key !== CACHE),
          ...previewCaches,
        ];
    const retiredCaches = new Set(previousReleaseCaches);
    if (!IS_PHYSICAL_CANDIDATE && keys.includes(LEGACY_ENGINE_PACKAGE_CACHE)) retiredCaches.add(LEGACY_ENGINE_PACKAGE_CACHE);
    await Promise.all([...retiredCaches].map((key) => caches.delete(key)));
    // Activation is reached only after the safe page-side handover for updates.
    // The root release worker retires the former page-owned exact archive
    // namespace here, never during install while an old live session may still
    // depend on it. Candidate workers must not delete origin-wide root caches.
    // Modern engine archives live only in the coherent release/candidate cache.
    // Claim clients so the approved writer can observe controllerchange; never
    // navigate/reload arbitrary clients from Service Worker authority.
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "brktrk-activate-update") {
    event.waitUntil((async () => {
      try {
        await self.skipWaiting();
        const payload = { type: "brktrk-activate-update-result", ok: true };
        if (event.ports?.[0]) event.ports[0].postMessage(payload);
        else event.source?.postMessage?.(payload);
      } catch (error) {
        const payload = { type: "brktrk-activate-update-result", ok: false, error: String(error?.message ?? error) };
        if (event.ports?.[0]) event.ports[0].postMessage(payload);
        else event.source?.postMessage?.(payload);
        throw error;
      }
    })());
    return;
  }
  if (event.data?.type !== "brktrk-release-info-request") return;
  const payload = {
    type: "brktrk-release-info",
    release: RELEASE,
    cache: CACHE,
    deploymentMode: IS_PHYSICAL_CANDIDATE ? "physical-candidate" : "release",
    candidate: CANDIDATE,
  };
  if (event.ports?.[0]) event.ports[0].postMessage(payload);
  else event.source?.postMessage?.(payload);
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // The accepted root Service Worker has a broad / scope. It must NEVER answer
  // requests for isolated /__physical/<sha>/ candidates: if the network fails,
  // falling back to root index.html gives the candidate URL an older HTML shell
  // that loads newer candidate JS (notably schema-v5 ParameterEvent storage).
  // Let the browser use its own network/error path until the candidate's
  // narrower Service Worker can take ownership of that candidate scope.
  const requestUrl = new URL(event.request.url);
  if (!IS_PHYSICAL_CANDIDATE && requestUrl.origin === SCOPE_URL.origin
    && requestUrl.pathname.startsWith("/__physical/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetchFresh(event.request);
      if (response.ok) {
        if (isEngineCatalogRequest(event.request)) {
          await reconcileEngineStoreCache(cache, response, "Trusted engine catalog refresh");
        } else {
          await cache.put(cacheKey(event.request), response.clone());
        }
      }
      return response;
    } catch (networkError) {
      const cached = await cache.match(cacheKey(event.request));
      if (cached) return cached;
      if (event.request.mode === "navigate") {
        const shellAsset = IS_PHYSICAL_CANDIDATE ? "./physical-candidate.html" : "./index.html";
        const shell = await cache.match(cacheKey(shellAsset));
        if (shell) return shell;
      }
      throw networkError;
    }
  })());
});