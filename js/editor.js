/**
 * editor.js — the writing surface itself: typography, stats, autosave timing.
 * Deliberately knows nothing about GitHub or app state.
 */

const FONT_STACKS = {
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

/** Push typography prefs into CSS variables on the editor. */
export function applyTypography(prefsValue) {
  const root = document.documentElement;
  root.style.setProperty('--editor-font', FONT_STACKS[prefsValue.font] || FONT_STACKS.serif);
  root.style.setProperty('--editor-size', `${prefsValue.fontSize}px`);
  root.style.setProperty('--editor-leading', String(prefsValue.lineHeight));
  root.style.setProperty('--editor-measure', `${prefsValue.maxWidth}ch`);
}

/**
 * Word/character counts and a rough reading time.
 * ~230 wpm is a common silent-reading average.
 */
export function computeStats(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const minutes = Math.max(1, Math.round(words / 230));
  return { words, chars, minutes };
}

export function formatStats({ words, chars, minutes }) {
  const fmt = (n) => n.toLocaleString();
  if (words === 0) return 'Empty';
  return `${fmt(words)} words · ${fmt(chars)} chars · ~${minutes} min`;
}

/**
 * Debounce factory for autosave: fires `fn` after `delay` ms of quiet,
 * with a .flush() to force a pending save immediately (used on tab hide,
 * chapter switch and before committing).
 */
export function makeDebouncer(fn, delay = 700) {
  let timer = null;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delay);
  };
  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      fn();
    }
  };
  return debounced;
}
