// server/src/instrument.ts
// ─────────────────────────────────────────────────────────────────
//  Inicialización de Sentry. DEBE importarse ANTES que cualquier otro
//  módulo (Express, controladores…) para que la auto-instrumentación
//  enganche. Ver primera línea de index.ts.
//
//  INERTE sin SENTRY_DSN: si la env var no está, Sentry no envía nada
//  (no rompe nada en local ni si se despliega sin configurar el DSN).
//  NO se manda PII (RFC, correos de clientes) → sendDefaultPii: false,
//  acorde a la postura de seguridad del proyecto.
// ─────────────────────────────────────────────────────────────────
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,                              // sin DSN ⇒ Sentry queda inerte (no transporta)
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "production",
  // Atar cada error al commit desplegado (mismo SHA que /api/health.commit).
  release: process.env.SOURCE_COMMIT ?? process.env.GIT_COMMIT_SHA ?? undefined,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
  sendDefaultPii: false,           // nunca mandar RFC/emails/headers de auth a Sentry
});
