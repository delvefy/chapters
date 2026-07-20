/**
 * ui.js — presentation plumbing shared across the app:
 * theme, drawer (with edge-swipe on touch), toasts, focus mode, dialogs.
 */

import { prefs } from './storage.js';

/* ---------------------------------------------------------------- *
 * Theme
 * ---------------------------------------------------------------- */

/**
 * theme = 'auto' | 'light' | 'dark'. 'auto' removes the attribute so the
 * prefers-color-scheme media queries in CSS take over.
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  syncThemeColorMeta();
}

/** Keep the browser chrome color in sync with the effective theme. */
function syncThemeColorMeta() {
  const dark =
    document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.hasAttribute('data-theme') &&
      matchMedia('(prefers-color-scheme: dark)').matches);
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute('content', dark ? '#14161c' : '#f7f4ef'));
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (prefs.get().theme === 'auto') syncThemeColorMeta();
});

/* ---------------------------------------------------------------- *
 * Drawer
 * ---------------------------------------------------------------- */

const drawer = () => document.getElementById('drawer');
const scrim = () => document.getElementById('scrim');

export function openDrawer() {
  drawer().classList.add('open');
  scrim().hidden = false;
}

export function closeDrawer() {
  drawer().classList.remove('open');
  scrim().hidden = true;
}

export function isDrawerOpen() {
  return drawer().classList.contains('open');
}

/**
 * Edge-swipe to open, swipe-left to close. Intentionally simple:
 * a mostly-horizontal move of >60px does it.
 */
export function initDrawerGestures() {
  let startX = null;
  let startY = null;
  let fromEdge = false;

  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    fromEdge = t.clientX < 28;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    startX = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
    if (dx > 0 && fromEdge && !isDrawerOpen()) openDrawer();
    else if (dx < 0 && isDrawerOpen()) closeDrawer();
  }, { passive: true });
}

/* ---------------------------------------------------------------- *
 * Toasts
 * ---------------------------------------------------------------- */

/**
 * Show a transient message. Pass { action: { label, onClick } } for a
 * tappable action (e.g. "Commit now" when back online).
 */
export function toast(message, { action, duration = 4000 } = {}) {
  const region = document.getElementById('toast-region');
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      dismiss();
      action.onClick();
    });
    el.appendChild(btn);
    duration = Math.max(duration, 8000); // give actions time to be seen
  }

  const dismiss = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  };
  region.appendChild(el);
  setTimeout(dismiss, duration);
}

/* ---------------------------------------------------------------- *
 * Focus mode
 * ---------------------------------------------------------------- */

export function setFocusMode(on) {
  document.body.classList.toggle('focus-mode', on);
  document.getElementById('focus-exit').hidden = !on;
  if (on) closeDrawer();
}

export function isFocusMode() {
  return document.body.classList.contains('focus-mode');
}

/* ---------------------------------------------------------------- *
 * Dialogs
 * ---------------------------------------------------------------- */

/**
 * Open a <dialog> and resolve with the value of the button that closed it
 * (buttons use value="..." + formmethod=dialog), or 'cancel' on Esc/backdrop.
 */
export function openDialog(id) {
  const dlg = document.getElementById(id);
  dlg.returnValue = 'cancel';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue || 'cancel'), { once: true });
  });
}

/**
 * Dialog affordances the platform doesn't give us:
 *  - tap on the backdrop closes (native only handles Esc);
 *  - buttons marked type="button" with a value close the dialog with that
 *    value. They're not submit buttons on purpose — only the primary action
 *    should respond to Enter (and skip form validation for cancels).
 */
export function initDialogDismissal() {
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close('cancel');
    });
    dlg.querySelectorAll('button[type="button"][value]').forEach((btn) => {
      btn.addEventListener('click', () => dlg.close(btn.value));
    });
  });
}
