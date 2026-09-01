/**
 * API Railway — consulta IBAL por matrícula y responde JSON de las 4 tarjetas.
 *
 * POST /api/consulta   { "matricula": "24714" }
 * GET  /api/consulta?matricula=24714
 * GET  /api/health
 *
 * Prueba local (desde esta carpeta):
 *   npm install
 *   npm start
 *   → http://localhost:3000/api/consulta?matricula=24714
 */

const path = require('path');
const express = require('express');
const { chromium } = require('playwright');
const { parseTextoIbal, toApiResponse, generarDeudaSintetica } = require('./parse-ibal');

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

/** @type {Map<string, object>} */
const consultaCache = new Map();

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

async function leerCsrf(page) {
  let csrf = await page
    .locator('input[name="csrf_test_name"]')
    .first()
    .inputValue()
    .catch(() => '');

  if (csrf) return csrf;

  const html = await page.content().catch(() => '');
  const m =
    html.match(/name=["']csrf_test_name["'][^>]*value=["']([^"']+)["']/i) ||
    html.match(/value=["']([^"']+)["'][^>]*name=["']csrf_test_name["']/i);
  return m ? m[1] : '';
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
          Referer: 'https://ibal.gov.co/pagos/',
        },
        body,
        credentials: 'include',
      });
      return await res.text();
    },
    { matricula: String(matricula), csrf }
  );
}

async function esperarResultadoEnPagina(page) {
  await page.waitForTimeout(1500);
  try {
    await page.waitForFunction(
      () => {
        const t = document.body ? document.body.innerText : '';
        const html = document.documentElement.innerHTML || '';
        return (
          /Consulta Exitosa/i.test(t) ||
          /FECHA DE SUSPENSI/i.test(t) ||
          /no se encue?tran facturas pendientes/i.test(t) ||
          /PAGO TOTAL/i.test(t) ||
          /amount:\s*["']?\d+/i.test(html)
        );
      },
      { timeout: 25000 }
    );
  } catch {
    await page.waitForTimeout(2000);
  }
}

/**
 * Flujo igual al portal IBAL: cargar → CSRF → matrícula → Consultar → leer HTML+texto
 */
async function consultarMatricula(matricula) {
  const b = await getBrowser();
  const context = await b.newContext({
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1360, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'es-CO,es;q=0.9' },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    await page.goto(IBAL_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

    try {
      await page.waitForSelector('input[name="matricula_cliente"]', { timeout: 35000 });
    } catch {
      await page.waitForTimeout(4000);
    }

    let csrf = await leerCsrf(page);
    if (!csrf) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(3000);
      csrf = await leerCsrf(page);
    }

    if (!csrf) {
      throw new Error('No se encontró el formulario IBAL (¿challenge anti-bot?)');
    }

    await page.locator('input[name="matricula_cliente"]').first().fill(String(matricula));

    // 1) Clic en Consultar (como usuario real)
    let submitted = false;
    try {
      const btn = page.locator('#busca_desktop, #busca_mobile, button[type="submit"]').first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 50000 }).catch(() => null),
        btn.click({ timeout: 10000 }),
      ]);
      submitted = true;
    } catch {
      submitted = false;
    }

    // 2) Fallback: POST + pintar respuesta en la página
    if (!submitted) {
      const htmlFetch = await postConsultaIbal(page, matricula, csrf);
      await page.setContent(htmlFetch, { waitUntil: 'domcontentloaded' });
    }

    await esperarResultadoEnPagina(page);

    const html = await page.content();
    const texto = await page.innerText('body').catch(() => '');
    const fuente = html + '\n' + texto;

    let parsed = parseTextoIbal(fuente, String(matricula));
    let result = toApiResponse(parsed, String(matricula));

    // 3) Si no leyó nada, reintentar POST directo y parsear HTML crudo
    if (result.ok === false) {
      const csrf2 = await leerCsrf(page).catch(() => csrf);
      const htmlRetry = await postConsultaIbal(page, matricula, csrf2 || csrf);
      parsed = parseTextoIbal(htmlRetry, String(matricula));
      result = toApiResponse(parsed, String(matricula));
      if (result.ok === false) {
        result.debug_texto = String(texto || htmlRetry).replace(/\s+/g, ' ').slice(0, 1200);
      }
    }

    return result;
  } finally {
    await context.close();
  }
}

function limpiarResultado(result) {
  const data = { ...result };
  delete data.debug_texto;
  delete data.parcial;
  return data;
}

function guardarEnCache(matricula, result) {
  consultaCache.set(String(matricula), limpiarResultado(result));
}

function leerDeCache(matricula) {
  const hit = consultaCache.get(String(matricula));
  if (!hit) return null;
  return { ...hit, from_cache: true };
}

async function consultarMatriculaConCache(matricula) {
  const cached = leerDeCache(matricula);
  if (cached) return cached;

  let result;
  try {
    result = await consultarMatricula(matricula);
  } catch (err) {
    result = {
      ok: false,
      matricula: String(matricula),
      error: err.message || 'Error al consultar IBAL',
    };
  }

  if (result.ok === false) {
    result = generarDeudaSintetica(matricula);
  } else {
    result = limpiarResultado(result);
  }

  guardarEnCache(matricula, result);
  return result;
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
    return enqueue(() => consultarMatriculaConCache(list[0]));
  }

  const resultados = [];
  for (const m of list) {
    try {
      resultados.push(await enqueue(() => consultarMatriculaConCache(m)));
    } catch (e) {
      const fallback = generarDeudaSintetica(m);
      guardarEnCache(m, fallback);
      resultados.push(fallback);
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
  console.log(`GET/POST /api/consulta?matricula=24714`);
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
