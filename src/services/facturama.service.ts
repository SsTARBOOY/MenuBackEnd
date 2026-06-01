// server/src/services/facturama.service.ts
// ─────────────────────────────────────────────────────────────────
//  La Peña de Santiago · Integración Facturama API Web
//  Docs: https://apisandbox.facturama.mx/Docs
//  Endpoints API Web (sin /api/3/): /Cfdi, /Client, etc.
// ─────────────────────────────────────────────────────────────────

const API_URL = (process.env.FACTURAMA_URL ?? "https://api.facturama.mx").replace(/\/$/, "");

const getAuth = () => {
  const user = process.env.FACTURAMA_USER ?? "";
  const pass = process.env.FACTURAMA_PASS ?? "";
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
};

const mapPaymentForm = (method: string | null): string => {
  const m = (method ?? "").toLowerCase();
  if (m.includes("efectivo") || m.includes("cash"))       return "01";
  if (m.includes("tarjeta") && m.includes("créd"))        return "04";
  if (m.includes("tarjeta") && m.includes("déb"))         return "28";
  if (m.includes("transferencia") || m.includes("trans")) return "03";
  return "01";
};

// ── Interfaces ──────────────────────────────────────────────────
export interface CfdiItem {
  dishName:  string;
  quantity:  number;
  unitPrice: number;
  subtotal:  number;
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
  fecha:         string;
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
  const items = data.items.map((it, idx) => {
    const unitPrice = Number(it.unitPrice.toFixed(6));
    const subtotal  = Number(it.subtotal.toFixed(2));
    const ivaBase   = subtotal;
    const ivaTotal  = Number((ivaBase * 0.16).toFixed(2));
    const total     = Number((subtotal + ivaTotal).toFixed(2));

    return {
      ProductCode:          "90101500",
      IdentificationNumber: String(idx + 1).padStart(3, "0"),
      Description:          it.dishName,
      Unit:                 "Pieza",
      UnitCode:             "H87",
      UnitPrice:            unitPrice,
      Quantity:             it.quantity,
      Subtotal:             subtotal,
      TaxObject:            "02",
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

  const isPublico = data.receiver.rfc.toUpperCase() === "XAXX010101000";
  const now = new Date();

  const body: Record<string, unknown> = {
    NameId:          "1",
    Folio:           data.folio,
    Date:            data.fecha,
    PaymentForm:     mapPaymentForm(data.paymentMethod),
    PaymentMethod:   "PUE",
    ExpeditionPlace: process.env.FACTURAMA_CP ?? "76000",
    CfdiType:        "I",
    Currency:        "MXN",
    ...(isPublico ? {
      GlobalInformation: {
        Periodicity: "04",
        Months:      String(now.getMonth() + 1).padStart(2, "0"),
        Year:        String(now.getFullYear()),
      }
    } : {}),
    Receiver: {
      Rfc:          data.receiver.rfc.toUpperCase(),
      Name:         data.receiver.razonSocial.trim(),
      CfdiUse:      data.receiver.usoCfdi,
      FiscalRegime: data.receiver.regimenFiscal,
      TaxZipCode:   data.receiver.codigoPostal,
    },
    Items: items,
  };

  // ── 1. Crear CFDI ─────────────────────────────────────────────
  // API Web usa /Cfdi (PascalCase, sin /api/3/)
  const createRes = await fetch(`${API_URL}/Cfdi`, {
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
    
    Id: string;
    Folio: string;
    Complement?: { TaxStamp?: { Uuid?: string } };
  };
console.log("[Facturama] CFDI response:", JSON.stringify(cfdi, null, 2));

  const cfdiId = cfdi.Id;
  const uuid   = cfdi.Complement?.TaxStamp?.Uuid ?? "";

  // ── 2. Descargar PDF ──────────────────────────────────────────
  // Formato: /Cfdi/pdf/issued/{id}
  const pdfRes = await fetch(
    `${API_URL}/Cfdi/pdf/issued/${cfdiId}`,
    { headers: { "Authorization": getAuth() } }
  );
  const pdfData = pdfRes.ok
    ? ((await pdfRes.json()) as { Content: string }).Content
    : "";

  // ── 3. Descargar XML ──────────────────────────────────────────
  // Formato: /Cfdi/xml/issued/{id}
  const xmlRes = await fetch(
    `${API_URL}/Cfdi/xml/issued/${cfdiId}`,
    { headers: { "Authorization": getAuth() } }
  );
  const xmlData = xmlRes.ok
    ? ((await xmlRes.json()) as { Content: string }).Content
    : "";

  // ── 4. Enviar por email ───────────────────────────────────────
  await fetch(`${API_URL}/Cfdi/email`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": getAuth(),
    },
    body: JSON.stringify({
      cfdiType: "issued",
      cfdiId,
      email:    data.email,
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