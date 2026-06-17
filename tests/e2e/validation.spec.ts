// server/tests/e2e/validation.spec.ts
// Validación de entrada de POST /solicitar. Todos estos caminos responden ANTES de tocar
// la BD o Facturama → ejecutables sin BD ni folios.
import { test, expect } from "@playwright/test";

const base = { sucursal: "guerrero", orderId: 990001, rfc: "PEHT850101AAA",
  razonSocial: "RODOLFO ESTEBAN PEREZ HATCH", regimenFiscal: "626",
  codigoPostal: "53126", usoCfdi: "G03", email: "c@example.com" };

test.describe("Validación de entrada (sin BD)", () => {
  test("sucursal inválida → 400", async ({ request }) => {
    const res = await request.post("/api/facturas/solicitar", { data: { ...base, sucursal: "otra" } });
    expect(res.status()).toBe(400);
  });

  test("faltan campos obligatorios → 400", async ({ request }) => {
    const res = await request.post("/api/facturas/solicitar", { data: { sucursal: "guerrero", orderId: 990001 } });
    expect(res.status()).toBe(400);
  });

  test("RFC inválido → 400", async ({ request }) => {
    const res = await request.post("/api/facturas/solicitar", { data: { ...base, rfc: "NOPE" } });
    expect(res.status()).toBe(400);
  });

  test("CP inválido → 400", async ({ request }) => {
    const res = await request.post("/api/facturas/solicitar", { data: { ...base, codigoPostal: "7600" } });
    expect(res.status()).toBe(400);
  });

  test("combo régimen/persona inválido → 422 accionable", async ({ request }) => {
    // RFC de 12 (persona MORAL) con régimen 612 (solo persona física) → rechazo local antes del PAC.
    const res = await request.post("/api/facturas/solicitar", {
      data: { ...base, rfc: "ABC120101AB1", regimenFiscal: "612", usoCfdi: "G03" },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.message).toBeTruthy();        // mensaje claro, no error crudo
    expect(body.reintentable).toBe(true);
  });
});
