import { useEffect, useState } from 'react';

// Must match the inline <head> script in each page.
export const THEME_KEY = 'sv.theme';

const stored = () => {
  try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; }
};
const system = () => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

export function applyTheme(t) {
  const d = document.documentElement;
  d.dataset.theme = t;
  d.style.colorScheme = t;
}

export function currentTheme() {
  return document.documentElement.dataset.theme || stored() || system();
}

export function setTheme(t) {
  try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode: still applies for this page */ }
  applyTheme(t);
  window.dispatchEvent(new CustomEvent('sv-theme', { detail: t }));
}

/** The resolved theme, kept in sync with the toggle, other tabs and the OS setting. */
export function useTheme() {
  const [theme, set] = useState(currentTheme);
  useEffect(() => {
    if (!document.documentElement.dataset.theme) applyTheme(theme);
    const onToggle = (e) => set(e.detail);
    const onStorage = (e) => {
      if (e.key !== THEME_KEY) return;
      const t = e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : system();
      applyTheme(t); set(t);
    };
    // Follow the OS only until someone picks a theme explicitly.
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystem = () => { if (!stored()) { const t = system(); applyTheme(t); set(t); } };
    window.addEventListener('sv-theme', onToggle);
    window.addEventListener('storage', onStorage);
    mq?.addEventListener?.('change', onSystem);
    return () => {
      window.removeEventListener('sv-theme', onToggle);
      window.removeEventListener('storage', onStorage);
      mq?.removeEventListener?.('change', onSystem);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return [theme, setTheme];
}
