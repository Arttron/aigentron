import { useEffect, useState } from 'react';
import { applyThemePref, resolvedTheme } from '@/lib/theme';
import styles from './ThemeToggle.module.css';

/**
 * Floating dark/cream quick-switch. Always picks an explicit theme (no
 * "system" option here — that's a deliberate, three-way choice, available in
 * Settings → General instead). `index.html`'s inline script already set
 * `data-theme` on <html> before first paint; this mirrors that into state.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    setTheme(resolvedTheme());
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyThemePref(next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={toggle}
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label="Toggle color theme"
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}
