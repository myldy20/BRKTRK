const RELEASE = "0.8.54";
const CACHE = "brktrk-web-v0.8.54";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.put("./m5a-a5-stale-sentinel.txt", new Response("stale-release-sentinel", {
      headers: { "Content-Type": "text/plain" },
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "brktrk-release-info-request") return;
  const payload = { type: "brktrk-release-info", release: RELEASE, cache: CACHE };
  if (event.ports?.[0]) event.ports[0].postMessage(payload);
  else event.source?.postMessage?.(payload);
});
