/* Prysm Note service worker - Web Push notifications plus an offline shell. */
const CACHE_VERSION = "prysm-v2";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const APP_SHELL = "/";

const PRECACHE_URLS = [
  APP_SHELL,
  "/manifest.webmanifest",
  "/prysm-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/favicon.ico",
];

const PRECACHE_PREFIXES = [CACHE_VERSION];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => undefined)
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => !PRECACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isCacheableAsset(url) {
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname === "/manifest.webmanifest") return true;
  return /\.(?:css|js|mjs|woff2?|ttf|otf|png|jpg|jpeg|gif|svg|webp|avif|ico)$/.test(
    url.pathname
  );
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.status === 200 && response.type === "basic") {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

async function networkFirstData(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === "basic") {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return Response.error();
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === "basic") {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    const shell = await caches.match(APP_SHELL);
    if (shell) return shell;
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/version") return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isCacheableAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else (route/RSC data, HTML fragments, dynamic GETs) is served
  // network-first. This shell is deployed independently of the pages it loads,
  // so serving a stale payload first is what broke navigation after a release.
  // The cache stays only as an offline fallback.
  event.respondWith(networkFirstData(request));
});

self.addEventListener("push", (event) => {
  let data = { title: "Prysm Note", body: "" };
  try {
    const payload = event.data ? event.data.json() : {};
    data = { ...data, ...payload };
  } catch {
    if (event.data) data.body = event.data.text();
  }
  const options = {
    body: data.body,
    icon: "/prysm-icon.png",
    badge: "/prysm-icon.png",
    tag: "prysm-notification",
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          return;
        }
      }
      return self.clients.openWindow("/");
    })
  );
});
