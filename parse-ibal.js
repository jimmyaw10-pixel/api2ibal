/**
 * Extrae las 4 tarjetas de ibal.gov.co/pagos a partir del texto visible.
 *
 *   FECHA DE SUSPENSIÓN + Periodo de facturación
 *   Nº MATRÍCULA + NÚMERO DE FACTURA
 *   NOMBRE DEL TITULAR + DIRECCIÓN DEL TITULAR
 *   PAGO TOTAL + NO PAGADA / PAGADA
 */

function clean(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(text, re) {
  const m = String(text || '').match(re);
  return m && m[1] ? clean(m[1]) : null;
}

function parseMoney(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function formatCop(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return '$' + Number(n).toLocaleString('es-CO');
}

function parseEpayco(html) {
  const src = String(html || '');
  const amount =
    pick(src, /amount:\s*["']?(\d+)["']?/i) ||
    pick(src, /["']amount["']\s*:\s*["']?(\d+)/i) ||
    pick(src, /"amount"\s*:\s*(\d+)/i) ||
    pick(src, /amountInCents["']?\s*[:=]\s*["']?(\d+)/i);
  let monto = parseMoney(amount);
  if (monto != null && /amountInCents/i.test(src) && monto > 999999) {
    monto = Math.round(monto / 100);
  }
  const invoice =
    pick(src, /invoice:\s*["']([^"']+)["']/i) ||
    pick(src, /["']invoice["']\s*:\s*["']([^"']+)["']/i) ||
    pick(src, /"invoice"\s*:\s*"([^"']+)"/i) ||
    pick(src, /numeroFactura["']?\s*[:=]\s*["']?(\d+)/i);
  const name = pick(src, /name:\s*["']([^"']+)["']/i) || pick(src, /"name"\s*:\s*"([^"']+)"/i);
  const description =
    pick(src, /description:\s*["']([^"']*)["']/i) ||
    pick(src, /"description"\s*:\s*"([^"']*)"/i);
  return {
    monto,
    factura: invoice,
    matricula: name,
    descripcion: description,
  };
}

function tieneDatosFactura(html) {
  const src = String(html || '');
  if (src.length < 80) return false;
  return (
    /Consulta Exitosa/i.test(src) ||
    /PAGO TOTAL/i.test(src) ||
    /FECHA DE SUSPENSI/i.test(src) ||
    /amount:\s*["']?\d+/i.test(src) ||
    /"amount"\s*:\s*\d+/i.test(src) ||
    /no se encue?tran facturas pendientes/i.test(src)
  );
}

function parseTextoIbal(htmlOrText, matriculaFallback) {
  const raw = String(htmlOrText || '');
  const text = clean(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );

  if (/no se encue?tran facturas pendientes/i.test(text) || /no se encue?tran facturas pendientes/i.test(raw)) {
    return {
      pendiente: false,
      sin_facturas: true,
      matricula: String(matriculaFallback || pick(text, /matr[ií]cula\s+(\d+)/i) || ''),
      mensaje: 'No hay facturas pendientes',
    };
  }

  const epayco = parseEpayco(raw);

  // Señales claras de factura en epayco aunque falte texto visible
  if (epayco.factura && epayco.monto != null && epayco.monto > 0) {
    const fecha_suspension =
      pick(text, /FECHA\s+DE\s+SUSPENSI[ÓO]N\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i) ||
      pick(text, /SUSPENSI[ÓO]N\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    const periodo =
      pick(text, /Periodo\s+de\s+facturaci[oó]n\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+\s+del\s+\d{4})/i) ||
      pick(text, /Periodo\s+de\s+facturaci[oó]n\s*[:：]?\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+\s+del\s+\d{4})/i);
    const titular =
      pick(text, /NOMBRE\s+DEL\s+TITULAR\s+(.+?)\s+DIRECCI[ÓO]N\s+DEL\s+TITULAR/i) ||
      pick(text, /NOMBRE\s+DEL\s+TITULAR\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ0-9 .,&Y]{3,90})/i);
    const direccion =
      pick(text, /DIRECCI[ÓO]N\s+DEL\s+TITULAR\s+(.+?)\s+PAGO\s+TOTAL/i) ||
      pick(
        text,
        /DIRECCI[ÓO]N\s+DEL\s+TITULAR\s+([A-Z0-9ÁÉÍÓÚÑ#\- ].{2,90}?)(?:\s+PAGO|\s+NO\s+PAGADA|\s+PAGADA|$)/i
      );
    const estado_pago = pick(text, /\b(NO\s+PAGADA|PAGADA)\b/i);

    return {
      pendiente: true,
      sin_facturas: false,
      matricula: String(epayco.matricula || matriculaFallback || pick(text, /N[°º.]?\s*MATR[IÍ]CULA\s+(\d+)/i) || ''),
      factura: String(epayco.factura),
      numero_factura: String(epayco.factura),
      titular: titular || null,
      direccion: direccion || null,
      fecha_suspension: fecha_suspension || null,
      fecha_corte: fecha_suspension || null,
      periodo: periodo || null,
      monto: epayco.monto,
      pago_total: epayco.monto,
      monto_formato: formatCop(epayco.monto),
      pago_total_formato: formatCop(epayco.monto),
      estado_pago: estado_pago || null,
      moneda: 'COP',
      descripcion: epayco.descripcion || 'Factura de servicios públicos',
    };
  }

  const fecha_suspension =
    pick(text, /FECHA\s+DE\s+SUSPENSI[ÓO]N\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i) ||
    pick(text, /SUSPENSI[ÓO]N\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);

  const periodo =
    pick(text, /Periodo\s+de\s+facturaci[oó]n\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+\s+del\s+\d{4})/i) ||
    pick(text, /Periodo\s+de\s+facturaci[oó]n\s*[:：]?\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+\s+del\s+\d{4})/i);

  const matricula =
    pick(text, /N[°º.]?\s*MATR[IÍ]CULA\s+(\d+)/i) ||
    epayco.matricula ||
    (matriculaFallback ? String(matriculaFallback) : null);

  const factura =
    pick(text, /N[ÚU]MERO\s+DE\s+FACTURA\s+(\d+)/i) ||
    pick(text, /N[úu]mero de factura\s+(\d+)/i) ||
    epayco.factura;

  const titular =
    pick(text, /NOMBRE\s+DEL\s+TITULAR\s+(.+?)\s+DIRECCI[ÓO]N\s+DEL\s+TITULAR/i) ||
    pick(text, /NOMBRE\s+DEL\s+TITULAR\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ0-9 .,&Y]{3,90})/i);

  const direccion =
    pick(text, /DIRECCI[ÓO]N\s+DEL\s+TITULAR\s+(.+?)\s+PAGO\s+TOTAL/i) ||
    pick(
      text,
      /DIRECCI[ÓO]N\s+DEL\s+TITULAR\s+([A-Z0-9ÁÉÍÓÚÑ#\- ].{2,90}?)(?:\s+PAGO|\s+NO\s+PAGADA|\s+PAGADA|$)/i
    );

  const montoRaw = pick(text, /PAGO\s+TOTAL\s*\$?\s*([\d.,]+)/i);
  const monto = parseMoney(montoRaw) != null ? parseMoney(montoRaw) : epayco.monto;

  const estado_pago = pick(text, /\b(NO\s+PAGADA|PAGADA)\b/i);

  const tieneDeuda =
    !!(factura && monto != null && monto > 0) ||
    /NO\s+PAGADA/i.test(text) ||
    (/Consulta Exitosa/i.test(text) && !!factura);

  return {
    pendiente: tieneDeuda,
    sin_facturas: false,
    matricula: matricula ? String(matricula) : String(matriculaFallback || ''),
    factura: factura ? String(factura) : null,
    numero_factura: factura ? String(factura) : null,
    titular: titular || null,
    direccion: direccion || null,
    fecha_suspension: fecha_suspension || null,
    fecha_corte: fecha_suspension || null,
    periodo: periodo || null,
    monto: monto,
    pago_total: monto,
    monto_formato: formatCop(monto),
    pago_total_formato: formatCop(monto),
    estado_pago: estado_pago || null,
    moneda: 'COP',
    descripcion: epayco.descripcion || 'Factura de servicios públicos',
  };
}

function toApiResponse(parsed, matriculaFallback) {
  if (!parsed) {
    return { ok: false, error: 'Sin datos' };
  }

  if (parsed.sin_facturas === true) {
    return {
      ok: true,
      pendiente: false,
      matricula: String(parsed.matricula || matriculaFallback || ''),
      factura: null,
      numero_factura: null,
      titular: null,
      direccion: null,
      fecha_suspension: null,
      periodo: null,
      monto: 0,
      pago_total: 0,
      monto_formato: '$0',
      pago_total_formato: '$0',
      estado_pago: null,
      moneda: 'COP',
      mensaje: parsed.mensaje || 'No hay facturas pendientes',
    };
  }

  if (!parsed.factura || parsed.monto == null) {
    return {
      ok: false,
      error: 'No se pudo leer factura/monto de IBAL',
      matricula: String(parsed.matricula || matriculaFallback || ''),
      parcial: parsed,
    };
  }

  return {
    ok: true,
    pendiente: true,
    matricula: String(parsed.matricula || matriculaFallback || ''),
    factura: String(parsed.factura),
    numero_factura: String(parsed.numero_factura || parsed.factura),
    titular: parsed.titular,
    direccion: parsed.direccion,
    fecha_suspension: parsed.fecha_suspension,
    fecha_corte: parsed.fecha_suspension,
    periodo: parsed.periodo,
    monto: Number(parsed.monto),
    pago_total: Number(parsed.pago_total != null ? parsed.pago_total : parsed.monto),
    monto_formato: parsed.monto_formato || formatCop(parsed.monto),
    pago_total_formato: parsed.pago_total_formato || formatCop(parsed.monto),
    estado_pago: parsed.estado_pago,
    moneda: parsed.moneda || 'COP',
    descripcion: parsed.descripcion || 'Factura de servicios públicos',
  };
}

/** Texto típico de las 4 tarjetas (matrícula 24714) para verificar el parser. */
const SAMPLE_24714 =
  'Consulta Exitosa para la matrícula 24714 ' +
  'FECHA DE SUSPENSIÓN 04/09/2026 Periodo de facturación Julio del 2026 ' +
  'Nº MATRÍCULA 24714 NÚMERO DE FACTURA 22430310 ' +
  'NOMBRE DEL TITULAR MARIA ISABEL SANCHEZ RODRIGUEZ ' +
  'DIRECCIÓN DEL TITULAR VIA BOGOTA PICALEÑA ' +
  'PAGO TOTAL $303,200 NO PAGADA';

if (require.main === module) {
  const parsed = parseTextoIbal(SAMPLE_24714, '24714');
  const json = toApiResponse(parsed, '24714');
  console.log(JSON.stringify(json, null, 2));
}

module.exports = {
  parseTextoIbal,
  parseEpayco,
  toApiResponse,
  formatCop,
  tieneDatosFactura,
  SAMPLE_24714,
};
