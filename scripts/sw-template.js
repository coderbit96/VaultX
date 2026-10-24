/* VaultX public shell only. Never cache authenticated responses or media. */
const SHELL_CACHE = "vaultx-public-shell-__VAULTX_SHELL_VERSION__";
const PUBLIC_FILES = [
  "/offline.html",
  "/offline-vault.html",
  "/offline-vault.js",
  "/offline-kdf.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];
const PUBLIC_PATHS = new Set(PUBLIC_FILES);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PUBLIC_FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("vaultx-public-shell-") && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // HTML is always fetched from the server. A private page is never saved.
  if (request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/unlock" || url.pathname === "/install"
    || url.pathname === "/offline-vault.html"
    || url.pathname === "/vault" || url.pathname.startsWith("/vault/"))) {
    event.respondWith(fetch(request).catch(async () => {
      const offline = await caches.match(url.pathname === "/offline-vault.html" ? "/offline-vault.html" : "/offline.html");
      return offline || Response.error();
    }));
    return;
  }

  // Only these immutable, public display assets are available offline.
  if (PUBLIC_PATHS.has(url.pathname) && !url.search) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
