/**
 * sw.js — service worker for the Chapters app shell.
 *
 * Strategy:
 *  - The static shell (HTML/CSS/JS/icons) is precached on install and served
 *    cache-first, so the app opens instantly and works fully offline.
 *  - Requests to api.github.com are never intercepted: the app handles
 *    offline itself (drafts + queued commits), and caching API responses
 *    would only risk showing stale shas.
 *
 * Bump VERSION whenever any shell file changes so clients pick up updates.
 */

const VERSION = 'v2';
const CACHE = `chapters-shell-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/github.js',
  './js/storage.js',
  './js/editor.js',
  './js/ui.js',
  './js/setup.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Leave the GitHub API (and any other cross-origin request) alone.
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // Cache-first for the shell, with a network fallback + background refresh
  // (stale-while-revalidate) so updates land on the next launch.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const refresh = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached); // offline: fall back to cache (or fail as-is)
      return cached || refresh;
    })
  );
});
