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
| G | Modo gracia: token opcional en getOrden/solicitar; reobtención sigue estricta | `grace.spec.ts` | reobtención→404: no · sin token→200: **sí** |

## Dos modos del token (projects)
La suite arranca **dos backends** y los prueba en paralelo lógico (workers=1):
- **project `on`** (puerto `PORT`, default `4000`): `FACT_TOKEN_MODE` ausente → enforcement. Corre todos los specs **menos** `grace.spec.ts`.
- **project `grace`** (puerto `PORT+1`): `FACT_TOKEN_MODE=grace`. Corre **solo** `grace.spec.ts`.

El build (`tsc`) se hace UNA vez en `global-setup`; ambos backends arrancan con `npm run start` desde el mismo `dist`. Los casos `grace` con BD (sin token → 200) se **saltan** si `E2E_DB!=true`; los sin BD (reobtención → 404) corren siempre.

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

### Correr contra Hostinger `testOrdenar` (sin MySQL local)
El guardrail bloquea el host de prod (`srv1250.hstgr.io`) por default. Para usar la BD de prueba
`testOrdenar` (que vive en ese host) hay una **excepción opt-in**:
1. En `.env.test`: `ALLOW_HOSTINGER_TESTDB=true`, `E2E_DB=true`, `FACTURAMA_URL=http://127.0.0.1:4555`
   (mock), y `DB_GUERRERO_*`/`DB_MADERO_*` con un **usuario Hostinger de mínimo privilegio con GRANT
   solo sobre testOrdenar** (NO el principal). `DB_*_NAME` debe estar en `TEST_DB_ALLOWLIST` (global-setup).
2. Siembra `seed.sql` en `testOrdenar` (rango 990000–990099, aislado de sus datos reales).
3. `npx playwright test --project=grace`.

El opt-in usa **allowlist por nombre EXACTO** (`TEST_DB_ALLOWLIST`): las BD de prod nunca pasan (no están
en la lista y se excluyen explícitamente). Sin el flag, el host de prod sigue bloqueado. (El usuario de
testOrdenar solo puede tocar testOrdenar.)
