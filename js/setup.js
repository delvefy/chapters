/**
 * setup.js — the first-run / settings screen: token + repo configuration.
 * Validates the config against the GitHub API before saving.
 */

import * as gh from './github.js';
import { settings, token, isConfigured } from './storage.js';
import { toast } from './ui.js';

let onSavedCallback = () => {};

const el = (id) => document.getElementById(id);

export function initSetup({ onSaved }) {
  onSavedCallback = onSaved;

  el('setup-form').addEventListener('submit', onSubmit);
  el('setup-cancel').addEventListener('click', () => {
    el('setup-screen').hidden = true;
    el('app-screen').hidden = false;
  });

  // Password-style token field with a show/hide toggle.
  el('token-toggle').addEventListener('click', () => {
    const input = el('setup-token');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el('token-toggle').textContent = show ? 'Hide' : 'Show';
  });
}

/**
 * Show the setup screen. When already configured it acts as a settings
 * screen: fields are prefilled and a Cancel button appears.
 */
export function showSetup() {
  const s = settings.get() || {};
  el('setup-token').value = token.get() || '';
  el('setup-owner').value = s.owner || '';
  el('setup-repo').value = s.repo || '';
  el('setup-branch').value = s.branch || 'main';
  el('setup-folder').value = s.folder || '';

  const configured = isConfigured();
  el('setup-cancel').hidden = !configured;
  el('setup-heading').textContent = configured ? 'Settings' : 'Welcome to Chapters';
  el('setup-intro').hidden = configured;

  el('app-screen').hidden = true;
  el('setup-screen').hidden = false;
}

async function onSubmit(e) {
  e.preventDefault();

  const cfg = {
    owner: el('setup-owner').value.trim(),
    repo: el('setup-repo').value.trim(),
    branch: el('setup-branch').value.trim() || 'main',
    folder: gh.normalizeFolder(el('setup-folder').value),
  };
  const tok = el('setup-token').value.trim();

  const btn = el('setup-save');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    // One cheap API call to confirm the token can at least see the repo.
    // (Write access is only exercised on the first commit.)
    await gh.validateRepo(cfg, tok);
    settings.set(cfg);
    token.set(tok);
    el('setup-screen').hidden = true;
    onSavedCallback();
  } catch (err) {
    if (err.kind === 'offline') {
      // Can't validate offline — save anyway so writing can start.
      settings.set(cfg);
      token.set(tok);
      toast('Saved without validation — you appear to be offline.');
      el('setup-screen').hidden = true;
      onSavedCallback();
    } else {
      toast(err.message, { duration: 7000 });
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & connect';
  }
}
