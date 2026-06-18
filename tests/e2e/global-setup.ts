// server/tests/e2e/global-setup.ts
// ─────────────────────────────────────────────────────────────────
//  GUARDRAIL anti-producción. Corre ANTES de arrancar el backend.
//  Si algo huele a prod (Facturama prod, BD prod, o sin opt-in explícito),
//  LANZA y aborta TODA la corrida → imposible quemar folios o ensuciar prod.
// ─────────────────────────────────────────────────────────────────
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Hosts/BD/credenciales de PRODUCCIÓN que jamás deben aparecer en un .env.test.
const PROD_DB_NAMES = ["u522428285_ordenar", "u522428285_maderodenar", "u522428285_maderoOrdenar", "u522428285_lapena_db"];
const PROD_DB_HOST  = "srv1250.hstgr.io";
const FACTURAMA_PROD = /(^|\/\/)(www\.)?api\.facturama\.mx/i; // prod. apisandbox.facturama.mx está OK.

function fail(msg: string): never {
  throw new Error(`\n🛑 GUARDRAIL E2E: ${msg}\n   (revisa server/.env.test — ver tests/e2e/README.md)\n`);
}

export default async function globalSetup(): Promise<void> {
  const envPath = path.resolve(process.cwd(), ".env.test");
  if (!fs.existsSync(envPath)) {
    fail("falta server/.env.test. Copia .env.test.example y rellénalo con SANDBOX/mock + BD de prueba.");
  }
  const env = dotenv.config({ path: envPath }).parsed ?? {};

  // 1) Opt-in explícito: obliga a declarar a conciencia que es entorno de prueba.
  if (env.ALLOW_E2E !== "true") {
    fail("ALLOW_E2E != true. Pon ALLOW_E2E=true en .env.test para confirmar que es entorno de PRUEBA.");
  }

  // 2) Facturama nunca prod.
  const fUrl = env.FACTURAMA_URL ?? "";
  if (!fUrl) fail("FACTURAMA_URL vacío. Usa el mock (http://127.0.0.1:4555) o SANDBOX (apisandbox.facturama.mx).");
  if (FACTURAMA_PROD.test(fUrl)) fail(`FACTURAMA_URL apunta a PRODUCCIÓN (${fUrl}). Prohibido.`);

  // 3) BD nunca prod (por nombre ni por host).
  for (const key of ["DB_GUERRERO_NAME", "DB_MADERO_NAME"]) {
    if (PROD_DB_NAMES.includes(env[key] ?? "")) fail(`${key}=${env[key]} es una BD de PRODUCCIÓN. Usa una BD de prueba.`);
  }
  // Excepción OPT-IN (off por default) para usar la BD de prueba que vive en el host de
  // Hostinger (testOrdenar). ALLOWLIST POR NOMBRE EXACTO — no es un patrón ni apaga el
  // chequeo: solo las BD listadas aquí pasan; cualquier otro nombre en el host de prod se
  // bloquea. Las BD de prod NO están en la lista (y además se excluyen explícitamente, ver
  // `!PROD_DB_NAMES.includes`). Sin el flag, el host de prod sigue bloqueado igual que antes.
  // Mitigación extra: el usuario de testOrdenar en Hostinger solo puede tocar testOrdenar.
  const TEST_DB_ALLOWLIST = ["u522428285_testOrdenar"]; // ⚠️ confirma/ajusta al nombre EXACTO de tu BD de prueba
  const ALLOW_HOSTINGER_TESTDB = env.ALLOW_HOSTINGER_TESTDB === "true";
  for (const key of ["DB_GUERRERO_HOST", "DB_MADERO_HOST"]) {
    const nameKey = key.replace("_HOST", "_NAME");
    const name = env[nameKey] ?? "";
    // Bloquea el fallback silencioso a prod cuando la var viene vacía.
    if (!env[key]) fail(`${key} vacío → el pool caería al host de PROD por default. Defínelo a tu BD de prueba.`);
    if (env[key] === PROD_DB_HOST) {
      // Cinturón y tirantes: nombre en la allowlist EXACTA y, además, jamás un nombre de prod.
      const allowed = ALLOW_HOSTINGER_TESTDB && TEST_DB_ALLOWLIST.includes(name) && !PROD_DB_NAMES.includes(name);
      if (!allowed) {
        fail(`${key}=${PROD_DB_HOST} es el host de PRODUCCIÓN. Solo con ALLOW_HOSTINGER_TESTDB=true y ${nameKey} en la allowlist exacta [${TEST_DB_ALLOWLIST.join(", ")}]. Actual: ${name || "(vacío)"}.`);
      }
    }
  }

  // 4) Observabilidad apagada en pruebas (no mandar nada a Sentry/Telegram reales).
  if (env.SENTRY_DSN) fail("SENTRY_DSN no debe estar en .env.test (las pruebas no envían a Sentry).");
  if (env.NOTIFY_TELEGRAM_TOKEN) fail("NOTIFY_TELEGRAM_TOKEN no debe estar en .env.test.");

  // eslint-disable-next-line no-console
  console.log(`✅ Guardrail E2E OK · Facturama=${fUrl} · BD=${env.DB_GUERRERO_NAME}/${env.DB_MADERO_NAME}`);

  // Compila el backend UNA sola vez aquí: ambos webServers (project "on" y "grace") arrancan
  // con `npm run start` desde el MISMO dist → evita dos `tsc` concurrentes en condición de carrera.
  const { execSync } = await import("node:child_process");
  // eslint-disable-next-line no-console
  console.log("⚙️  Compilando backend (tsc) para los webServers on/grace…");
  execSync("npm run build", { stdio: "inherit" });
}
