// scripts/smoke-test.mjs
//
// Loads every built page in a real browser and fails on uncaught exceptions,
// console errors, failed assets, and missing expected rendered UI. This static
// harness has no backend; API responses are reported separately, not simulated.
//
// The template is a static bundle with no test suite, so a broken selector or a
// bad import surfaces only when someone opens the page. This closes that gap
// cheaply — it caught, among other things, six pages whose inline scripts had a
// syntax error and a chart library that was being loaded twice.
//
// Usage:  npm run build && node scripts/smoke-test.mjs
//
// Env:
//   PLAYWRIGHT_PATH=…   resolve playwright from elsewhere if not a local dep
//   HEADED=1            watch it run
//   SMOKE_PAGES=a.html,b.html  limit the run to selected built pages
//   SMOKE_DIST=…        serve an alternate build directory

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVE_DIR = path.resolve(process.env.SMOKE_DIST || path.join(ROOT, 'dist-modern'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// Pages that are expected to render at least one chart.
const CHART_PAGES = new Set([
  'analytics.html',
  'users.html',
  'orders.html',
  'products.html',
  'reports.html',
]);
const SVG_PREVIEW_CHART_PAGES = new Set(['index.html']);
const MOBILE_LAYOUT_PAGES = new Set([
  'index.html',
  'principal-dashboard.html',
  'teacher-dashboard.html',
  'parent-dashboard.html',
  'student-dashboard.html',
  'attendance.html',
  'fees.html',
  'my-fees.html',
]);

// Pages that are expected to syntax-highlight code samples.
const PRISM_PAGES = new Set([
  'elements-alerts.html',
  'elements-badges.html',
  'elements-buttons.html',
  'elements-cards.html',
  'elements-forms.html',
  'elements-modals.html',
  'elements-tables.html',
]);

// Console noise that is intentional and not a failure.
const IGNORED_CONSOLE = [/favicon/i, /Failed to load resource.*manifest\.json/i];

function serve(dir) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath = path.join(dir, urlPath);
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!filePath.startsWith(dir) || !existsSync(filePath)) {
        res.writeHead(404).end('Not found');
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  if (!existsSync(SERVE_DIR)) {
    console.error(`✗ ${path.relative(ROOT, SERVE_DIR)} not found — run \`npm run build\` first.`);
    process.exit(1);
  }

  const { readdir } = await import('node:fs/promises');
  const availablePages = (await readdir(SERVE_DIR)).filter((f) => f.endsWith('.html')).sort();
  const requestedPages = process.env.SMOKE_PAGES
    ? process.env.SMOKE_PAGES.split(',').map((page) => page.trim()).filter(Boolean)
    : availablePages;
  const missingPages = requestedPages.filter((page) => !availablePages.includes(page));
  if (missingPages.length) throw new Error(`Requested page(s) are not built: ${missingPages.join(', ')}`);
  const pages = requestedPages;
  if (pages.length === 0) {
    console.error('✗ No built pages found.');
    process.exit(1);
  }

  const { server, port } = await serve(SERVE_DIR);
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const results = [];

  for (const page of pages) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const tab = await ctx.newPage();

    const errors = [];
    const apiUnavailable = [];
    const external = [];

    tab.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
    tab.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      if (/^Failed to load resource: the server responded with a status of \d+/.test(text)) return;
      errors.push(`console: ${text}`);
    });
    tab.on('requestfailed', (req) => {
      const url = req.url();
      if (IGNORED_CONSOLE.some((re) => re.test(url))) return;
      errors.push(`request failed: ${url} (${req.failure()?.errorText})`);
    });
    tab.on('response', (response) => {
      if (response.status() < 400) return;
      const request = response.request();
      const url = new URL(response.url());
      const detail = `HTTP ${response.status()} ${request.method()}: ${url.pathname}${url.search}`;
      if (url.pathname.startsWith('/api/')) apiUnavailable.push(detail);
      else errors.push(detail);
    });
    tab.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith(`http://127.0.0.1:${port}`) && !url.startsWith('data:') && !url.startsWith('blob:')) {
        external.push(url);
      }
    });

    await tab.goto(`http://127.0.0.1:${port}/${page}`, { waitUntil: 'networkidle', timeout: 30000 });
    // Charts and the lazily-imported highlighter settle a tick after load.
    await tab.waitForTimeout(1200);

    const charts = await tab.locator('.apexcharts-canvas').count();
    const highlighted = await tab.locator('code.language-html .token').count();
    const alpineErrors = errors.filter((e) => /alpine/i.test(e)).length;

    if (CHART_PAGES.has(page) && charts === 0) {
      errors.push('expected at least one rendered chart, found none');
    }
    if (SVG_PREVIEW_CHART_PAGES.has(page) && apiUnavailable.length === 0 && await tab.locator('.chart svg').count() === 0) {
      errors.push('expected the labelled illustrative SVG preview chart, found none');
    }
    if (PRISM_PAGES.has(page) && highlighted === 0) {
      errors.push('expected syntax-highlighted code, found none');
    }
    let mobileLayout = null;
    if (MOBILE_LAYOUT_PAGES.has(page)) {
      await tab.setViewportSize({ width: 390, height: 844 });
      await tab.waitForTimeout(100);
      mobileLayout = await tab.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        overflowElements: Array.from(document.body.querySelectorAll('*'))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              id: element.id,
              className: typeof element.className === 'string' ? element.className : '',
              width: Math.round(rect.width),
              right: Math.round(rect.right),
              position: getComputedStyle(element).position,
            };
          })
          .filter((element) => element.width > 0 && element.right > window.innerWidth + 1 && element.position !== 'fixed')
          .slice(0, 5),
      }));
      if (mobileLayout.documentWidth > mobileLayout.viewportWidth) {
        errors.push(`mobile layout overflows: ${mobileLayout.documentWidth}px > ${mobileLayout.viewportWidth}px; elements: ${JSON.stringify(mobileLayout.overflowElements)}`);
      }
    }
    if (external.length) {
      errors.push(`external request(s): ${[...new Set(external)].join(', ')}`);
    }

    results.push({ page, charts, highlighted, errors, alpineErrors, apiUnavailable, mobileLayout });
    await ctx.close();
  }

  await browser.close();
  server.close();

  // ── Report ──────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.errors.length);
  const pad = Math.max(...results.map((r) => r.page.length));

  console.log('\nPage                            charts  highlighted  status');
  console.log('─'.repeat(66));
  for (const r of results) {
    const status = r.errors.length ? '✗ FAIL' : '✓ ok';
    console.log(
      `${r.page.padEnd(pad)}  ${String(r.charts).padStart(6)}  ${String(r.highlighted).padStart(11)}  ${status}`
    );
  }

  const unavailableApiCalls = results.flatMap((r) => r.apiUnavailable.map((detail) => `${r.page}: ${detail}`));
  if (unavailableApiCalls.length) {
    console.log(`\n${unavailableApiCalls.length} API call(s) were not tested because this static smoke server has no backend:`);
    for (const detail of unavailableApiCalls) console.log(`  • ${detail}`);
  }

  if (failed.length) {
    console.log('\nFailures');
    console.log('─'.repeat(66));
    for (const r of failed) {
      console.log(`\n${r.page}`);
      for (const e of r.errors) console.log(`  • ${e}`);
    }
    console.log(`\n✗ ${failed.length}/${results.length} pages failed.`);
    process.exit(1);
  }

  console.log(`\n✓ All ${results.length} pages loaded clean — no errors, no external requests.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
