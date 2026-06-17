// server/tests/e2e/helpers.ts
import type { APIRequestContext } from "@playwright/test";
import crypto from "node:crypto";
import dotenv from "dotenv";
import path from "path";

// Carga .env.test también en el proceso de tests (para TOKEN_SECRET y los gates).
dotenv.config({ path: path.resolve(process.cwd(), ".env.test") });

export const MOCK_URL = `http://127.0.0.1:${process.env.MOCK_PORT ?? "4555"}`;

// ¿Hay BD de prueba lista? Las pruebas que consultan la BD se SALTAN si no.
export const DB_READY = process.env.E2E_DB === "true";

// Arma el siguiente comportamiento del mock de Facturama.
export async function armMock(request: APIRequestContext, scenario: "ok" | "reject" | "unavailable"): Promise<void> {
  const res = await request.post(`${MOCK_URL}/__arm`, { data: { scenario } });
  if (!res.ok()) throw new Error(`No se pudo armar el mock (${res.status()})`);
}

// Último body recibido por el mock en POST /3/cfdis (para asertar el IVA enviado al PAC).
export async function mockLastCfdiBody(request: APIRequestContext): Promise<any> {
  const res = await request.get(`${MOCK_URL}/__last`);
  return (await res.json()).body;
}

// Firma un JWT admin con el MISMO esquema que auth.ts (HS256, base64, payload {sub,rol,exp}).
export function signAdminToken(secret = process.env.TOKEN_SECRET ?? ""): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64");
  const header  = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ sub: 1, rol: "admin", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64");
  return `${header}.${payload}.${sig}`;
}

// Cuerpo válido para POST /solicitar (receptor real persona física). El folio/token se inyectan.
export const receptorValido = {
  rfc: "PEHT850101AAA",
  razonSocial: "RODOLFO ESTEBAN PEREZ HATCH",
  regimenFiscal: "626",
  codigoPostal: "53126",
  usoCfdi: "G03",
  email: "cliente@example.com",
  formaPago: "01",
};
