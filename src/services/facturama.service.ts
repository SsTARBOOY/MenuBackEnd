// server/src/services/facturama.service.ts
// ─────────────────────────────────────────────────────────────────
//  La Peña de Santiago · Integración Facturama API Web
//  Docs: https://apisandbox.facturama.mx/Docs
//  Crear:    POST  /3/cfdis
//  Descargar: GET  /Cfdi/{format}/issued/{id}
//  Email:    POST  /cfdi?CfdiType=issued&CfdiId={id}&Email={email}
// ─────────────────────────────────────────────────────────────────

const API_URL = (process.env.FACTURAMA_URL ?? "https://api.facturama.mx").replace(/\/$/, "");
const FACTURAMA_TIMEOUT_MS = Number(process.env.FACTURAMA_TIMEOUT_MS ?? "20000");

const getAuth = () => {
  const user = process.env.FACTURAMA_USER ?? "";
  const pass = process.env.FACTURAMA_PASS ?? "";
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
};

// ── Forma de pago (catálogo SAT c_FormaPago) ─────────────────────
// Con PaymentMethod = "PUE" la FormaPago debe reflejar el pago real; por eso
// NUNCA se defaultea a Efectivo. Claves soportadas por La Peña (validado por
// legal-fiscal): 01 Efectivo · 03 Transferencia · 04 T. crédito · 28 T. débito.
export const FORMAS_PAGO_VALIDAS = new Set(["01", "03", "04", "28"]);

// Type guard: estrecha a `string` cuando la clave pertenece al catálogo soportado.
export const isFormaPagoValida = (clave: string | null | undefined): clave is string =>
  typeof clave === "string" && FORMAS_PAGO_VALIDAS.has(clave);

// Mapea el texto libre de la orden a una clave SAT c_FormaPago.
// Devuelve null cuando NO se puede determinar con confianza (p. ej. "Pending",
// null, vacío o ambiguo) — el llamador decide (exigir captura explícita).
// Exportada para que el controlador la reutilice al resolver la forma de pago.
export const mapPaymentForm = (method: string | null): string | null => {
  const m = (method ?? "").trim().toLowerCase();
  if (!m) return null;

  // Clave SAT cruda ya capturada (p. ej. el portal manda "28").
  if (FORMAS_PAGO_VALIDAS.has(m)) return m;

  if (m.includes("efectivo") || m.includes("cash")) return "01";
  if (m.includes("transferencia") || m.includes("transfer") || m.includes("spei")) return "03";
  // Débito / crédito, con o SIN la palabra "tarjeta", con o sin acento.
  if (m.includes("déb") || m.includes("deb")) return "28";
  if (m.includes("créd") || m.includes("cred")) return "04";

  return null;
};

// ── Normalización del Nombre del receptor (decisión fiscal de Oscar) ──
// CFDI 4.0: el Nombre debe coincidir EXACTO con el padrón del SAT, que CONSERVA
// acentos y Ñ. Por eso SOLO se normaliza casing y espacios — NUNCA se quitan
// acentos (quitarlos crea mismatches nuevos; confirmado por legal-fiscal).
export const normalizeReceiverName = (raw: string): string =>
  (raw ?? "").replace(/\s+/g, " ").trim().toUpperCase();

// ── Validación fiscal local del receptor (sin llamar al SAT) ─────────────────────
// Matriz confirmada por legal-fiscal (2026-06-15) contra c_RegimenFiscal y c_UsoCFDI
// del Anexo 20 CFDI 4.0, filtrada a los catálogos que ofrece el portal. El objetivo es
// rechazar combinaciones inválidas ANTES de timbrar y no dejárselas al PAC.
export const RFC_PUBLICO_GENERAL = "XAXX010101000";
export const RFC_EXTRANJERO      = "XEXX010101000";

// Valores que SIEMPRE se fuerzan para el receptor público en general (XAXX).
// "PUBLICO EN GENERAL" va SIN acento: el genérico no se valida contra padrón y los PAC
// esperan esa cadena exacta (por eso NO pasa por normalizeReceiverName).
export const PUBLICO_GENERAL = {
  name:          "PUBLICO EN GENERAL",
  usoCfdi:       "S01",
  regimenFiscal: "616",
} as const;

// Régimen receptor admisible por tipo de persona (longitud de RFC: 13=física, 12=moral).
const REGIMENES_MORAL  = new Set(["601", "603", "616", "626"]);
const REGIMENES_FISICA = new Set(["605", "606", "608", "612", "614", "616", "625", "626"]);

// Uso CFDI → regímenes receptores con los que es válido (subset del portal).
const USO_REGIMENES_VALIDOS: Record<string, string[]> = {
  G01:  ["601", "603", "606", "612", "625", "626"],
  G02:  ["601", "603", "606", "612", "625", "626"],
  G03:  ["601", "603", "605", "606", "608", "612", "616", "625", "626"],
  I01:  ["601", "606", "612", "625", "626"],
  I04:  ["601", "606", "612", "625", "626"],
  D01:  ["605", "606", "608", "612", "614", "616", "625", "626"],
  D03:  ["605", "606", "608", "612", "614", "616", "625", "626"],
  D10:  ["605", "606", "608", "612", "614", "616", "625", "626"],
  S01:  ["601", "603", "605", "606", "608", "612", "614", "616", "625", "626"],
  CP01: ["601", "603", "605", "606", "608", "612", "614", "616", "625", "626"],
};

export interface ComboFiscalInput { rfc: string; regimenFiscal: string; usoCfdi: string; }
export type ComboFiscalResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

// Valida coherencia receptor↔régimen↔uso. El público en general (XAXX) se exime: sus
// valores se fuerzan en crearCfdi. El genérico extranjero (XEXX) se rechaza (faltan
// ResidenciaFiscal/NumRegIdTrib que el portal no captura).
export function validarComboFiscal(input: ComboFiscalInput): ComboFiscalResult {
  const rfc = (input.rfc ?? "").toUpperCase().trim();
  const { regimenFiscal, usoCfdi } = input;

  if (rfc === RFC_PUBLICO_GENERAL) return { ok: true }; // valores forzados aguas abajo
  if (rfc === RFC_EXTRANJERO) {
    return {
      ok: false, code: "rfc_extranjero",
      message: "La facturación a RFC genérico extranjero (XEXX010101000) no está disponible en este portal. Escríbenos a info@lapeñadesantiago.com para emitir tu comprobante.",
    };
  }

  const esFisica = rfc.length === 13;
  const esMoral  = rfc.length === 12;
  if (!esFisica && !esMoral) {
    return { ok: false, code: "rfc_invalido", message: "El RFC no tiene una longitud válida (12 para persona moral, 13 para persona física)." };
  }

  const regimenesPersona = esMoral ? REGIMENES_MORAL : REGIMENES_FISICA;
  if (!regimenesPersona.has(regimenFiscal)) {
    return {
      ok: false, code: "regimen_persona",
      message: esMoral
        ? "El régimen fiscal seleccionado no aplica a personas morales (RFC de 12 caracteres). Verifica tu Constancia de Situación Fiscal."
        : "El régimen fiscal seleccionado no aplica a personas físicas (RFC de 13 caracteres). Verifica tu Constancia de Situación Fiscal.",
    };
  }

  const usosValidos = USO_REGIMENES_VALIDOS[usoCfdi];
  if (!usosValidos) {
    return { ok: false, code: "uso_desconocido", message: "El Uso de CFDI seleccionado no es válido." };
  }
  if (!usosValidos.includes(regimenFiscal)) {
    return {
      ok: false, code: "uso_regimen",
      message: "El Uso de CFDI no es compatible con tu régimen fiscal. Elige un uso permitido para tu régimen (p. ej. «Gastos en general, G03») o corrige tu régimen.",
    };
  }
  return { ok: true };
}

// ── Errores tipados para distinguir "rechazo del SAT/PAC" de "servicio caído" ──
// Grupo C/H: el controlador los traduce a 422 (rechazo accionable) vs 503 (reintenta luego).
export class FacturamaRejectionError extends Error {
  constructor(public detail: string, public status: number) {
    super("FACTURAMA_RECHAZO");
    this.name = "FacturamaRejectionError";
  }
}
export class FacturamaUnavailableError extends Error {
  constructor(public detail: string) {
    super("FACTURAMA_NO_DISPONIBLE");
    this.name = "FacturamaUnavailableError";
  }
}

// Extrae un mensaje legible del cuerpo de error de Facturama, SIN volcar PII.
export function parseFacturamaError(raw: string): string {
  try {
    const j = JSON.parse(raw) as { Message?: string; ModelState?: Record<string, string[]> };
    if (j.ModelState) {
      const msgs = Object.values(j.ModelState).flat().filter(Boolean);
      if (msgs.length) return String(msgs[0]).slice(0, 300);
    }
    if (j.Message) return String(j.Message).slice(0, 300);
  } catch { /* no era JSON */ }
  return (raw ?? "").slice(0, 300);
}

// fetch con timeout que normaliza fallos de red/timeout a FacturamaUnavailableError.
async function facturamaFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FACTURAMA_TIMEOUT_MS) });
  } catch (e: any) {
    const reason = e?.name === "TimeoutError" ? "timeout" : (e?.name ?? "network_error");
    throw new FacturamaUnavailableError(reason);
  }
}

// ── Interfaces ──────────────────────────────────────────────────
export interface CfdiItem {
  dishName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface CfdiReceiver {
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  codigoPostal: string;
  usoCfdi: string;
}

export interface CfdiRequest {
  folio: string;
  fecha: string;
  // Clave SAT c_FormaPago ya resuelta por el controlador (Grupo 2).
  formaPago?: string;
  // Compat/fallback: texto libre de la orden (se mapea si no llega formaPago).
  paymentMethod?: string | null;
  receiver: CfdiReceiver;
  items: CfdiItem[];
  email: string;
}

export interface CfdiResult {
  cfdiId: string;
  uuid: string;
  folio: string;
  pdfBase64: string;
  xmlBase64: string;
}

// ── Grupo F: pre-validación del receptor contra el SAT (scaffold fail-open) ──
// ⚠️ La API de Facturama no expone (en la skill /cfdi-facturama) un endpoint
// confirmado de validación contra la lista de RFC inscritos (LCO). Hasta
// confirmarlo, esta función queda DESACTIVADA por env y devuelve verificado=false
// (fail-open): el llamador debe proceder a timbrar con normalidad.
// Para activarla: FACTURAMA_VALIDATE_ENABLED=true + FACTURAMA_VALIDATE_URL=<endpoint real>.
export interface ReceptorValidationInput {
  rfc: string;
  name: string;
  regimenFiscal: string;
  codigoPostal: string;
}
export interface ReceptorValidationResult {
  valido: boolean;
  verificado: boolean;   // false => no se pudo verificar; NO bloquear el timbrado
  motivo?: string;
}

export async function validarReceptorSat(
  input: ReceptorValidationInput
): Promise<ReceptorValidationResult> {
  if (process.env.FACTURAMA_VALIDATE_ENABLED !== "true") {
    return { valido: true, verificado: false };
  }
  const base = process.env.FACTURAMA_VALIDATE_URL;
  if (!base) return { valido: true, verificado: false };

  try {
    const url = `${base}?rfc=${encodeURIComponent(input.rfc)}`;
    const res = await facturamaFetch(url, { headers: { Authorization: getAuth() } });
    if (!res.ok) return { valido: true, verificado: false }; // fail-open ante error del endpoint
    const data = await res.json() as { valid?: boolean; isValid?: boolean; message?: string };
    const valido = Boolean(data?.valid ?? data?.isValid);
    return { valido, verificado: true, motivo: valido ? undefined : (data?.message ?? "RFC/Nombre no validado por el SAT") };
  } catch {
    return { valido: true, verificado: false }; // fail-open ante caída/timeout
  }
}

// ── IVA: EXTRAER, no sumar (precios con IVA incluido) ────────────
// Decisión confirmada por el contador (2026-06-15): el precio de la orden YA INCLUYE
// el IVA = exactamente lo que pagó el cliente en caja. El CFDI lo EXTRAE, NUNCA lo suma:
//   base  = precioConIva / 1.16            (subtotal/Importe, sin IVA)
//   iva   = precioConIva − base            (exacto a 2 decimales; base + iva = precioConIva)
//   total = precioConIva                   (= el precio de la orden, NO × 1.16)
// Ej.: $200 → base $172.41 + IVA $27.59 = TOTAL $200.00.
//
// Cuadre EXACTO: como cada línea aporta su precioConIva al Total, la suma de líneas =
// SUM(order_items.price) = orders.total → el Total del CFDI cuadra al centavo con caja.
// Tolerancia SAT por concepto: |iva − base·0.16| = |precioConIva − base·1.16| ≤ 0.0058
// (porque |base − precioConIva/1.16| ≤ 0.005), siempre < 0.01 → válido en CFDI 4.0.
export function extraerIva(precioConIva: number): { base: number; iva: number; total: number } {
  const total = Number(precioConIva.toFixed(2));
  const base  = Number((total / 1.16).toFixed(2));
  const iva   = Number((total - base).toFixed(2));
  return { base, iva, total };
}

// ── Crear CFDI 4.0 (Ingreso) ────────────────────────────────────
export async function crearCfdi(data: CfdiRequest): Promise<CfdiResult> {
  const items = data.items.map((it, idx) => {
    // it.subtotal = importe de la línea (order_items.price), CON IVA incluido.
    const { base, iva, total } = extraerIva(it.subtotal);
    // ValorUnitario también SIN IVA, para que Importe = round(ValorUnitario × Cantidad).
    // Guardia (cantidad > 1): garantiza round(VU × Cant, 2) === base (consistencia que el
    // SAT valida por concepto). Si el redondeo a 6 decimales no reprodujera la base exacta,
    // ajusta el ValorUnitario el epsilon mínimo. base/iva/total NO cambian → el Total sigue
    // cuadrando al centavo con orders.total.
    let unitPrice = Number((base / it.quantity).toFixed(6));
    if (Number((unitPrice * it.quantity).toFixed(2)) !== base) {
      for (const eps of [1e-6, -1e-6, 2e-6, -2e-6]) {
        const cand = Number((unitPrice + eps).toFixed(6));
        if (Number((cand * it.quantity).toFixed(2)) === base) { unitPrice = cand; break; }
      }
    }

    return {
      ProductCode: "90101500",
      IdentificationNumber: String(idx + 1).padStart(3, "0"),
      Description: it.dishName,
      Unit: "Pieza",
      UnitCode: "H87",
      UnitPrice: unitPrice,
      Quantity: it.quantity,
      Subtotal: base,
      TaxObject: "02",
      Taxes: [
        {
          Total: iva,
          Name: "IVA",
          Base: base,
          Rate: 0.16,
          IsRetention: false,
        },
      ],
      Total: total,
    };
  });

  const isPublico = data.receiver.rfc.toUpperCase() === RFC_PUBLICO_GENERAL;
  const now = new Date();
  const expeditionCp = process.env.FACTURAMA_CP ?? "76000";

  // Receptor: para público en general (XAXX) se FUERZAN los valores obligatorios del SAT
  // (Uso S01, Régimen 616, DomicilioFiscalReceptor = CP del emisor, Nombre genérico sin
  // acento). Para cualquier otro receptor, los datos capturados (ya validados aguas arriba).
  const receiver = isPublico
    ? {
        Rfc:          RFC_PUBLICO_GENERAL,
        Name:         PUBLICO_GENERAL.name,
        CfdiUse:      PUBLICO_GENERAL.usoCfdi,
        FiscalRegime: PUBLICO_GENERAL.regimenFiscal,
        TaxZipCode:   expeditionCp,
      }
    : {
        Rfc:          data.receiver.rfc.toUpperCase(),
        // Grupo A: solo MAYÚSCULAS + espacios colapsados, CONSERVANDO acentos y Ñ.
        Name:         normalizeReceiverName(data.receiver.razonSocial),
        CfdiUse:      data.receiver.usoCfdi,
        FiscalRegime: data.receiver.regimenFiscal,
        TaxZipCode:   data.receiver.codigoPostal,
      };

  // ── Forma de pago: usar la clave SAT ya resuelta; si no vino, intentar mapear
  // el texto de la orden. NUNCA defaultear a Efectivo (defensa en profundidad):
  // si no se puede determinar, se rechaza para exigir captura explícita aguas arriba.
  const formaPago = isFormaPagoValida(data.formaPago)
    ? data.formaPago
    : mapPaymentForm(data.paymentMethod ?? null);

  if (!isFormaPagoValida(formaPago)) {
    throw new FacturamaRejectionError(
      "No se pudo determinar la forma de pago (clave SAT c_FormaPago). " +
      "Captura explícitamente cómo pagó el cliente antes de timbrar.",
      400
    );
  }

  const body: Record<string, unknown> = {
    NameId: "1",
    Folio: data.folio,
    Date: data.fecha,
    PaymentForm: formaPago,
    PaymentMethod: "PUE",
    ExpeditionPlace: expeditionCp,
    CfdiType: "I",
    Currency: "MXN",
    ...(isPublico ? {
      GlobalInformation: {
        Periodicity: "04",
        Months: String(now.getMonth() + 1).padStart(2, "0"),
        Year: String(now.getFullYear()),
      }
    } : {}),
    Receiver: receiver,
    Items: items,
  };

  // ── 1. Crear CFDI ─────────────────────────────────────────────
  // Endpoint correcto según docs: POST /3/cfdis
  const createRes = await facturamaFetch(`${API_URL}/3/cfdis`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": getAuth(),
    },
    body: JSON.stringify(body),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    // Grupo H: 5xx / 408 => servicio caído (reintenta luego); 4xx => rechazo del SAT (accionable).
    if (createRes.status >= 500 || createRes.status === 408) {
      throw new FacturamaUnavailableError(`HTTP ${createRes.status}`);
    }
    throw new FacturamaRejectionError(parseFacturamaError(errText), createRes.status);
  }

  const cfdi = await createRes.json() as {
    Id: string;
    Folio: string;
    Complement?: { TaxStamp?: { Uuid?: string } };
  };

  const cfdiId = cfdi.Id;
  // Grupo D: sin UUID real NO hay factura. Se trata como rechazo, NUNCA como procesada.
  const uuid = cfdi.Complement?.TaxStamp?.Uuid;
  if (!uuid) {
    throw new FacturamaRejectionError(
      "El comprobante no devolvió timbre fiscal (UUID). No se marcará como facturado.",
      502
    );
  }

  // Log sin PII: solo identificadores del CFDI, nunca el payload del receptor.
  console.log("[Facturama] CFDI timbrado:", JSON.stringify({ Id: cfdiId, Folio: cfdi.Folio }));

  // ── 2-4. Descargas y email: NO deben tumbar el éxito ya timbrado ──
  // (CFDI ya tiene UUID; PDF/XML/email son secundarios → fail-soft, nunca throw.)
  let pdfData = "";
  let xmlData = "";
  try {
    const pdfRes = await facturamaFetch(`${API_URL}/Cfdi/pdf/issued/${cfdiId}`, { headers: { "Authorization": getAuth() } });
    if (pdfRes.ok) pdfData = ((await pdfRes.json()) as { Content: string }).Content;
  } catch (e: any) { console.warn("[Facturama] PDF no disponible:", e?.name ?? "error"); }

  try {
    const xmlRes = await facturamaFetch(`${API_URL}/Cfdi/xml/issued/${cfdiId}`, { headers: { "Authorization": getAuth() } });
    if (xmlRes.ok) xmlData = ((await xmlRes.json()) as { Content: string }).Content;
  } catch (e: any) { console.warn("[Facturama] XML no disponible:", e?.name ?? "error"); }

  try {
    // Endpoint: POST /cfdi?CfdiType=issued&CfdiId={id}&Email={email}  (query params, NO body)
    const emailUrl = `${API_URL}/cfdi?CfdiType=issued&CfdiId=${encodeURIComponent(cfdiId)}&Email=${encodeURIComponent(data.email)}`;
    const emailRes = await facturamaFetch(emailUrl, { method: "POST", headers: { "Authorization": getAuth() } });
    if (!emailRes.ok) console.warn("[Facturama] Email warning:", emailRes.status);
  } catch (e: any) { console.warn("[Facturama] Email no enviado:", e?.name ?? "error"); }

  return {
    cfdiId,
    uuid,
    folio: cfdi.Folio,
    pdfBase64: pdfData,
    xmlBase64: xmlData,
  };
}
