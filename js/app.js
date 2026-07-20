/**
 * app.js — entry point and orchestrator.
 * Owns the app state and wires together github.js (remote), storage.js
 * (local persistence), editor.js (writing surface) and ui.js (chrome).
 */

import * as gh from './github.js';
import * as store from './storage.js';
import * as ui from './ui.js';
import { applyTypography, computeStats, formatStats, makeDebouncer } from './editor.js';
import { initSetup, showSetup } from './setup.js';

const $ = (id) => document.getElementById(id);

const state = {
  chapters: [],   // [{ name, path, sha?, size?, localOnly?, dirty? }] in the current folder
  folders: [],    // [{ name, path }] subfolders of the current folder
  folder: null,   // folder being browsed (repo-relative, '' = repo root)
  current: null,  // active draft record (see storage.js for shape)
  online: navigator.onLine,
};

const cfg = () => store.settings.get();
const tok = () => store.token.get();

/** The configured folder acts as the navigation root ('' = repo root). */
const rootFolder = () => gh.normalizeFolder(cfg().folder);
const parentOf = (path) => path.split('/').slice(0, -1).join('/');

function withinRoot(folder, root) {
  if (typeof folder !== 'string') return false;
  return root === '' || folder === root || folder.startsWith(root + '/');
}

/* ================================================================ *
 * Boot
 * ================================================================ */

function boot() {
  ui.applyTheme(store.prefs.get().theme);
  applyTypography(store.prefs.get());
  ui.initDrawerGestures();
  ui.initDialogDismissal();
  initSetup({ onSaved: onConfigSaved });
  wireEvents();
  registerServiceWorker();

  if (store.isConfigured()) {
    showApp();
  } else {
    showSetup();
  }
}

async function onConfigSaved() {
  // Fresh or changed config — reload the chapter list from scratch.
  state.chapters = [];
  state.folders = [];
  state.current = null;
  state.folder = rootFolder();
  store.lastFolder.set(state.folder);
  await showApp();
}

async function showApp() {
  $('app-screen').hidden = false;
  renderEditor();

  // Pick up browsing where we left off — fall back to the configured root
  // if there's nothing saved or the saved folder is outside the new root.
  if (state.folder === null) {
    const saved = store.lastFolder.get();
    state.folder = withinRoot(saved, rootFolder()) ? saved : rootFolder();
  }
  await refreshChapters();

  // Restore the chapter that was open last time: either it's listed in the
  // restored folder, or we still hold a local draft of it (e.g. offline).
  const last = store.lastOpen.get();
  if (!state.current && last) {
    if (state.chapters.some((c) => c.path === last) || (await store.drafts.get(last))) {
      await openChapter(last);
    }
  }
  // Nothing to show yet? Present the chapter list instead of a blank page.
  if (!state.current) {
    ui.openDrawer();
  }
}

/* ================================================================ *
 * Chapter list
 * ================================================================ */

async function refreshChapters() {
  const folder = state.folder ?? rootFolder();
  const localDrafts = await store.drafts.all();
  const byPath = new Map();
  const dirsByPath = new Map();

  try {
    const remote = await gh.listFolder(cfg(), tok(), folder);
    remote.dirs.forEach((d) => dirsByPath.set(d.path, d));
    remote.files.forEach((c) => byPath.set(c.path, c));
    setOnline(true);
  } catch (err) {
    if (err.kind === 'offline') {
      setOnline(false);
      ui.toast('Offline — showing locally saved chapters.');
    } else {
      ui.toast(err.message, { duration: 7000 });
    }
  }

  // Local drafts that GitHub doesn't know about yet (created offline,
  // or listed while offline) still belong in the list — and drafts living
  // deeper down imply subfolders we should show even without the API.
  for (const d of localDrafts) {
    const parent = parentOf(d.path);
    if (parent === folder) {
      if (!byPath.has(d.path)) {
        byPath.set(d.path, { name: d.name, path: d.path, localOnly: !d.sha });
      }
      const entry = byPath.get(d.path);
      entry.dirty = d.dirty;
      entry.queued = Boolean(d.pendingCommit);
    } else if (withinRoot(parent, folder) && parent !== '') {
      const name = (folder ? parent.slice(folder.length + 1) : parent).split('/')[0];
      const path = folder ? `${folder}/${name}` : name;
      if (!dirsByPath.has(path)) dirsByPath.set(path, { name, path });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  state.folders = [...dirsByPath.values()].sort(byName);
  state.chapters = [...byPath.values()].sort(byName);
  renderChapterList();
}

/** Build one drawer row; returns the <li> ready to append. */
function listItem(className, label, onClick) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.className = className;

  const name = document.createElement('span');
  name.className = 'chapter-name';
  name.textContent = label;
  btn.appendChild(name);

  btn.addEventListener('click', onClick);
  li.appendChild(btn);
  return li;
}

function renderChapterList() {
  const list = $('chapter-list');
  list.innerHTML = '';

  const root = rootFolder();
  const folder = state.folder ?? root;

  // Show where we are (relative to the configured root) while in a subfolder.
  const crumb = $('folder-path');
  const rel = folder === root ? '' : root ? folder.slice(root.length + 1) : folder;
  crumb.textContent = rel;
  crumb.hidden = !rel;

  if (folder !== root) {
    const parent = parentOf(folder);
    const label = parent === root
      ? (root ? parent.split('/').pop() : 'repo root')
      : parent.split('/').pop();
    list.appendChild(
      listItem('chapter-item folder-item back-item', `‹ ${label}`, () => openFolder(parent))
    );
  }

  for (const dir of state.folders) {
    list.appendChild(
      listItem('chapter-item folder-item', `📁 ${dir.name}`, () => openFolder(dir.path))
    );
  }

  if (state.chapters.length === 0) {
    const li = document.createElement('li');
    li.className = 'chapter-empty';
    li.textContent = state.folders.length || folder !== root
      ? 'No chapters in this folder.'
      : 'No chapters yet — create your first one below.';
    list.appendChild(li);
    return;
  }

  for (const ch of state.chapters) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'chapter-item';
    if (state.current?.path === ch.path) btn.classList.add('active');

    const name = document.createElement('span');
    name.className = 'chapter-name';
    name.textContent = ch.name.replace(/\.txt$/i, '');
    btn.appendChild(name);

    if (ch.queued || ch.dirty || ch.localOnly) {
      const badge = document.createElement('span');
      badge.className = 'chapter-badge';
      badge.textContent = ch.queued ? 'queued' : ch.localOnly ? 'local' : 'edited';
      btn.appendChild(badge);
    }

    btn.addEventListener('click', () => {
      ui.closeDrawer();
      openChapter(ch.path);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

/* ================================================================ *
 * Folder navigation
 * ================================================================ */

/** Browse into a folder (the drawer stays open) and remember the spot. */
async function openFolder(path) {
  state.folder = path;
  store.lastFolder.set(path);
  await refreshChapters();
}

/* ================================================================ *
 * Opening chapters
 * ================================================================ */

/**
 * Open a chapter. Local dirty drafts win over the remote copy (they hold
 * unpushed writing); otherwise the freshest remote content is loaded.
 * With forceRemote=true the local draft is discarded (conflict "reload").
 */
async function openChapter(path, { forceRemote = false } = {}) {
  autosave.flush(); // never drop pending keystrokes from the previous chapter
  scrollsave.flush(); // ...nor the reading position we were at

  const name = path.split('/').pop();
  let draft = await store.drafts.get(path);

  if (forceRemote || !draft || !draft.dirty) {
    try {
      const remote = await gh.getFile(cfg(), tok(), path);
      draft = {
        path,
        name,
        content: remote.content,
        sha: remote.sha,
        dirty: false,
        savedAt: Date.now(),
        committedAt: draft && draft.sha === remote.sha ? draft.committedAt : null,
        pendingCommit: forceRemote ? null : draft?.pendingCommit || null,
        scroll: draft?.scroll || 0, // reading position survives a re-fetch
      };
      await store.drafts.put(draft);
    } catch (err) {
      if (draft && !forceRemote) {
        ui.toast('Could not reach GitHub — opened the local copy.');
      } else {
        ui.toast(err.message, { duration: 7000 });
        return;
      }
    }
  }

  state.current = draft;
  store.lastOpen.set(path);
  renderEditor();
  renderChapterList();
}

/* ================================================================ *
 * Editor + status bar
 * ================================================================ */

function renderEditor() {
  const editor = $('editor');
  const hasDoc = Boolean(state.current);

  $('empty-state').hidden = hasDoc;
  editor.hidden = !hasDoc;
  $('commit-btn').disabled = !hasDoc;
  $('focus-btn').disabled = !hasDoc;
  $('chapter-title').textContent = hasDoc
    ? state.current.name.replace(/\.txt$/i, '')
    : 'Chapters';

  if (hasDoc) {
    editor.value = state.current.content;
    restoreScroll();
  }
  renderStatus();
}

/* ---- Rough scroll-position memory (per chapter, stored on the draft) ---- */

/** Current scroll as a 0..1 fraction of the scrollable range. */
function scrollFraction(editor) {
  const range = editor.scrollHeight - editor.clientHeight;
  return range > 0 ? Math.min(1, editor.scrollTop / range) : 0;
}

/** Put the editor back where the draft says we were. Rough is fine. */
function restoreScroll() {
  const editor = $('editor');
  const fraction = state.current?.scroll || 0;
  // Wait a frame so the just-unhidden textarea has real layout to measure.
  requestAnimationFrame(() => {
    editor.scrollTop = fraction * Math.max(0, editor.scrollHeight - editor.clientHeight);
  });
}

/** Persist without stamping savedAt — scrolling isn't a content change. */
async function saveScrollNow() {
  if (state.current) await store.drafts.put(state.current);
}

const scrollsave = makeDebouncer(saveScrollNow, 1500);

function onEditorScroll() {
  if (!state.current) return;
  state.current.scroll = scrollFraction($('editor'));
  scrollsave();
}

function renderStatus() {
  const doc = state.current;
  $('stats').textContent = doc ? formatStats(computeStats(doc.content)) : '';

  const dot = $('sync-dot');
  const label = $('sync-label');
  if (!doc) {
    dot.className = 'sync-dot';
    label.textContent = state.online ? '' : 'Offline';
    return;
  }

  const time = (ms) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (doc.pendingCommit) {
    dot.className = 'sync-dot queued';
    label.textContent = 'Commit queued';
  } else if (doc.dirty || !doc.sha) {
    dot.className = 'sync-dot dirty';
    label.textContent = `Saved ${time(doc.savedAt)} · uncommitted`;
  } else {
    dot.className = 'sync-dot synced';
    label.textContent = doc.committedAt
      ? `Committed ${time(doc.committedAt)}`
      : 'In sync with GitHub';
  }
  if (!state.online) label.textContent += ' · offline';
}

/** Persist the current draft to IndexedDB. Called via the debouncer. */
async function saveDraftNow() {
  const doc = state.current;
  if (!doc) return;
  doc.savedAt = Date.now();
  await store.drafts.put(doc);
  renderStatus();
}

const autosave = makeDebouncer(saveDraftNow, 700);

function onEditorInput() {
  const doc = state.current;
  if (!doc) return;
  doc.content = $('editor').value;
  if (!doc.dirty) {
    doc.dirty = true;
    renderChapterList();
  }
  renderStatus();
  autosave();
}

/* ================================================================ *
 * Committing
 * ================================================================ */

async function onCommitClick() {
  const doc = state.current;
  if (!doc) return;
  autosave.flush();

  $('commit-message').value =
    doc.pendingCommit?.message || `Update ${doc.name}`;
  $('commit-share').hidden = !navigator.share;

  const result = await ui.openDialog('commit-dialog');
  if (result === 'share') return shareChapter();
  if (result !== 'commit') return;

  await commitDraft(doc, $('commit-message').value.trim() || `Update ${doc.name}`);
}

/**
 * Commit one draft to GitHub. Offline commits are queued on the draft and
 * offered again when connectivity returns.
 */
async function commitDraft(doc, message) {
  if (!navigator.onLine) {
    doc.pendingCommit = { message, queuedAt: Date.now() };
    await store.drafts.put(doc);
    setOnline(false);
    renderStatus();
    renderChapterList();
    ui.toast('You are offline — commit queued until you reconnect.');
    return;
  }

  try {
    const res = await gh.putFile(
      cfg(), tok(), doc.path, doc.content, message, doc.sha || undefined
    );
    doc.sha = res.sha;
    doc.dirty = false;
    doc.committedAt = Date.now();
    doc.pendingCommit = null;
    await store.drafts.put(doc);
    setOnline(true);
    renderStatus();
    renderChapterList();
    ui.toast('Committed to GitHub ✓');
  } catch (err) {
    if (err.kind === 'conflict') {
      await handleConflict(doc, message);
    } else if (err.kind === 'offline') {
      doc.pendingCommit = { message, queuedAt: Date.now() };
      await store.drafts.put(doc);
      setOnline(false);
      renderStatus();
      ui.toast('Could not reach GitHub — commit queued.');
    } else {
      ui.toast(err.message, { duration: 8000 });
    }
  }
}

/** The file changed on GitHub since we last saw it: overwrite or reload? */
async function handleConflict(doc, message) {
  const choice = await ui.openDialog('conflict-dialog');
  if (choice === 'overwrite') {
    try {
      // Re-fetch just for the fresh sha, then push our content over it.
      const remote = await gh.getFile(cfg(), tok(), doc.path);
      const res = await gh.putFile(
        cfg(), tok(), doc.path, doc.content, message, remote.sha
      );
      doc.sha = res.sha;
      doc.dirty = false;
      doc.committedAt = Date.now();
      doc.pendingCommit = null;
      await store.drafts.put(doc);
      renderStatus();
      ui.toast('Overwrote the GitHub version ✓');
    } catch (err) {
      ui.toast(err.message, { duration: 8000 });
    }
  } else if (choice === 'reload') {
    await openChapter(doc.path, { forceRemote: true });
    ui.toast('Reloaded from GitHub — local changes discarded.');
  }
  // 'cancel': keep writing; the draft stays safely in IndexedDB.
}

/** When back online, offer to push any commits that were queued offline. */
async function flushQueuedCommits() {
  const queued = (await store.drafts.all()).filter((d) => d.pendingCommit);
  for (const d of queued) {
    // Re-point at the live object if it's the open chapter, so UI updates.
    const doc = state.current?.path === d.path ? state.current : d;
    await commitDraft(doc, d.pendingCommit.message);
  }
  await refreshChapters();
}

/* ================================================================ *
 * New chapter
 * ================================================================ */

function slugify(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents left by NFD
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function suggestFilename(title) {
  // Next number after the highest existing "NN-" prefix (or the count).
  let max = 0;
  for (const ch of state.chapters) {
    const m = ch.name.match(/^(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const n = String(Math.max(max, state.chapters.length) + 1).padStart(2, '0');
  return `${n}-${slugify(title) || 'untitled'}.txt`;
}

async function onNewChapterClick() {
  const titleInput = $('new-title');
  const fileInput = $('new-filename');
  titleInput.value = '';
  fileInput.value = suggestFilename('');
  let fileEdited = false;

  // New chapters land in the folder currently being browsed.
  const folder = state.folder ?? rootFolder();
  $('new-chapter-location').textContent = folder ? `Will be created in ${folder}/` : '';
  $('new-chapter-location').hidden = !folder;

  const onTitle = () => {
    if (!fileEdited) fileInput.value = suggestFilename(titleInput.value);
  };
  const onFile = () => { fileEdited = true; };
  titleInput.addEventListener('input', onTitle);
  fileInput.addEventListener('input', onFile);

  const result = await ui.openDialog('new-chapter-dialog');
  titleInput.removeEventListener('input', onTitle);
  fileInput.removeEventListener('input', onFile);
  if (result !== 'create') return;

  let name = fileInput.value.trim();
  if (!name) return;
  if (!name.toLowerCase().endsWith('.txt')) name += '.txt';
  const path = gh.joinPath(folder, name);

  if (state.chapters.some((c) => c.path === path)) {
    ui.toast('A chapter with that filename already exists.');
    return;
  }

  const draft = {
    path,
    name,
    content: '',
    sha: null,
    dirty: true,
    savedAt: Date.now(),
    committedAt: null,
    pendingCommit: null,
    scroll: 0,
  };

  if (navigator.onLine) {
    try {
      const res = await gh.putFile(cfg(), tok(), path, '', `Create ${name}`);
      draft.sha = res.sha;
      draft.dirty = false;
      draft.committedAt = Date.now();
    } catch (err) {
      if (err.kind !== 'offline') {
        ui.toast(err.message, { duration: 8000 });
        return;
      }
      ui.toast('Offline — chapter created locally; commit it when back online.');
    }
  } else {
    ui.toast('Offline — chapter created locally; commit it when back online.');
  }

  await store.drafts.put(draft);
  state.current = draft;
  store.lastOpen.set(path);
  ui.closeDrawer();
  await refreshChapters();
  renderEditor();
  $('editor').focus();
}

/* ================================================================ *
 * Share (manual fallback to committing)
 * ================================================================ */

async function shareChapter() {
  const doc = state.current;
  if (!doc || !navigator.share) return;
  const file = new File([doc.content], doc.name, { type: 'text/plain' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: doc.name });
    } else {
      await navigator.share({ title: doc.name, text: doc.content });
    }
  } catch {
    /* user cancelled the share sheet — not an error */
  }
}

/* ================================================================ *
 * Typography panel
 * ================================================================ */

function initTypographyPanel() {
  const p = store.prefs.get();

  // Segmented controls (theme + font) — radio inputs in the markup.
  document.querySelectorAll('input[name="pref-theme"]').forEach((r) => {
    r.checked = r.value === p.theme;
    r.addEventListener('change', () => {
      store.prefs.set({ theme: r.value });
      ui.applyTheme(r.value);
    });
  });
  document.querySelectorAll('input[name="pref-font"]').forEach((r) => {
    r.checked = r.value === p.font;
    r.addEventListener('change', () => {
      store.prefs.set({ font: r.value });
      applyTypography(store.prefs.get());
    });
  });

  // Sliders.
  const bindSlider = (id, key, format) => {
    const input = $(id);
    const out = $(id + '-value');
    input.value = p[key];
    out.textContent = format(p[key]);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = format(v);
      store.prefs.set({ [key]: v });
      applyTypography(store.prefs.get());
    });
  };
  bindSlider('pref-size', 'fontSize', (v) => `${v}px`);
  bindSlider('pref-leading', 'lineHeight', (v) => v.toFixed(2));
  bindSlider('pref-measure', 'maxWidth', (v) => `${v}ch`);
}

/* ================================================================ *
 * Connectivity + service worker
 * ================================================================ */

function setOnline(online) {
  if (state.online === online) return;
  state.online = online;
  document.body.classList.toggle('offline', !online);
  renderStatus();
}

function onBackOnline() {
  setOnline(true);
  store.drafts.all().then((all) => {
    const queued = all.filter((d) => d.pendingCommit);
    if (queued.length > 0) {
      ui.toast(
        `Back online — ${queued.length} queued commit${queued.length > 1 ? 's' : ''}.`,
        { action: { label: 'Commit now', onClick: flushQueuedCommits } }
      );
    }
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    // Relative path so it works from a GitHub Pages subdirectory.
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is a progressive enhancement */
    });
  }
}

/* ================================================================ *
 * Event wiring
 * ================================================================ */

function wireEvents() {
  $('editor').addEventListener('input', onEditorInput);
  $('editor').addEventListener('scroll', onEditorScroll, { passive: true });

  $('menu-btn').addEventListener('click', ui.openDrawer);
  $('scrim').addEventListener('click', ui.closeDrawer);
  $('refresh-btn').addEventListener('click', refreshChapters);
  $('settings-btn').addEventListener('click', showSetup);
  $('new-chapter-btn').addEventListener('click', onNewChapterClick);
  $('commit-btn').addEventListener('click', onCommitClick);
  $('typo-btn').addEventListener('click', () => ui.openDialog('typography-dialog'));

  $('focus-btn').addEventListener('click', () => ui.setFocusMode(true));
  $('focus-exit').addEventListener('click', () => ui.setFocusMode(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.isFocusMode()) ui.setFocusMode(false);
    // Ctrl/Cmd+S commits — writers expect "save" to mean the real thing.
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      onCommitClick();
    }
  });

  window.addEventListener('online', onBackOnline);
  window.addEventListener('offline', () => setOnline(false));

  // Don't lose the last keystrokes (or reading position) when the tab is
  // backgrounded or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      autosave.flush();
      scrollsave.flush();
    }
  });
  window.addEventListener('pagehide', () => {
    autosave.flush();
    scrollsave.flush();
  });

  initTypographyPanel();
}

boot();
