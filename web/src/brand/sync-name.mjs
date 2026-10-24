// Propagate BRAND (src/brand/brand.ts) into the static files that can't import TS:
// index.html (<title>, apple title, splash) and public/manifest.webmanifest.
// Usage (from nazra/web): node src/brand/sync-name.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ts = readFileSync(join(web, 'src/brand/brand.ts'), 'utf8');
const ar = ts.match(/nameAr:\s*'([^']+)'/)[1];
const en = ts.match(/nameEn:\s*'([^']+)'/)[1];

const htmlPath = join(web, 'index.html');
let html = readFileSync(htmlPath, 'utf8');
html = html
  .replace(/<title>[^<]*<\/title>/, `<title>${ar} · ${en}</title>`)
  .replace(/(name="apple-mobile-web-app-title" content=")[^"]*"/, `$1${ar}"`)
  .replace(/(data-brand="ar">)[^<]*</, `$1${ar}<`)
  .replace(/(data-brand="en">)[^<]*</, `$1${en}<`);
writeFileSync(htmlPath, html);

const manPath = join(web, 'public/manifest.webmanifest');
const man = JSON.parse(readFileSync(manPath, 'utf8'));
man.name = `${ar} · ${en}`;
man.short_name = ar;
writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n');
console.log(`brand name synced: ${ar} / ${en}`);
