// server/tests/e2e/iva.spec.ts
// (5) IVA EXTRAÍDO (no sumado): el precio YA incluye IVA → base = precio/1.16, total = precio.
// Prueba pura de extraerIva (sin BD ni Facturama) → determinista y siempre ejecutable.
import { test, expect } from "@playwright/test";
import { extraerIva } from "../../src/services/facturama.service";

test.describe("(5) IVA extraído del precio (16% incluido)", () => {
  const casos = [
    { precio: 200, base: 172.41, iva: 27.59 },
    { precio: 116, base: 100.0, iva: 16.0 },
    { precio: 99.99, base: 86.2, iva: 13.79 },
    { precio: 1, base: 0.86, iva: 0.14 },
  ];

  for (const c of casos) {
    test(`$${c.precio} → base $${c.base} + IVA $${c.iva} = total $${c.precio}`, () => {
      const r = extraerIva(c.precio);
      expect(r.base).toBe(c.base);
      expect(r.iva).toBe(c.iva);
      expect(r.total).toBe(Number(c.precio.toFixed(2)));
      // Invariante: base + iva = total al centavo (cuadra con caja, no infla 16%).
      expect(Number((r.base + r.iva).toFixed(2))).toBe(r.total);
      // El IVA es EXTRAÍDO, no sumado: total NO es precio×1.16.
      expect(r.total).not.toBe(Number((c.precio * 1.16).toFixed(2)));
    });
  }
});
