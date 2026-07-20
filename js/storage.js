/**
 * storage.js — everything that persists on the device.
 *
 *  - localStorage: small settings (repo config, token, typography prefs,
 *    last-open chapter and folder). Synchronous, tiny, fine.
 *  - IndexedDB: chapter drafts. Every keystroke ends up here (debounced),
 *    so nothing is lost if the tab dies — including queued offline commits.
 *
 * Draft record shape (keyed by full in-repo path, e.g. "manuscript/01-intro.txt"):
 *   {
 *     path, name,           // identity
 *     content,              // the text
 *     sha,                  // blob sha we last saw on GitHub (null = never committed)
 *     dirty,                // true if content differs from what's committed
 *     savedAt,              // ms timestamp of last local save
 *     committedAt,          // ms timestamp of last successful commit (or null)
 *     pendingCommit,        // { message, queuedAt } when a commit was queued offline
 *   }
 */

const LS_PREFIX = 'chapters.';

/* ---------------------------------------------------------------- *
 * localStorage helpers
 * ---------------------------------------------------------------- */

function lsGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
}

/** Repo configuration: { owner, repo, branch, folder } */
export const settings = {
  get: () => lsGet('settings'),
  set: (value) => lsSet('settings', value),
};

/** The fine-grained PAT. Lives only in this browser's localStorage. */
export const token = {
  get: () => lsGet('token'),
  set: (value) => lsSet('token', value),
  clear: () => localStorage.removeItem(LS_PREFIX + 'token'),
};

/** Typography + theme preferences, merged over defaults. */
const PREF_DEFAULTS = {
  theme: 'auto',      // 'auto' | 'light' | 'dark'
  font: 'serif',      // 'serif' | 'sans' | 'mono'
  fontSize: 18,       // px
  lineHeight: 1.7,
  maxWidth: 68,       // ch
};

export const prefs = {
  get: () => ({ ...PREF_DEFAULTS, ...lsGet('prefs', {}) }),
  set: (patch) => lsSet('prefs', { ...prefs.get(), ...patch }),
};

/** Path of the chapter that was open last, to restore on launch. */
export const lastOpen = {
  get: () => lsGet('lastOpen'),
  set: (path) => lsSet('lastOpen', path),
};

/** Folder that was being browsed last ('' = repo root), to restore on launch. */
export const lastFolder = {
  get: () => lsGet('lastFolder'),
  set: (path) => lsSet('lastFolder', path),
};

export function isConfigured() {
  const s = settings.get();
  return Boolean(token.get() && s && s.owner && s.repo && s.branch);
}

/* ---------------------------------------------------------------- *
 * IndexedDB drafts
 * ---------------------------------------------------------------- */

const DB_NAME = 'chapters-db';
const DB_VERSION = 1;
const STORE = 'drafts';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'path' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** Run one request inside a transaction and resolve with its result. */
async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const drafts = {
  get: (path) => withStore('readonly', (s) => s.get(path)),
  put: (draft) => withStore('readwrite', (s) => s.put(draft)),
  remove: (path) => withStore('readwrite', (s) => s.delete(path)),
  all: () => withStore('readonly', (s) => s.getAll()),
};
