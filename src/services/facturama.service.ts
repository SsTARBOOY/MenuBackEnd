// server/src/services/facturama.service.ts
// ─────────────────────────────────────────────────────────────────
//  La Peña de Santiago · Integración Facturama API
//  Docs: https://api.facturama.mx/docs
// ─────────────────────────────────────────────────────────────────

const API_URL = (process.env.FACTURAMA_URL ?? "https://api.facturama.mx").replace(/\/$/, "");

// Credenciales vienen del .env
const getAuth = () => {
  const user = process.env.FACTURAMA_USER ?? "";
  const pass = process.env.FACTURAMA_PASS ?? "";
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
};

// ── Mapeo método de pago → clave SAT ───────────────────────────
const mapPaymentForm = (method: string | null): string => {
  const m = (method ?? "").toLowerCase();
  if (m.includes("efectivo") || m.includes("cash"))      return "01";
  if (m.includes("tarjeta") && m.includes("créd"))       return "04";
  if (m.includes("tarjeta") && m.includes("déb"))        return "28";
  if (m.includes("transferencia") || m.includes("trans")) return "03";
  return "01"; // efectivo por default
};

// ── Interfaces ──────────────────────────────────────────────────
export interface CfdiItem {
  dishName:  string;
  quantity:  number;
  unitPrice: number; // sin IVA
  subtotal:  number; // quantity × unitPrice, sin IVA
}

export interface CfdiReceiver {
  rfc:           string;
  razonSocial:   string;
  regimenFiscal: string;
  codigoPostal:  string;
  usoCfdi:       string;
}

export interface CfdiRequest {
  folio:         string;
  fecha:         string; // ISO: "2026-05-30T12:00:00"
  paymentMethod: string | null;
  receiver:      CfdiReceiver;
  items:         CfdiItem[];
  email:         string;
}

export interface CfdiResult {
  cfdiId:    string;
  uuid:      string;
  folio:     string;
  pdfBase64: string;
  xmlBase64: string;
}

// ── Crear CFDI 4.0 (Ingreso) ────────────────────────────────────
export async function crearCfdi(data: CfdiRequest): Promise<CfdiResult> {
  // Construir items con IVA 16% trasladado
  const items = data.items.map((it, idx) => {
    const unitPrice = Number(it.unitPrice.toFixed(6));
    const subtotal  = Number(it.subtotal.toFixed(2));
    const ivaBase   = subtotal;
    const ivaTotal  = Number((ivaBase * 0.16).toFixed(2));
    const total     = Number((subtotal + ivaTotal).toFixed(2));

    return {
      ProductCode:           "90101500",
      IdentificationNumber:  String(idx + 1).padStart(3, "0"),
      Description:           it.dishName,
      Unit:                  "Pieza",
      UnitCode:              "H87",
      UnitPrice:             unitPrice,
      Quantity:              it.quantity,
      Subtotal:              subtotal,
      TaxObject:             "02",
      Taxes: [
        {
          Total:       ivaTotal,
          Name:        "IVA",
          Base:        ivaBase,
          Rate:        0.16,
          IsRetention: false,
        },
      ],
      Total: total,
    };
  });

  const body = {
    NameId:          "1",
    Folio:           data.folio,
    Date:            data.fecha,
    PaymentForm:     mapPaymentForm(data.paymentMethod),
    PaymentMethod:   "PUE",                     // Pago en una sola exhibición
    ExpeditionPlace: process.env.FACTURAMA_CP ?? "76000",
    CfdiType:        "I",                       // Ingreso
    Currency:        "MXN",
    Receiver: {
      Rfc:           data.receiver.rfc.toUpperCase(),
      Name:          data.receiver.razonSocial.trim(),
      CfdiUse:       data.receiver.usoCfdi,
      FiscalRegime:  data.receiver.regimenFiscal,
      TaxZipCode:    data.receiver.codigoPostal,
    },
    Items: items,
  };

  // ── 1. Crear CFDI ────────────────────────────────────────────
  const createRes = await fetch(`${API_URL}/api/3/cfdis`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": getAuth(),
    },
    body: JSON.stringify(body),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Facturama error al crear CFDI: ${createRes.status} – ${err}`);
  }

  const cfdi = await createRes.json() as {
    Id: string; Folio: string;
    Complement?: { TaxStamp?: { Uuid?: string } };
  };

  const cfdiId = cfdi.Id;
  const uuid   = cfdi.Complement?.TaxStamp?.Uuid ?? "";

  // ── 2. Descargar PDF (base64) ────────────────────────────────
  const pdfRes = await fetch(
    `${API_URL}/api/3/cfdis/${cfdiId}/pdf`,
    { headers: { "Authorization": getAuth() } }
  );
  const pdfData = pdfRes.ok
    ? ((await pdfRes.json()) as { Content: string }).Content
    : "";

  // ── 3. Descargar XML (base64) ────────────────────────────────
  const xmlRes = await fetch(
    `${API_URL}/api/3/cfdis/${cfdiId}/xml`,
    { headers: { "Authorization": getAuth() } }
  );
  const xmlData = xmlRes.ok
    ? ((await xmlRes.json()) as { Content: string }).Content
    : "";

  // ── 4. Enviar por email (vía Facturama) ─────────────────────
  await fetch(`${API_URL}/api/3/cfdis/SendEmail`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": getAuth(),
    },
    body: JSON.stringify({
      cfdiType: "I",
      cfdiId,
      email: data.email,
    }),
  });

  return {
    cfdiId,
    uuid,
    folio:     cfdi.Folio,
    pdfBase64: pdfData,
    xmlBase64: xmlData,
  };
}