// Regenerates docs/screenshots/*.png from the dev server.
//
//   npm run dev                                  # in another shell
//   npx playwright@1.62 install chromium         # once, unless CHROME_BIN is set
//   node scripts/screenshots.mjs                 # BASE=http://127.0.0.1:5173 by default
//
// Everything except the sign-in shot renders /preview.html, which stubs the API,
// so no backend or mail server is required.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../docs/screenshots');
const BASE = process.env.BASE || 'http://127.0.0.1:5173';

const DESKTOP = { width: 1440, height: 760 };
const PHONE = { width: 390, height: 844 };

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch(
  process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}
);

async function open({ viewport, dsf, url, locale = 'en', theme = 'light' }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf });
  await ctx.addInitScript(
    ([l, t]) => {
      localStorage.setItem('e2Mail_locale', l);
      localStorage.setItem('e2Mail_theme', t);
    },
    [locale, theme]
  );
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  return { ctx, page };
}

// Desktop uses the sidebar, phone widths use the tab strip.
const nav = (page, name, mobile) =>
  (mobile ? page.locator('nav[aria-label] button') : page.locator('aside button')).filter({
    hasText: name,
  });

async function shot(page, file) {
  await page.screenshot({ path: `${OUT}/${file}` });
  console.log(file);
}

async function section(page, name, file, { mobile = false } = {}) {
  if (name) {
    await nav(page, name, mobile).first().click();
    await page.waitForTimeout(500);
  }
  await shot(page, file);
}

async function expandSievePreview(page) {
  await page.locator('summary').filter({ hasText: 'Sieve preview' }).click();
  await page.waitForTimeout(500);
}

{
  const { ctx, page } = await open({ viewport: DESKTOP, dsf: 2, url: `${BASE}/preview.html?2fa=on` });
  await section(page, null, 'settings-security.png');
  await section(page, 'PGP keys', 'settings-pgp.png');
  await section(page, 'Mail accounts', 'settings-accounts.png');
  await nav(page, 'Filters').first().click();
  await expandSievePreview(page);
  await shot(page, 'settings-filters.png');
  await section(page, 'Appearance', 'settings-appearance.png');
  await ctx.close();
}

{
  const { ctx, page } = await open({
    viewport: DESKTOP,
    dsf: 2,
    url: `${BASE}/preview.html?2fa=on`,
    theme: 'dark',
  });
  await nav(page, 'Filters').first().click();
  await expandSievePreview(page);
  await shot(page, 'settings-filters-dark.png');
  await ctx.close();
}

{
  const { ctx, page } = await open({
    viewport: DESKTOP,
    dsf: 2,
    url: `${BASE}/preview.html?2fa=on`,
    locale: 'zh-Hant',
  });
  await section(page, '外觀與顯示', 'settings-appearance-zh.png');
  await ctx.close();
}

{
  const { ctx, page } = await open({ viewport: PHONE, dsf: 3, url: `${BASE}/preview.html?2fa=on` });
  await section(page, null, 'settings-mobile-security.png');
  await section(page, 'Filters', 'settings-mobile-filters.png', { mobile: true });
  await section(page, 'Appearance', 'settings-mobile-appearance.png', { mobile: true });
  await ctx.close();
}

{
  const { ctx, page } = await open({ viewport: DESKTOP, dsf: 2, url: `${BASE}/` });
  await page.waitForTimeout(1200);
  await shot(page, 'login.png');
  await ctx.close();
}

await browser.close();
