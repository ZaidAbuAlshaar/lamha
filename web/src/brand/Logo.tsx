import { useEffect, useState } from 'react';
import { BRAND, brandTitle } from './brand';
import { currentTheme, setTheme, storedTheme, type Theme } from './theme';
import './brand.css';

if (typeof document !== 'undefined') document.title = brandTitle();

/** The mark only (camera-frame brackets + heart ribbon + pulse), never the traced «لمحة» wordmark.
 *  Light: full-colour mark. Dark: white mark on a solid brand-red tile (brand board variation). */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      <img className="mk-color" src="/brand/mark.svg" alt="" width={size} height={size} loading="lazy" decoding="async" />
      <img className="mk-white" src="/brand/mark-white.svg" alt="" width={size} height={size} loading="lazy" decoding="async" />
    </span>
  );
}

export function ThemeToggle() {
  const [t, setT] = useState<Theme>(() => currentTheme());
  useEffect(() => {
    if (storedTheme()) return;
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const on = () => setT(currentTheme());
    mq.addEventListener('change', on);
    return () => mq?.removeEventListener('change', on);
  }, []);
  const next: Theme = t === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => { setTheme(next); setT(next); }}
      aria-label={next === 'dark' ? 'الوضع الداكن' : 'الوضع الفاتح'}
      title={next === 'dark' ? 'الوضع الداكن' : 'الوضع الفاتح'}
    >
      <span aria-hidden>{t === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}

export function Brand() {
  return (
    <div className="brand-row">
      <a className="brand" href="#/" aria-label={`${BRAND.nameAr} ${BRAND.nameEn}`}>
        <Logo size={34} />
        <span className="brand-name">{BRAND.nameAr}</span>
        <span className="brand-en" lang="en">{BRAND.nameEn}</span>
      </a>
      <ThemeToggle />
    </div>
  );
}
