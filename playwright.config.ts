// server/playwright.config.ts
// Tests de API (sin navegador) del flujo crítico de facturación.
// GUARDRAILS: ver tests/e2e/global-setup.ts — aborta si el entorno huele a producción.
//
// Dos modos del candado del token, cada uno con su backend y su project Playwright:
//   · project "on"    → backend en PORT          (FACT_TOKEN_MODE ausente → "on", enforcement).
//   · project "grace" → backend en PORT+1         (FACT_TOKEN_MODE=grace, token opcional).
// El build (tsc) se hace UNA vez en global-setup → ambos arrancan con `npm run start`.
import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

// Carga .env.test en tiempo de config para inyectarlo al backend bajo prueba como env
// REAL del subproceso (precede a cualquier `.env`: dotenv no sobreescribe vars ya puestas).
// Si .env.test no existe, testEnv = {} y global-setup ABORTA antes de arrancar el server.
const testEnv = dotenv.config({ path: path.resolve(process.cwd(), ".env.test") }).parsed ?? {};

const PORT = testEnv.PORT ?? "4000";
const PORT_GRACE = String(Number(PORT) + 1);
const MOCK_PORT = "4555";

// Env común de ambos backends; Sentry/Telegram forzados OFF (defensa aunque .env.test los traiga).
const backendEnv = {
  ...testEnv,
  NODE_ENV: "test",
  SENTRY_DSN: "",
  NOTIFY_TELEGRAM_TOKEN: "",
  NOTIFY_TELEGRAM_CHAT_ID: "",
};

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  reporter: [["html", { open: "never" }], ["list"]],
  // Serializa: las pruebas con BD comparten estado; nada de carreras.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  use: {
    extraHTTPHeaders: { "Content-Type": "application/json" },
  },
  projects: [
    {
      name: "on",                       // enforcement por defecto (FACT_TOKEN_MODE ausente → on)
      testIgnore: /grace\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${PORT}` },
    },
    {
      name: "grace",                    // backend con FACT_TOKEN_MODE=grace
      testMatch: /grace\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${PORT_GRACE}` },
    },
  ],
  webServer: [
    {
      // Backend "on" (build ya hecho en global-setup).
      command: "npm run start",
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...backendEnv, PORT },
    },
    {
      // Backend "grace" (mismo dist, otro puerto, FACT_TOKEN_MODE=grace).
      command: "npm run start",
      url: `http://127.0.0.1:${PORT_GRACE}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...backendEnv, PORT: PORT_GRACE, FACT_TOKEN_MODE: "grace" },
    },
    {
      // Mock de Facturama (determinista, CERO folios). El backend apunta aquí vía FACTURAMA_URL.
      command: `node tests/e2e/facturama-mock.mjs`,
      url: `http://127.0.0.1:${MOCK_PORT}/__health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { MOCK_PORT },
    },
  ],
});
