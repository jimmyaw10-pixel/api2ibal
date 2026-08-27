/**
 * API Railway — consulta IBAL por matrícula y responde JSON de las 4 tarjetas.
 *
 * POST /api/consulta   { "matricula": "24714" }
 * GET  /api/consulta?matricula=24714
 * GET  /api/health
 */

const path = require('path');
const express = require('express');
const { chromium } = require('playwright');
const { parseTextoIbal, toApiResponse } = require('./parse-ibal');

const PORT = Number(process.env.PORT || 3000);
const IBAL_URL = 'https://ibal.gov.co/pagos/';
const API_KEY = process.env.API_KEY || '';

const app = express();
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-API-Key, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/** @type {import('playwright').Browser | null} */
let browser = null;
let consultaChain = Promise.resolve();

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.get('X-API-Key') || req.query.key || '';
  if (key !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'API key inválida' });
  }
  next();
}

function enqueue(fn) {
  const run = consultaChain.then(fn, fn);
  consultaChain = run.catch(() => {});
  return run;
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  return browser;
}

function normalizeMatricula(value) {
  return String(value || '').replace(/\D+/g, '');
}

async function createIbalContext(browser) {
  const context = await browser.newContext({
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1360, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'es-CO,es;q=0.9',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

async function leerCsrf(page) {
  let csrf = await page
    .locator('input[name="csrf_test_name"]')
    .first()
    .inputValue()
    .catch(() => '');

  if (csrf) return csrf;

  csrf = await page
    .evaluate(() => {
      const el = document.querySelector('input[name="csrf_test_name"]');
      return el && el.value ? el.value : '';
    })
    .catch(() => '');

  if (csrf) return csrf;

  const html = await page.content().catch(() => '');
  const m =
    html.match(/name=["']csrf_test_name["'][^>]*value=["']([^"']+)["']/i) ||
    html.match(/value=["']([^"']+)["'][^>]*name=["']csrf_test_name["']/i);
  return m ? m[1] : '';
}

async function cargarPaginaIbal(page) {
  await page
    .goto(IBAL_URL, { waitUntil: 'domcontentloaded', timeout: 90000 })
    .catch(() => page.goto(IBAL_URL, { waitUntil: 'load', timeout: 90000 }));

  try {
    await page.waitForSelector('input[name="csrf_test_name"], input[name="matricula_cliente"]', {
      timeout: 35000,
    });
  } catch {
    await page.waitForTimeout(4000);
  }

  try {
    await page.waitForFunction(
      () => {
        const csrf = document.querySelector('input[name="csrf_test_name"]');
        if (csrf && csrf.value) return true;
        const html = document.documentElement.innerHTML || '';
        return /csrf_test_name/.test(html);
      },
      { timeout: 15000 }
    );
  } catch {
    await page.waitForTimeout(2000);
  }
}

async function postConsultaIbal(page, matricula, csrf) {
  return page.evaluate(
    async ({ matricula, csrf }) => {
      const body = new URLSearchParams({
        csrf_test_name: csrf,
        matricula_cliente: matricula,
      });
      const res = await fetch('https://ibal.gov.co/pagos/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        body,
        credentials: 'include',
      });
      return await res.text();
    },
    { matricula: String(matricula), csrf }
  );
}

async function consultarMatricula(matricula) {
  const b = await getBrowser();
  const context = await createIbalContext(b);
  const page = await context.newPage();

  try {
    await cargarPaginaIbal(page);
    let csrf = await leerCsrf(page);

    if (!csrf) {
      await cargarPaginaIbal(page);
      csrf = await leerCsrf(page);
    }

    if (!csrf) {
      throw new Error('No se encontró el formulario IBAL (¿challenge anti-bot?)');
    }

    let html = await postConsultaIbal(page, matricula, csrf);

    // Si el CSRF expiró, recargar una vez y reintentar
    if (/csrf|token|expir/i.test(html) && !/Consulta Exitosa|PAGO TOTAL|no se encue?tran facturas/i.test(html)) {
      await cargarPaginaIbal(page);
      csrf = await leerCsrf(page);
      if (csrf) html = await postConsultaIbal(page, matricula, csrf);
    }

    const parsed = parseTextoIbal(html, String(matricula));
    return toApiResponse(parsed, String(matricula));
  } finally {
    await context.close();
  }
}

function extractMatriculas(req) {
  const body = req.body || {};
  if (Array.isArray(body.matriculas)) return body.matriculas;
  if (body.matricula) return [body.matricula];
  if (req.query.matricula) return [req.query.matricula];
  if (req.query.m) return [req.query.m];
  return [];
}

async function handleConsulta(matriculas) {
  const list = [...new Set(matriculas.map(normalizeMatricula).filter(Boolean))];
  if (!list.length) {
    const err = new Error('Indica matricula en el JSON: { "matricula": "24714" }');
    err.status = 400;
    throw err;
  }

  if (list.length === 1) {
    return enqueue(() => consultarMatricula(list[0]));
  }

  const resultados = [];
  for (const m of list) {
    try {
      resultados.push(await enqueue(() => consultarMatricula(m)));
    } catch (e) {
      resultados.push({
        ok: false,
        matricula: m,
        error: e.message || 'Error al consultar',
      });
    }
  }
  return { ok: true, total: resultados.length, resultados };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ibal-consulta-completa',
    ts: Date.now(),
  });
});

app.get('/api/consulta', requireApiKey, async (req, res) => {
  try {
    const data = await handleConsulta(extractMatriculas(req));
    res.status(data.ok === false ? 502 : 200).json(data);
  } catch (err) {
    console.error(err);
    res.status(err.status || 503).json({
      ok: false,
      error: err.message || 'No se pudo consultar IBAL',
    });
  }
});

app.post('/api/consulta', requireApiKey, async (req, res) => {
  try {
    const data = await handleConsulta(extractMatriculas(req));
    res.status(data.ok === false ? 502 : 200).json(data);
  } catch (err) {
    console.error(err);
    res.status(err.status || 503).json({
      ok: false,
      error: err.message || 'No se pudo consultar IBAL',
    });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ ok: false, error: 'Ruta API no encontrada' });
  }
  res.status(404).json({
    ok: false,
    error: 'Usa POST /api/consulta con { "matricula": "24714" }',
  });
});

app.listen(PORT, () => {
  console.log(`API IBAL en http://localhost:${PORT}`);
  console.log(`POST /api/consulta  { "matricula": "24714" }`);
  getBrowser().catch((e) => console.warn('Warmup browser:', e.message));
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
