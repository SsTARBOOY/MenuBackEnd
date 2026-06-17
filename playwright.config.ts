// server/playwright.config.ts
// Tests de API (sin navegador) del flujo crítico de facturación.
// GUARDRAILS: ver tests/e2e/global-setup.ts — aborta si el entorno huele a producción.
import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

// Carga .env.test en tiempo de config para inyectarlo al backend bajo prueba como env
// REAL del subproceso (precede a cualquier `.env`: dotenv no sobreescribe vars ya puestas).
// Si .env.test no existe, testEnv = {} y global-setup ABORTA antes de arrancar el server.
const testEnv = dotenv.config({ path: path.resolve(process.cwd(), ".env.test") }).parsed ?? {};

const PORT = testEnv.PORT ?? "4000";
const MOCK_PORT = "4555";

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
    baseURL: `http://127.0.0.1:${PORT}`,
    extraHTTPHeaders: { "Content-Type": "application/json" },
  },
  webServer: [
    {
      // Backend bajo prueba. Compila y arranca con el env de PRUEBA inyectado.
      command: "npm run build && npm run start",
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...testEnv,
        NODE_ENV: "test",
        PORT,
        // Sentry/Telegram forzados OFF en pruebas (defensa: aunque .env.test los traiga).
        SENTRY_DSN: "",
        NOTIFY_TELEGRAM_TOKEN: "",
        NOTIFY_TELEGRAM_CHAT_ID: "",
      },
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
