// server/tests/e2e/grace.spec.ts
// Modo GRACIA (FACT_TOKEN_MODE=grace). Este archivo corre SOLO bajo el project "grace"
// (ver playwright.config: webServer en PORT+1 arrancado con FACT_TOKEN_MODE=grace).
// Valida que durante la transición del POS:
//   · el token sea OPCIONAL en getOrden/solicitar (facturación pública sigue viva),
//   · un token PROVISTO se siga validando (no se acepta uno incorrecto),
//   · la REOBTENCIÓN (descargar/reenviar) NO se relaje (sirve CFDI emitido / PII).
import { test, expect } from "@playwright/test";
import { DB_READY, receptorValido } from "./helpers";

test.describe("(grace) token opcional — sin BD", () => {
  // Reobtención sigue ESTRICTA aun en grace: sin token → 404 (no toca BD, gate previo).
  test("GET /factura/:id/documento sin token → 404 (reobtención estricta en grace)", async ({ request }) => {
    const res = await request.get("/api/facturas/factura/990001/documento?sucursal=guerrero");
    expect(res.status()).toBe(404);
  });

  test("POST /factura/:id/reenviar sin token → 404 (reobtención estricta en grace)", async ({ request }) => {
    const res = await request.post("/api/facturas/factura/990001/reenviar?sucursal=guerrero", { data: {} });
    expect(res.status()).toBe(404);
  });

  // sucursal sigue siendo obligatoria (gate previo al token, igual en ambos modos).
  test("GET /orden sin sucursal → 400 (aun en grace)", async ({ request }) => {
    const res = await request.get("/api/facturas/orden/990001");
    expect(res.status()).toBe(400);
  });
});

test.describe("(grace) token opcional — con BD", () => {
  test.skip(!DB_READY, "Requiere BD de prueba seedeada (E2E_DB=true). Ver README.");

  test("GET /orden SIN token → 200 (folio+ventana; facturación pública sigue viva)", async ({ request }) => {
    const res = await request.get("/api/facturas/orden/990001?sucursal=guerrero");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.order?.folio ?? body.order?.id).toBeTruthy();
  });

  test("GET /orden con token CORRECTO → 200 (sigue validando si viene)", async ({ request }) => {
    const res = await request.get("/api/facturas/orden/990002?sucursal=guerrero&t=TOKEN002");
    expect(res.status()).toBe(200);
  });

  test("GET /orden con token INCORRECTO → 404 (grace NO acepta un token provisto malo)", async ({ request }) => {
    const res = await request.get("/api/facturas/orden/990001?sucursal=guerrero&t=TOKENMALO");
    expect(res.status()).toBe(404);
  });

  test("POST /solicitar SIN token → NO 404 (el gate del token se omite en grace)", async ({ request }) => {
    const res = await request.post("/api/facturas/solicitar",
      { data: { ...receptorValido, sucursal: "guerrero", orderId: 990004 } });
    expect(res.status()).not.toBe(404);
  });
});
