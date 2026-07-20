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
  chapters: [],   // [{ name, path, sha?, size?, localOnly?, dirty? }]
  current: null,  // active draft record (see storage.js for shape)
  online: navigator.onLine,
};

const cfg = () => store.settings.get();
const tok = () => store.token.get();

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
  state.current = null;
  await showApp();
}

async function showApp() {
  $('app-screen').hidden = false;
  renderEditor();
  await refreshChapters();

  // Restore the chapter that was open last time, if it still exists.
  const last = store.lastOpen.get();
  if (!state.current && last && state.chapters.some((c) => c.path === last)) {
    await openChapter(last);
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
  const localDrafts = await store.drafts.all();
  const byPath = new Map();

  try {
    const remote = await gh.listChapters(cfg(), tok());
    remote.forEach((c) => byPath.set(c.path, c));
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
  // or listed while offline) still belong in the list.
  for (const d of localDrafts) {
    if (!byPath.has(d.path)) {
      byPath.set(d.path, { name: d.name, path: d.path, localOnly: !d.sha });
    }
  }
  for (const d of localDrafts) {
    const entry = byPath.get(d.path);
    entry.dirty = d.dirty;
    entry.queued = Boolean(d.pendingCommit);
  }

  state.chapters = [...byPath.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );
  renderChapterList();
}

function renderChapterList() {
  const list = $('chapter-list');
  list.innerHTML = '';

  if (state.chapters.length === 0) {
    const li = document.createElement('li');
    li.className = 'chapter-empty';
    li.textContent = 'No chapters yet — create your first one below.';
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
 * Opening chapters
 * ================================================================ */

/**
 * Open a chapter. Local dirty drafts win over the remote copy (they hold
 * unpushed writing); otherwise the freshest remote content is loaded.
 * With forceRemote=true the local draft is discarded (conflict "reload").
 */
async function openChapter(path, { forceRemote = false } = {}) {
  autosave.flush(); // never drop pending keystrokes from the previous chapter

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
  }
  renderStatus();
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
  const path = gh.chapterPath(cfg(), name);

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

  // Don't lose the last keystrokes when the tab is backgrounded or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave.flush();
  });
  window.addEventListener('pagehide', () => autosave.flush());

  initTypographyPanel();
}

boot();
