# Tests E2E de API — Facturación

Tests de **API** (sin navegador) del flujo crítico de facturación con Playwright.

## Guardrails (anti-producción)
`global-setup.ts` **aborta** la corrida si:
- `ALLOW_E2E != true`
- `FACTURAMA_URL` apunta a prod (`api.facturama.mx`)
- la BD es de prod (nombres `u522428285_*` o host `srv1250.hstgr.io`, o vacía → caería a prod por default)
- hay `SENTRY_DSN` / `NOTIFY_TELEGRAM_TOKEN` (las pruebas no deben emitir a servicios reales)

El backend bajo prueba recibe el env de `.env.test` **inyectado** como env real (precede a cualquier `.env`), y Sentry/Telegram se fuerzan apagados.

## Cobertura
| # | Caso | Suite | Necesita BD |
|---|------|-------|-------------|
| 5 | IVA extraído 16% (`extraerIva`) | `iva.spec.ts` | no |
| 4 | IDOR: sin token → 404 genérico | `idor.spec.ts` | no (token malo: sí) |
| — | Validación de entrada (400/422) | `validation.spec.ts` | no |
| 1 | Fallo → 422/503 + reintentable | `timbrado-flow.spec.ts` | **sí** |
| 2 | Reintento NO da 409 | `timbrado-flow.spec.ts` | **sí** |
| 3 | Timbrado OK → `procesada` + UUID | `timbrado-flow.spec.ts` | **sí** |

Los casos 1–3 y 5(cuerpo) corren contra un **mock determinista** de Facturama (`facturama-mock.mjs`, CERO folios). El happy-path también funciona contra **sandbox real** si pones `FACTURAMA_URL=https://apisandbox.facturama.mx` + credenciales sandbox en `.env.test`.

## Correr
```bash
cd server
cp .env.test.example .env.test          # y rellena
npm run test:e2e                         # suite segura (sin BD) + skips de la suite con BD
npm run test:e2e:report                  # abre el reporte HTML
```

### Habilitar la suite con BD (casos 1–3)
1. Crea una BD de prueba (copia del esquema de prod **sin datos**) y aplica la migración `factura_token`.
2. Apunta `DB_GUERRERO_*` a esa BD y pon `E2E_DB=true` en `.env.test`.
3. Siembra: `mysql ... lapena_test_guerrero < tests/e2e/seed.sql`
4. `npm run test:e2e` (re-siembra antes de cada corrida; el seed es idempotente).

Reporte HTML en `playwright-report/` (gitignored).
