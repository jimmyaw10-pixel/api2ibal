# API consulta IBAL (Railway)

Servicio Node que entra a [ibal.gov.co/pagos](https://ibal.gov.co/pagos/), consulta una matrícula y responde **JSON** con las 4 tarjetas:

| Campo JSON | En IBAL |
|---|---|
| `fecha_suspension` | FECHA DE SUSPENSIÓN |
| `periodo` | Periodo de facturación |
| `matricula` | Nº MATRÍCULA |
| `numero_factura` | NÚMERO DE FACTURA |
| `titular` | NOMBRE DEL TITULAR |
| `direccion` | DIRECCIÓN DEL TITULAR |
| `pago_total` / `pago_total_formato` | PAGO TOTAL |
| `estado_pago` | NO PAGADA / PAGADA |

Ejemplo esperado para matrícula **24714**:

```json
{
  "ok": true,
  "pendiente": true,
  "matricula": "24714",
  "numero_factura": "22430310",
  "titular": "MARIA ISABEL SANCHEZ RODRIGUEZ",
  "direccion": "VIA BOGOTA PICALEÑA",
  "fecha_suspension": "04/09/2026",
  "periodo": "Julio del 2026",
  "pago_total": 303200,
  "pago_total_formato": "$303.200",
  "estado_pago": "NO PAGADA",
  "moneda": "COP"
}
```

## Cómo llamarla (JSON)

**POST** (recomendado)

```http
POST /api/consulta
Content-Type: application/json

{"matricula":"24714"}
```

```bash
curl -X POST "https://TU-SERVICIO.up.railway.app/api/consulta" ^
  -H "Content-Type: application/json" ^
  -d "{\"matricula\":\"24714\"}"
```

**GET**

```
https://TU-SERVICIO.up.railway.app/api/consulta?matricula=24714
```

Varias matrículas:

```json
{ "matriculas": ["24714", "129977"] }
```

Health: `GET /api/health`

## Desplegar en Railway

1. Sube este repo a GitHub (o conecta el directorio local).
2. En Railway: **New Project → Deploy from GitHub**.
3. En el servicio, **Settings → Root Directory** = `api-consulta`.
4. Railway usará el `Dockerfile` (imagen oficial de Playwright).
5. Genera un dominio público: **Settings → Networking → Generate Domain**.
6. (Opcional) Variable `API_KEY` para exigir header `X-API-Key`.

La consulta tarda 20–90 s porque abre el portal real. En Railway, sube el timeout HTTP del servicio si hace falta (60–90 s).

## Probar en local

```bash
cd api-consulta
npm install
npx playwright install chromium
npm start
```

- Parser sin red: `npm run test:parse`
- UI: `http://localhost:3000/`
- API: `POST http://localhost:3000/api/consulta` con `{"matricula":"24714"}`
