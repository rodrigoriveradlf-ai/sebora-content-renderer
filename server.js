import express from 'express';
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');

const PORT = parseInt(process.env.PORT ?? '4123', 10);
const AUTH_TOKEN = process.env.RENDERER_AUTH_TOKEN;

const DEFAULT_VIEWPORTS = {
  post: { width: 1080, height: 1080, deviceScaleFactor: 1 },
  carrusel: { width: 1080, height: 1080, deviceScaleFactor: 1 },
  reel_frame: { width: 1080, height: 1920, deviceScaleFactor: 1 },
  story: { width: 1080, height: 1920, deviceScaleFactor: 1 },
};

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
    });
  }
  return browserPromise;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fillTemplate(html, props) {
  return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!(key in props)) return '';
    const value = props[key];
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      throw new Error(`Prop "${key}" must be string or number, got object`);
    }
    return escapeHtml(value);
  });
}

async function loadTemplate(templateId) {
  if (!/^[a-z0-9_-]+$/.test(templateId)) {
    throw new Error(`Invalid template_id: ${templateId}`);
  }
  const path = join(TEMPLATES_DIR, `${templateId}.html`);
  return readFile(path, 'utf8');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!AUTH_TOKEN) return next();
  const provided = req.get('x-renderer-token');
  if (provided !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/render-image', async (req, res) => {
  const { template_id, props = {}, format = 'post', viewport } = req.body ?? {};

  if (!template_id) {
    return res.status(400).json({ error: 'template_id is required' });
  }

  const vp = viewport ?? DEFAULT_VIEWPORTS[format];
  if (!vp) {
    return res.status(400).json({ error: `unknown format: ${format}` });
  }

  let page;
  try {
    const rawHtml = await loadTemplate(template_id);
    const html = fillTemplate(rawHtml, props);

    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport(vp);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
    await page.evaluateHandle('document.fonts.ready');

    const png = await page.screenshot({
      type: 'png',
      omitBackground: false,
      clip: { x: 0, y: 0, width: vp.width, height: vp.height },
    });

    res.set('Content-Type', 'image/png');
    res.set('X-Template-Id', template_id);
    res.set('X-Viewport', `${vp.width}x${vp.height}`);
    res.send(png);
  } catch (err) {
    console.error('[render-image] error:', err);
    res.status(500).json({ error: 'render_failed', detail: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

const server = app.listen(PORT, () => {
  console.log(`[sebora-renderer] listening on :${PORT}`);
});

async function shutdown(signal) {
  console.log(`[sebora-renderer] received ${signal}, shutting down`);
  server.close();
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
