/**
 * Theme preference shared between `ThemeToggle` (floating quick-switch) and
 * the Settings → General "Theme" field. Purely client-side — there is no
 * server-side theme setting, it's a per-browser preference in localStorage.
 * `index.html`'s inline script mirrors the same "explicit pref, else system"
 * logic before first paint so there's no flash of the wrong theme.
 */
export type ThemePref = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'lds-theme';

/** The stored preference, or 'system' if none was ever set (or storage is unavailable). */
export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Applies a preference: sets/clears `data-theme` on <html> and persists (or clears) it. */
export function applyThemePref(pref: ThemePref): void {
  if (pref === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = pref;
  }
  try {
    if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* storage unavailable — theme just won't persist across reloads */
  }
}

/** The actually-rendered theme right now — 'system' resolved via prefers-color-scheme. */
export function resolvedTheme(): 'light' | 'dark' {
  const pref = getThemePref();
  if (pref !== 'system') return pref;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}
