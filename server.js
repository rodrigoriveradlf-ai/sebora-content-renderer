import express from 'express';
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');

const PORT = parseInt(process.env.PORT ?? '4123', 10);
const AUTH_TOKEN = process.env.RENDERER_AUTH_TOKEN;

const R2_BUCKET = process.env.R2_BUCKET;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_PUBLIC_URL_BASE = process.env.R2_PUBLIC_URL_BASE;

const r2Configured =
  R2_BUCKET && R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_PUBLIC_URL_BASE;

const r2 = r2Configured
  ? new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

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

function resolveProp(key, props, { escape }) {
  if (!(key in props)) return '';
  const value = props[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    throw new Error(`Prop "${key}" must be string or number, got object`);
  }
  return escape ? escapeHtml(value) : String(value);
}

function fillTemplate(html, props) {
  // Triple braces {{{key}}} = HTML raw. Solo para campos donde se permite HTML controlado (ej: <span class="accent">).
  let result = html.replace(/\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}\}/g, (_m, key) =>
    resolveProp(key, props, { escape: false })
  );
  // Double braces {{key}} = texto escapado (default seguro).
  result = result.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) =>
    resolveProp(key, props, { escape: true })
  );
  return result;
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

async function renderPng({ template_id, props, format, viewport }) {
  if (!template_id) {
    const err = new Error('template_id is required');
    err.status = 400;
    throw err;
  }
  const vp = viewport ?? DEFAULT_VIEWPORTS[format ?? 'post'];
  if (!vp) {
    const err = new Error(`unknown format: ${format}`);
    err.status = 400;
    throw err;
  }
  const rawHtml = await loadTemplate(template_id);
  const html = fillTemplate(rawHtml, props ?? {});
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport(vp);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
    await page.evaluateHandle('document.fonts.ready');
    const png = await page.screenshot({
      type: 'png',
      omitBackground: false,
      clip: { x: 0, y: 0, width: vp.width, height: vp.height },
    });
    return { png, viewport: vp };
  } finally {
    await page.close().catch(() => {});
  }
}

function buildObjectKey({ key, format }) {
  if (key) return key;
  const today = new Date().toISOString().slice(0, 10);
  const suffix = randomBytes(4).toString('hex');
  return `posts/${today}-${format ?? 'post'}-${suffix}.png`;
}

app.post('/render-image', async (req, res) => {
  try {
    const { template_id, props, format, viewport } = req.body ?? {};
    const { png, viewport: vp } = await renderPng({ template_id, props, format, viewport });
    res.set('Content-Type', 'image/png');
    res.set('X-Template-Id', template_id);
    res.set('X-Viewport', `${vp.width}x${vp.height}`);
    res.send(png);
  } catch (err) {
    console.error('[render-image] error:', err);
    res.status(err.status ?? 500).json({ error: 'render_failed', detail: err.message });
  }
});

app.post('/render-and-upload', async (req, res) => {
  if (!r2Configured) {
    return res.status(503).json({
      error: 'r2_not_configured',
      detail: 'Missing R2_* env vars on renderer service',
    });
  }
  try {
    const { template_id, props, format, viewport, key: customKey } = req.body ?? {};
    const { png, viewport: vp } = await renderPng({ template_id, props, format, viewport });
    const key = buildObjectKey({ key: customKey, format });

    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: png,
        ContentType: 'image/png',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    const url = `${R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${key}`;
    res.json({
      url,
      key,
      bucket: R2_BUCKET,
      viewport: { width: vp.width, height: vp.height },
      bytes: png.length,
    });
  } catch (err) {
    console.error('[render-and-upload] error:', err);
    res.status(err.status ?? 500).json({ error: 'upload_failed', detail: err.message });
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
