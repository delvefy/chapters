/**
 * github.js — thin client for the GitHub REST API (contents endpoints).
 *
 * All requests go straight from the browser to api.github.com, authenticated
 * with a fine-grained Personal Access Token supplied by the user. No backend.
 *
 * Also home to the UTF-8-safe base64 helpers: the contents API speaks base64,
 * and naive atob/btoa corrupts anything outside Latin-1 (accents, em-dashes,
 * curly quotes, emoji — i.e. every real book).
 */

const API_ROOT = 'https://api.github.com';

/* ---------------------------------------------------------------- *
 * UTF-8 <-> base64
 * ---------------------------------------------------------------- */

/** Encode a JS string to base64 via real UTF-8 bytes. */
export function encodeB64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  // Build a binary string in chunks — spreading a huge array into
  // String.fromCharCode blows the argument limit on large files.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Decode base64 (as returned by GitHub, possibly with newlines) to a UTF-8 string. */
export function decodeB64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---------------------------------------------------------------- *
 * Errors
 * ---------------------------------------------------------------- */

/**
 * Error with a `kind` the UI can branch on:
 *   'offline' | 'auth' | 'not-found' | 'rate-limit' | 'conflict' | 'forbidden' | 'api'
 */
export class GitHubError extends Error {
  constructor(message, kind, status = 0) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
  }
}

/* ---------------------------------------------------------------- *
 * Core request helper
 * ---------------------------------------------------------------- */

async function api(token, path, options = {}) {
  let res;
  try {
    res = await fetch(API_ROOT + path, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      },
    });
  } catch {
    throw new GitHubError(
      'Could not reach GitHub — you appear to be offline.',
      'offline'
    );
  }
  if (res.ok) return res;

  // Try to surface GitHub's own message alongside our friendly one.
  let apiMsg = '';
  try { apiMsg = (await res.json()).message || ''; } catch { /* not JSON */ }

  switch (res.status) {
    case 401:
      throw new GitHubError(
        'GitHub rejected the token (401). It may have expired or been revoked — check Settings → Developer settings → Tokens.',
        'auth', 401
      );
    case 404:
      throw new GitHubError(
        'Not found (404). Check the owner, repo and branch names — and note that fine-grained tokens must be granted access to this specific repo.',
        'not-found', 404
      );
    case 409:
      throw new GitHubError(
        'The file changed on GitHub since you opened it (409).',
        'conflict', 409
      );
    case 403:
    case 429: {
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const when = reset
          ? new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : 'later';
        throw new GitHubError(
          `GitHub API rate limit reached. Try again after ${when}.`,
          'rate-limit', res.status
        );
      }
      throw new GitHubError(
        `GitHub refused the request (403)${apiMsg ? `: ${apiMsg}` : ''}. Does the token have “Contents: Read and write” on this repo?`,
        'forbidden', 403
      );
    }
    case 422:
      // A PUT with a missing/stale sha for an existing file comes back 422.
      if (/sha/i.test(apiMsg)) {
        throw new GitHubError(
          'The file changed on GitHub since you opened it.',
          'conflict', 422
        );
      }
      throw new GitHubError(`GitHub could not process the request: ${apiMsg}`, 'api', 422);
    default:
      throw new GitHubError(
        `GitHub API error (${res.status})${apiMsg ? `: ${apiMsg}` : ''}.`,
        'api', res.status
      );
  }
}

/* ---------------------------------------------------------------- *
 * Path helpers
 * ---------------------------------------------------------------- */

/** Strip leading/trailing slashes from the configured folder ("manuscript/" -> "manuscript"). */
export function normalizeFolder(folder) {
  return (folder || '').trim().replace(/^\/+|\/+$/g, '');
}

/** Full in-repo path for a chapter file name. */
export function chapterPath(cfg, name) {
  const folder = normalizeFolder(cfg.folder);
  return folder ? `${folder}/${name}` : name;
}

/** URL-encode a repo path, segment by segment (keeps the slashes). */
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function contentsUrl(cfg, path) {
  return `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodePath(path)}`;
}

/* ---------------------------------------------------------------- *
 * Operations
 * ---------------------------------------------------------------- */

/** Cheap sanity check used by the setup screen: can we see the repo at all? */
export async function validateRepo(cfg, token) {
  await api(token, `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`);
}

/**
 * List .txt files in the configured folder, sorted by name.
 * A missing folder is not an error — it just means no chapters yet
 * (GitHub creates intermediate folders on the first commit).
 */
export async function listChapters(cfg, token) {
  const folder = normalizeFolder(cfg.folder);
  const url = contentsUrl(cfg, folder) + `?ref=${encodeURIComponent(cfg.branch)}`;
  let res;
  try {
    res = await api(token, url);
  } catch (err) {
    if (err.kind === 'not-found') return [];
    throw err;
  }
  const entries = await res.json();
  if (!Array.isArray(entries)) {
    throw new GitHubError(
      'The configured folder path points at a file, not a folder.',
      'api'
    );
  }
  return entries
    .filter((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.txt'))
    .map((e) => ({ name: e.name, path: e.path, sha: e.sha, size: e.size }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Fetch a chapter's text and current blob sha.
 * Files over ~1 MB come back without inline content; fall back to the
 * raw media type for those (sha is present in the JSON either way).
 */
export async function getFile(cfg, token, path) {
  const url = contentsUrl(cfg, path) + `?ref=${encodeURIComponent(cfg.branch)}`;
  const meta = await (await api(token, url)).json();
  if (meta.encoding === 'base64' && typeof meta.content === 'string') {
    return { content: decodeB64Utf8(meta.content), sha: meta.sha };
  }
  const raw = await api(token, url, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  return { content: await raw.text(), sha: meta.sha };
}

/**
 * Create or update a chapter. Pass the sha from getFile when updating;
 * omit it when creating. Throws GitHubError kind 'conflict' if the sha
 * is stale (someone changed the file on GitHub in the meantime).
 * Returns the new blob sha.
 */
export async function putFile(cfg, token, path, content, message, sha) {
  const body = {
    message,
    content: encodeB64Utf8(content),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  const res = await api(token, contentsUrl(cfg, path), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { sha: json.content.sha };
}
