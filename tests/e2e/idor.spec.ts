// server/tests/e2e/idor.spec.ts
// (4) IDOR bloqueado: sin prueba de posesión del ticket (token) NO se abre ninguna orden,
// y todo fallo colapsa al MISMO 404 genérico (sin oráculo de existencia).
import { test, expect } from "@playwright/test";
import { DB_READY } from "./helpers";

const receptor = { sucursal: "guerrero", orderId: 990001, rfc: "PEHT850101AAA",
  razonSocial: "RODOLFO ESTEBAN PEREZ HATCH", regimenFiscal: "626",
  codigoPostal: "53126", usoCfdi: "G03", email: "c@example.com", formaPago: "01" };

test.describe("(4) IDOR — sin BD", () => {
  test("GET /orden sin token → 404 genérico (no revela existencia)", async ({ request }) => {
    const res = await request.get("/api/facturas/orden/990001?sucursal=guerrero");
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("No encontramos tu orden");
  });

  test("GET /orden sin sucursal → 400", async ({ request }) => {
    const res = await request.get("/api/facturas/orden/990001");
    expect(res.status()).toBe(400);
  });

  test("POST /solicitar sin token → 404 (exige posesión del ticket)", async ({ request }) => {
    const res = await request.post("/api/facturas/solicitar", { data: receptor });
    expect(res.status()).toBe(404);
  });
});

test.describe("(4) IDOR — con BD", () => {
  test.skip(!DB_READY, "Requiere BD de prueba seedeada (E2E_DB=true). Ver README.");

  test("GET /orden con token INCORRECTO → 404 (sin oráculo)", async ({ request }) => {
    const res = await request.get("/api/facturas/orden/990001?sucursal=guerrero&t=TOKENMALO");
    expect(res.status()).toBe(404);
  });
});
