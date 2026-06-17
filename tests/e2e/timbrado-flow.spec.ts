// server/tests/e2e/timbrado-flow.spec.ts
// Flujo crítico contra el MOCK de Facturama (determinista, CERO folios) + BD de prueba.
// Cubre: (1) fallo → reintentable + 422/503 · (2) reintento sin 409 · (3) OK → procesada+UUID
//        · (5) IVA extraído 16% en el cuerpo enviado al PAC.
// Se SALTA si no hay BD de prueba (E2E_DB=true). Ver README + seed.sql.
import { test, expect } from "@playwright/test";
import { armMock, mockLastCfdiBody, receptorValido, DB_READY } from "./helpers";

test.describe("Flujo crítico de timbrado (mock + BD)", () => {
  test.skip(!DB_READY, "Requiere BD de prueba seedeada (E2E_DB=true). Ver README + seed.sql.");

  const sol = (orderId: number, t: string, extra: Record<string, unknown> = {}) => ({
    data: { ...receptorValido, sucursal: "guerrero", orderId, t, ...extra },
  });

  test("(1)+(2) rechazo del PAC → 422 reintentable, y el reintento NO da 409", async ({ request }) => {
    // 1) El PAC rechaza → 422 accionable (no 201), y la solicitud queda reintentable (cancelada).
    await armMock(request, "reject");
    const fail = await request.post("/api/facturas/solicitar", sol(990001, "TOKEN001"));
    expect(fail.status()).toBe(422);
    const failBody = await fail.json();
    expect(failBody.error).toBe("facturama_rechazo");
    expect(failBody.message).toBeTruthy();           // mensaje claro al cliente, no el crudo del PAC
    expect(failBody.reintentable).toBe(true);

    // 2) Reintento de la MISMA orden: si hubiera quedado trabada en 'pendiente' daría 409.
    //    Como revirtió a 'cancelada', el reintento procede y timbra.
    await armMock(request, "ok");
    const retry = await request.post("/api/facturas/solicitar", sol(990001, "TOKEN001"));
    expect(retry.status()).toBe(201);
    const retryBody = await retry.json();
    expect(retryBody.success).toBe(true);
    expect(retryBody.uuid).toBeTruthy();
  });

  test("(1b) servicio caído → 503 (no 201) y orden no bloqueada", async ({ request }) => {
    await armMock(request, "unavailable");
    const res = await request.post("/api/facturas/solicitar", sol(990002, "TOKEN002"));
    expect(res.status()).toBe(503);
    expect((await res.json()).error).toBe("facturama_no_disponible");
  });

  test("(3) timbrado OK → 'procesada' con UUID, visible en GET /orden", async ({ request }) => {
    await armMock(request, "ok");
    const res = await request.post("/api/facturas/solicitar", sol(990003, "TOKEN003"));
    expect(res.status()).toBe(201);
    const uuid = (await res.json()).uuid;
    expect(uuid).toBeTruthy();

    // La factura emitida queda asociada a la orden (status procesada → factura.uuid).
    const orden = await request.get("/api/facturas/orden/990003?sucursal=guerrero&t=TOKEN003");
    expect(orden.ok()).toBeTruthy();
    expect((await orden.json()).factura?.uuid).toBe(uuid);
  });

  test("(5) el cuerpo enviado al PAC EXTRAE el IVA (precio $200 → base 172.41 + IVA 27.59)", async ({ request }) => {
    await armMock(request, "ok");
    const res = await request.post("/api/facturas/solicitar", sol(990004, "TOKEN004"));
    expect(res.status()).toBe(201);

    const body = await mockLastCfdiBody(request);
    const item = body.Items[0];
    expect(item.Taxes[0].Rate).toBe(0.16);
    expect(item.Subtotal).toBe(172.41);          // base SIN IVA
    expect(item.Taxes[0].Total).toBe(27.59);     // IVA extraído
    expect(item.Total).toBe(200);                // total = lo cobrado en caja (NO ×1.16)
  });
});
