// Single source of truth for the product name. The brand board's wordmark reads «لمحة / LAMHA»;
// the product ships as «لمحة / Lamha» (renamed from «نظرة / Nazra» on 2026-10-24). To rename: change these two strings, then run
// `node src/brand/sync-name.mjs` (from nazra/web) to update index.html <title>/splash + the manifest.
export const BRAND = { nameAr: 'لمحة', nameEn: 'Lamha' } as const;

/** Exact brand-board palette (logo assets). Theme tokens live in styles.css :root. */
export const BRAND_COLORS = {
  red: '#B42D25', // Passion / Health / Energy
  coral: '#D3543C', // Care / Warmth / Trust
  taupe: '#B9A690', // Balance / Calm / Reliability
  offWhite: '#F8F6F3', // Purity / Clarity
  redDark: '#9E2415',
  redMid: '#AB3320',
  taupeGrey: '#927B6D',
  taupeGrey2: '#A59086',
} as const;

export const brandTitle = () => `${BRAND.nameAr} · ${BRAND.nameEn}`;
