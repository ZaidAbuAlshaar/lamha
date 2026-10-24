# Lamha design tokens (brand workstream)

Generated from `src/styles.css` by computing WCAG 2.x relative-luminance contrast (no estimates).
Names are fixed by `docs/CONTRACTS-v2.md`; values below are the source of truth.
Light is the default; dark applies via `prefers-color-scheme: dark` or `html[data-theme="dark"]`
(`data-theme="light"` forces light). The theme toggle (☀/☾ in the Brand lockup) persists the choice in
localStorage key `nazra-theme`.

Brand board palette (logo assets, `src/brand/brand.ts`): red `#B42D25` (Passion/Health/Energy),
coral `#D3543C` (Care/Warmth/Trust), taupe `#B9A690` (Balance/Calm/Reliability), off-white `#F8F6F3`
(Purity/Clarity); logo shades `#9E2415` `#AB3320`, taupe greys `#927B6D` `#A59086`.

## Tokens

| token | role | light | dark |
|---|---|---|---|
| `--bg` | page background | `#F8F6F3` | `#1C1816` |
| `--bg-2` | inputs, doctor top bar | `#F1EDE8` | `#221D1B` |
| `--panel` | cards | `#FFFFFF` | `#28221F` |
| `--panel-2` | selected/raised surfaces, chips | `#F4F0EB` | `#302926` |
| `--line` | hairlines | `#E5DED6` | `#3D3430` |
| `--line-2` | control borders | `#D2C7BC` | `#4E433E` |
| `--text` | body text | `#221C19` | `#F4EFEA` |
| `--muted` | secondary text | `#5F534C` | `#C2B5AB` |
| `--dim` | tertiary text (disclaimers, empty states) | `#6E625A` | `#AA9C91` |
| `--brand` | primary buttons, active states, focus rings | `#B42D25` | `#E9785E` |
| `--brand-2` | coral: decorative only (not for text) | `#D3543C` | `#D3543C` |
| `--brand-ink` | text-safe brand red (links, emphasis) | `#9E2415` | `#F09A84` |
| `--accent` | taupe: secondary accent (text-safe) | `#7A6556` | `#B9A690` |
| `--on-brand` | text on --brand | `#FFFFFF` | `#1C1210` |
| `--hr` | vital: pulse | `#0F6E66` | `#5CC8BC` |
| `--rr` | vital: respiration | `#36569E` | `#93ABEB` |
| `--hrv` | vital: HRV/stress | `#7A4688` | `#CDA2DE` |
| `--emg` | triage: emergency (red, distinct from brand brick red; always with text) | `#C8102E` | `#FF7A85` |
| `--apt` | triage: appointment (amber) | `#8A5300` | `#F0B44C` |
| `--fu` | triage: follow-up (green) | `#2C7334` | `#7BCB82` |
| `--radius` | corner radius | 14px | 14px |
| `--font` | IBM Plex Sans Arabic (bundled) | | |
| `--mono` | IBM Plex Mono (numbers) | | |

## Contrast: text tokens on every surface (AA needs ≥ 4.5:1)

Worst case = lowest ratio across `--bg`, `--bg-2`, `--panel`, `--panel-2`.

| token | light: bg / bg-2 / panel / panel-2 | light worst | dark: bg / bg-2 / panel / panel-2 | dark worst |
|---|---|---|---|---|
| `--text` | 15.60 / 14.44 / 16.82 / 14.83 | **14.44** | 15.43 / 14.59 / 13.73 / 12.50 | **12.50** |
| `--muted` | 6.88 / 6.37 / 7.43 / 6.54 | **6.37** | 8.80 / 8.33 / 7.84 / 7.13 | **7.13** |
| `--dim` | 5.47 / 5.06 / 5.90 / 5.20 | **5.06** | 6.61 / 6.25 / 5.88 / 5.35 | **5.35** |
| `--brand` | 5.82 / 5.39 / 6.28 / 5.54 | **5.39** | 6.14 / 5.81 / 5.46 / 4.97 | **4.97** |
| `--brand-ink` | 7.17 / 6.63 / 7.73 / 6.81 | **6.63** | 8.11 / 7.67 / 7.22 / 6.57 | **6.57** |
| `--accent` | 5.09 / 4.71 / 5.49 / 4.84 | **4.71** | 7.49 / 7.08 / 6.66 / 6.06 | **6.06** |
| `--hr` | 5.66 / 5.23 / 6.10 / 5.38 | **5.23** | 8.76 / 8.29 / 7.80 / 7.10 | **7.10** |
| `--rr` | 6.53 / 6.04 / 7.04 / 6.21 | **6.04** | 7.78 / 7.36 / 6.92 / 6.30 | **6.30** |
| `--hrv` | 6.36 / 5.89 / 6.86 / 6.05 | **5.89** | 8.24 / 7.80 / 7.33 / 6.68 | **6.68** |
| `--emg` | 5.45 / 5.05 / 5.88 / 5.19 | **5.05** | 7.03 / 6.65 / 6.26 / 5.69 | **5.69** |
| `--apt` | 5.87 / 5.43 / 6.33 / 5.58 | **5.43** | 9.51 / 9.00 / 8.47 / 7.71 | **7.71** |
| `--fu` | 5.39 / 4.99 / 5.82 / 5.13 | **4.99** | 8.99 / 8.50 / 8.00 / 7.28 | **7.28** |

## Contrast: component pairs

| pair | light | dark |
|---|---|---|
| `--on-brand` on `--brand` (primary button) | 6.28 | 6.40 |
| `--bg` on `--emg` (danger button) | 5.45 | 7.03 |
| `--emg` on emergency triage tint (9% emg over panel) | 5.02 | 5.41 |
| `--text` on emergency triage tint | 14.37 | 11.88 |
| `--apt` on appointment tint (9%) | 5.57 | 7.04 |
| `--fu` on follow-up tint (8%) | 5.22 | 6.81 |
| `--text` on `.err` (8% emg over panel) | 14.69 | 12.09 |

## Notes
- `--brand-2` (coral `#D3543C`) is 4.12:1 on white and 3.81:1 on `#F8F6F3`, so it is decorative only (fills, illustrations), never body text. Raw taupe `#B9A690` is 2.35:1 on white, hence `--accent` uses a darkened taupe in light mode.
  In dark, `--brand` is lifted to `#E9785E` so it passes AA as text on every dark surface; its button text
  (`--on-brand`) is then a warm near-black.
- Emergency `--emg` (light `#C8102E`, dark `#FF7A85`) differs from brand brick red `#B42D25` and is always
  paired with a label/icon (triage chip dot + text, card heading), never colour alone.
- The camera view (`.cam`) is always dark, so it re-scopes the dark text/vital tokens locally; HUD pills sit on
  `rgba(28,24,22,.82)`.
- Disabled buttons (opacity .45) are exempt from AA (WCAG 1.4.3 inactive components).
- Logo: light = full-colour mark (`public/brand/mark.svg`); dark = white mark (`mark-white.svg`) on a solid
  `#B42D25` tile; `mark-mono.svg` = single `#B42D25`. App icons = mark on a white rounded square.
- Patient app (`.app`): base font 18px; buttons, pick rows, consent check, inputs and the theme toggle ≥ 56px tall.

All listed text pairs pass WCAG AA (≥ 4.5:1).
