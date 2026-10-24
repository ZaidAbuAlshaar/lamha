// Light/dark switching: system preference by default, explicit choice persisted in localStorage.
// index.html applies the stored choice before first paint (same key) so there is no flash.
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'nazra-theme';
const META = { light: '#F8F6F3', dark: '#1C1816' } as const;

export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function currentTheme(): Theme {
  const a = document.documentElement.getAttribute('data-theme');
  return a === 'light' || a === 'dark' ? a : systemTheme();
}

export function setTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* private mode: choice lasts for this page only */
  }
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', META[t]));
}
