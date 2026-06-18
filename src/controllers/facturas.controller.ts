// server/src/controllers/facturas.controller.ts
import { Request, Response } from "express";
import { getPool, Sucursal } from "../db-sucursales.js";
import {
  crearCfdi,
  validarReceptorSat,
  validarComboFiscal,
  mapPaymentForm,
  isFormaPagoValida,
  enviarCfdiEmail,
  descargarCfdiDoc,
  parseCfdiNotas,
  RFC_PUBLICO_GENERAL,
  PUBLICO_GENERAL,
  FacturamaRejectionError,
  FacturamaUnavailableError,
} from "../services/facturama.service.js";
import {
  verifyToken,
  clientIp,
  checkAccessLock,
  registerAccessFailure,
  resetAccessFailures,
} from "../auth.js";
import { notifyOwner } from "../services/notify.js";

const parseSucursal = (val: unknown): Sucursal | null => {
  if (val === "guerrero" || val === "madero") return val;
  return null;
};

// Detecta admin/caja autenticado SIN bloquear (a diferencia de requireAdmin, no responde).
// El camino cliente sigue de largo a la validación por token; el admin queda exento.
const isAdminRequest = (req: Request): boolean => {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const data = verifyToken(auth.slice(7));
  return !!data && data.rol === "admin";
};

// Lee y NORMALIZA el código del ticket (?t=… o tecleado): MAYÚSCULAS, sin guion ni
// espacios. Acepta el QR (canónico) y el tecleo "abcd-2345" por igual. Arrays/ausente => "".
const getTicketToken = (val: unknown): string =>
  typeof val === "string" ? val.trim().toUpperCase().replace(/[^0-9A-Z]/g, "") : "";

// 429 genérico de lockout (no revela si el folio existe).
const tooManyAttempts = (res: Response, retryAfterSec: number): void => {
  if (retryAfterSec > 0) res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).json({
    ok: false, error: "demasiados_intentos",
    message: "Demasiados intentos. Espera unos minutos e intenta de nuevo.",
  });
};

// ── Ventana de autoservicio (camino cliente) ───────────────────────────────────
// Política por defecto: la orden debe ser del MES NATURAL en curso (hasta fin de mes).
// Usa order_date — created_at está NULL al 100% en orders (diagnóstico 2026-06-15).
// Admin/caja exento. Configurable por env sin recompilar:
//   FACT_VENTANA_MODO     = "mes" (default) | "dias"
//   FACT_VENTANA_DIAS     = N (solo modo "dias"; default 30)
//   FACT_TZ_OFFSET_HORAS  = 6 (MX = UTC-6, sin horario de verano)
// ⚠️ order_date se guarda en hora MX y la TZ de sesión de la BD es UTC (confirmado), por
//    eso "ahora MX" = UTC_TIMESTAMP() − 6h (independiente de @@session.time_zone).
const VENTANA_MODO = (process.env.FACT_VENTANA_MODO ?? "mes").toLowerCase();
const VENTANA_DIAS = Number(process.env.FACT_VENTANA_DIAS ?? "30");
const TZ_OFFSET_HORAS = (() => {
  const n = Number(process.env.FACT_TZ_OFFSET_HORAS ?? "6");
  return Number.isFinite(n) ? n : 6;
})();
const MX_NOW = `(UTC_TIMESTAMP() - INTERVAL ${TZ_OFFSET_HORAS} HOUR)`;

// Fragmento SQL (con placeholders) + params para la ventana sobre order_date (hora MX).
const ventanaSql = (): { clause: string; params: Array<number> } => {
  if (VENTANA_MODO === "dias") {
    return { clause: `order_date >= (${MX_NOW} - INTERVAL ? DAY)`, params: [VENTANA_DIAS] };
  }
  // "mes": [primer día del mes en curso (MX), primer día del mes siguiente).
  return {
    clause:
      `order_date >= DATE_FORMAT(${MX_NOW}, '%Y-%m-01') ` +
      `AND order_date < (DATE_FORMAT(${MX_NOW}, '%Y-%m-01') + INTERVAL 1 MONTH)`,
    params: [],
  };
};

// ── Modo de exigencia del token del ticket (control de acceso anti-IDOR, camino cliente) ──
//   FACT_TOKEN_MODE = "on" (default) | "grace"
//     "on"    = se EXIGE token: sin token → 404; con token → id+token+ventana.
//     "grace" = token OPCIONAL durante la transición del POS: si viene se valida igual; si NO
//               viene, lookup por folio+ventana (comportamiento previo al token). Reabre el IDOR
//               de folios (= postura ANTERIOR al feature); el lockout sigue activo. Volver a "on"
//               cuando el POS imprima el QR en ambas sucursales (solo env + reinicio, sin redeploy).
const TOKEN_REQUIRED = (process.env.FACT_TOKEN_MODE ?? "on").toLowerCase() !== "grace";

// Cláusula SQL del token: se aplica si el modo lo exige O si el cliente mandó token (para
// validarlo aunque estemos en grace). En grace SIN token: no agrega cláusula (folio+ventana).
const tokenClause = (token: string): { sql: string; params: string[] } =>
  (TOKEN_REQUIRED || token) ? { sql: "AND factura_token = ?", params: [token] }
                            : { sql: "", params: [] };

/* Resuelve la clave SAT c_FormaPago con la que se debe timbrar.
   Prioridad:
     1) selección explícita válida del body (cliente/caja),
     2) mapeo CONFIABLE de la orden — mapPaymentForm ya descarta "Pending",
        null o ambiguo devolviendo null,
     3) null → el llamador exige captura explícita (NUNCA defaultea a Efectivo). */
const resolveFormaPago = (
  orderPaymentMethod: string | null,
  bodyFormaPago: unknown,
): string | null => {
  if (isFormaPagoValida(bodyFormaPago as string | null | undefined)) {
    return bodyFormaPago as string;
  }
  return mapPaymentForm(orderPaymentMethod ?? null);
};

/* ══════════════════════════════════════════════════════════════
   GET /api/facturas/orden/:id?sucursal=guerrero|madero
══════════════════════════════════════════════════════════════ */
export const getOrden = async (req: Request, res: Response): Promise<void> => {
  const orderId  = parseInt(req.params.id, 10);
  const sucursal = parseSucursal(req.query.sucursal);
  const token    = getTicketToken(req.query.t);
  const isAdmin  = isAdminRequest(req);

  // Respuesta GENÉRICA del camino cliente: jamás revela si el folio existe, si el token
  // es malo o si está fuera de la ventana. Todos los fallos colapsan al mismo 404.
  const notFound = () => {
    res.status(404).json({
      error: "No encontramos tu orden. Escanea el QR de tu ticket para facturar.",
    });
  };

  if (isNaN(orderId) || orderId <= 0) {
    if (isAdmin) { res.status(400).json({ error: "Folio inválido." }); return; }
    notFound(); return;
  }
  if (!sucursal) {
    res.status(400).json({ error: "Sucursal requerida (guerrero o madero)." }); return;
  }
  // Cliente: sin token no se abre nada (no se distingue de folio inexistente).
  // En grace (FACT_TOKEN_MODE=grace) el token es opcional → no se exige aquí.
  if (!isAdmin && TOKEN_REQUIRED && !token) { notFound(); return; }

  // Lockout (solo cliente): si está bloqueado por IP o por folio → 429 ANTES de tocar la BD.
  const ip = clientIp(req);
  if (!isAdmin) {
    const lock = checkAccessLock(ip, sucursal, orderId);
    if (lock.blocked) { tooManyAttempts(res, lock.retryAfterSec); return; }
  }

  const pool = getPool(sucursal);
  const cols = `id, name, guests, order_status, order_date,
                total, tax, total_with_tax, payment_method, created_at, table_id`;

  try {
    let orderRows: Array<Record<string, any>>;

    if (isAdmin) {
      // Admin/caja autenticado: exento de token y de la ventana (remediar/retimbrar).
      [orderRows] = await pool.query(
        `SELECT ${cols} FROM orders WHERE id = ? LIMIT 1`, [orderId]
      ) as [Array<Record<string, any>>, unknown];
    } else {
      // Cliente: token + ventana (mes natural en curso, por defecto) en UNA consulta →
      // match/no-match indistinguible. Sobre order_date en hora MX (ver ventanaSql).
      // En grace (FACT_TOKEN_MODE=grace) sin token: cae a folio+ventana (ver tokenClause).
      const win = ventanaSql();
      const tc  = tokenClause(token);
      [orderRows] = await pool.query(
        `SELECT ${cols} FROM orders
         WHERE id = ? ${tc.sql} AND ${win.clause} LIMIT 1`,
        [orderId, ...tc.params, ...win.params]
      ) as [Array<Record<string, any>>, unknown];
    }

    if (!orderRows?.length) {
      // Fallo de acceso del cliente (token malo / fuera de ventana / folio inexistente):
      // todos cuentan igual, sin oráculo. Admin no cuenta.
      if (!isAdmin) registerAccessFailure(ip, sucursal, orderId);
      notFound(); return;
    }

    // Token válido → reset INMEDIATO. Los errores posteriores (estatus, etc.) NO cuentan
    // como fallo de acceso.
    if (!isAdmin) resetAccessFailures(ip, sucursal, orderId);

    const order = orderRows[0];
    const validStatuses = ["completed","paid","completada","pagada","pagado","cerrada","closed"];

    if (!validStatuses.includes((order.order_status ?? "").toString().toLowerCase())) {
      // Admin recibe el motivo real; cliente recibe el 404 genérico (no se revela existencia).
      if (isAdmin) {
        res.status(422).json({
          error: `La orden #${orderId} tiene estatus "${order.order_status}" y no puede facturarse todavía.`,
        });
      } else {
        notFound();
      }
      return;
    }

    const [itemRows] = await pool.query(
      `SELECT id, item_name, quantity,
              price                      AS subtotal,
              ROUND(price / quantity, 2) AS unit_price,
              notes
       FROM order_items WHERE order_id = ? ORDER BY id ASC`,
      [orderId]
    ) as [Array<Record<string, any>>, unknown];

    // Forma de pago derivable de la orden (null si viene "Pending"/ambigua):
    // el portal usa paymentFormRequired para exigir captura explícita al cliente.
    const paymentForm = resolveFormaPago(order.payment_method ?? null, null);

    // Factura ya emitida (Gap B): se devuelve SOLO porque este camino YA exigió token
    // válido del ticket (no es un oráculo de enumeración). El portal la usa para ofrecer
    // descarga/reenvío en vez del callejón 409. Fantasmas (notas sin UUID) → null.
    const [factRows] = await pool.query(
      `SELECT notas FROM factura_requests
       WHERE order_id = ? AND status = 'procesada' ORDER BY id DESC LIMIT 1`,
      [orderId]
    ) as [Array<Record<string, any>>, unknown];
    const cfdiInfo = factRows?.length ? parseCfdiNotas(factRows[0].notas) : null;

    res.json({
      factura: cfdiInfo ? { uuid: cfdiInfo.uuid } : null,
      order: {
        id:            order.id,
        folio:         String(order.id).padStart(6, "0"),
        name:          order.name,
        guests:        order.guests,
        status:        order.order_status,
        date:          order.order_date ?? order.created_at,
        total:         Number(order.total),
        tax:           Number(order.tax),
        totalWithTax:  Number(order.total_with_tax),
        paymentMethod: order.payment_method,
        paymentForm,
        paymentFormRequired: paymentForm === null,
        tableName:     order.table_id ? `Mesa ${order.table_id}` : null,
        sucursal,
      },
      items: (itemRows as any[]).map(i => ({
        id:        i.id,
        dishName:  i.item_name ?? "Platillo",
        quantity:  Number(i.quantity),
        unitPrice: Number(i.unit_price),
        subtotal:  Number(i.subtotal),
        notes:     i.notes ?? null,
      })),
    });
  } catch (err) {
    // No se registra el token ni datos del cliente; solo el error del motor.
    console.error("[facturas] getOrden error:", err);
    res.status(500).json({ error: "Error interno al consultar la orden." });
  }
};

/* ══════════════════════════════════════════════════════════════
   POST /api/facturas/solicitar
   Guarda la solicitud Y timbra automáticamente con Facturama
══════════════════════════════════════════════════════════════ */
export const solicitarFactura = async (req: Request, res: Response): Promise<void> => {
  const { orderId, sucursal: sucursalRaw, rfc, razonSocial,
          regimenFiscal, codigoPostal, usoCfdi, email,
          formaPago: formaPagoBody } = req.body;

  const sucursal = parseSucursal(sucursalRaw);
  if (!sucursal) { res.status(400).json({ error: "Sucursal inválida." }); return; }

  if (!orderId || !rfc || !razonSocial || !regimenFiscal || !codigoPostal || !usoCfdi || !email) {
    res.status(400).json({ error: "Todos los campos son obligatorios." }); return;
  }

  const rfcRegex = /^([A-ZÑ&]{3,4})\d{6}([A-Z\d]{3})$/;
  if (!rfcRegex.test(rfc.toUpperCase())) {
    res.status(400).json({ error: "RFC inválido." }); return;
  }
  if (!/^\d{5}$/.test(codigoPostal)) {
    res.status(400).json({ error: "Código postal inválido." }); return;
  }

  // Coherencia fiscal local (régimen↔tipo de persona, uso↔régimen, XEXX no soportado):
  // rechaza ANTES de timbrar lo que el PAC rechazaría, con mensaje accionable. El público
  // general (XAXX) se exime aquí y se normaliza más abajo.
  const combo = validarComboFiscal({ rfc: rfc.toUpperCase(), regimenFiscal, usoCfdi });
  if (!combo.ok) {
    res.status(422).json({
      ok: false, error: combo.code, reintentable: true, message: combo.message, detail: null,
    });
    return;
  }

  // ── Gate de acceso: mismo candado que getOrden. El cliente prueba posesión del ticket
  // (body.t / ?t=) y debe caer en la ventana vigente (mes natural por defecto); admin/caja
  // autenticado queda exento. Cualquier fallo → 404 genérico (no oráculo). Se SUMA a lo existente.
  const token    = getTicketToken(req.body?.t ?? req.query.t);
  const isAdmin  = isAdminRequest(req);
  const notFound = () => {
    res.status(404).json({
      error: "No encontramos tu orden. Escanea el QR de tu ticket para facturar.",
    });
  };
  // Grace (FACT_TOKEN_MODE=grace): token opcional → no se exige aquí.
  if (!isAdmin && TOKEN_REQUIRED && !token) { notFound(); return; }

  // Lockout (solo cliente): si está bloqueado por IP o por folio → 429 ANTES de tocar la BD.
  const ip = clientIp(req);
  if (!isAdmin) {
    const lock = checkAccessLock(ip, sucursal, parseInt(orderId, 10));
    if (lock.blocked) { tooManyAttempts(res, lock.retryAfterSec); return; }
  }

  const pool = getPool(sucursal);

  try {
    // El gate va PRIMERO: antes de la resolución de forma de pago, el insert o el timbrado.
    // Para el cliente también cierra los oráculos de orderCheck (404) y dup (409) de abajo.
    if (!isAdmin) {
      const win = ventanaSql();
      const tc  = tokenClause(token);
      const [gate] = await pool.query(
        `SELECT id FROM orders
         WHERE id = ? ${tc.sql} AND ${win.clause} LIMIT 1`,
        [parseInt(orderId, 10), ...tc.params, ...win.params]
      ) as [Array<unknown>, unknown];
      if (!gate?.length) {
        // Fallo de acceso (token malo / fuera de ventana / folio inexistente): cuenta igual.
        registerAccessFailure(ip, sucursal, parseInt(orderId, 10));
        notFound(); return;
      }
      // Token válido → reset INMEDIATO. El 409 dup y el 422 de forma de pago de abajo NO
      // cuentan como fallo de acceso.
      resetAccessFailures(ip, sucursal, parseInt(orderId, 10));
    }

    // Público general (XAXX): valores forzados por el SAT (no dependen de la orden).
    // El servicio los vuelve a forzar como defensa en profundidad (camino admin /timbrar).
    const esPublico = rfc.toUpperCase() === RFC_PUBLICO_GENERAL;
    const razonEf   = esPublico ? PUBLICO_GENERAL.name          : razonSocial.trim();
    const regimenEf = esPublico ? PUBLICO_GENERAL.regimenFiscal : regimenFiscal;
    const usoEf     = esPublico ? PUBLICO_GENERAL.usoCfdi        : usoCfdi;
    const cpEf      = esPublico ? (process.env.FACTURAMA_CP ?? "76000") : codigoPostal;
    const oid       = parseInt(orderId, 10);

    // ── Sección ATÓMICA: bloqueo de la orden (FOR UPDATE) + check-dup + INSERT en UNA
    // transacción con conexión dedicada. Serializa dos requests concurrentes del MISMO
    // folio: el segundo espera el lock, ve la solicitud ya insertada y recibe 409 — sin
    // duplicar el CFDI ni dejar trabadas. La llamada a Facturama queda FUERA de la
    // transacción (es lenta/externa y no debe sostener un lock de BD).
    // ⚠️ Requiere InnoDB en `orders` (FOR UPDATE es no-op en MyISAM). Defensa adicional
    //    recomendada para la VENTANA: UNIQUE index parcial en factura_requests(order_id)
    //    para los estados activos (cambio de esquema) — anotado para Oscar.
    let solicitudId = 0;
    let formaPago = "";
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [orderLock] = await conn.query(
        "SELECT id, payment_method FROM orders WHERE id = ? LIMIT 1 FOR UPDATE", [oid]
      ) as [Array<Record<string, any>>, unknown];
      if (!orderLock?.length) {
        await conn.rollback();
        res.status(404).json({ error: "Orden no encontrada." }); return;
      }

      const [dup] = await conn.query(
        `SELECT id FROM factura_requests
         WHERE order_id = ? AND status IN ('pendiente','procesada') LIMIT 1`, [oid]
      ) as [Array<unknown>, unknown];
      if (dup?.length) {
        await conn.rollback();
        res.status(409).json({ error: "Ya existe una solicitud activa para esta orden." }); return;
      }

      // Forma de pago: resolver ANTES del INSERT para no dejar registros colgados.
      const fp = resolveFormaPago(orderLock[0].payment_method ?? null, formaPagoBody);
      if (fp === null) {
        await conn.rollback();
        res.status(422).json({
          ok: false, error: "forma_pago_requerida", reintentable: true,
          message: "Indica la forma de pago con la que cubriste tu consumo para poder emitir tu factura.",
          detail: null,
        });
        return;
      }
      formaPago = fp;

      const [ins] = await conn.query(
        `INSERT INTO factura_requests
           (order_id, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, email)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [oid, rfc.toUpperCase(), razonEf, regimenEf, cpEf, usoEf, email.toLowerCase().trim()]
      ) as [import("mysql2").ResultSetHeader, unknown];

      await conn.commit();
      solicitudId = ins.insertId;
    } catch (txErr) {
      try { await conn.rollback(); } catch { /* la conexión pudo morir; el catch externo responde 500 */ }
      throw txErr;
    } finally {
      conn.release();
    }

    // ── 2. Obtener items para timbrar ─────────────────────────
    // (La orden y su forma de pago ya se resolvieron arriba; no se reconsulta.)
    const [itemRows] = await pool.query(
      `SELECT item_name, quantity, price AS subtotal,
              ROUND(price / quantity, 6) AS unit_price
       FROM order_items WHERE order_id = ? ORDER BY id`,
      [parseInt(orderId, 10)]
    ) as [Array<Record<string, any>>, unknown];

    // ── 3. Pre-validación del receptor contra el SAT (Grupo F) ────
    // Fail-open: si no se puede verificar (endpoint apagado/caído) se procede a timbrar.
    // Se SALTA para público en general (XAXX): sus datos son genéricos, no van al padrón.
    if (!esPublico) {
      const validacion = await validarReceptorSat({
        rfc: rfc.toUpperCase(),
        name: razonSocial,
        regimenFiscal,
        codigoPostal,
      });
      if (validacion.verificado && !validacion.valido) {
        // Variante (b): solo llega aquí si el RFC no existe/está inactivo en el SAT.
        // NO se timbra y NO se deja la orden trabada: se cancela para permitir reintento.
        await pool.query(
          `UPDATE factura_requests SET status = 'cancelada', notas = ? WHERE id = ?`,
          ["pre-validacion SAT: RFC inexistente", solicitudId]
        ).catch(() => {});
        res.status(422).json({
          ok: false, error: "validacion_receptor", solicitudId, reintentable: true,
          message: "No pudimos validar tu RFC con el SAT: no aparece registrado o activo. Verifica que esté escrito tal cual tu Constancia de Situación Fiscal.",
          detail: validacion.motivo ?? null,
        });
        return;
      }
    }

    // ── 4. Timbrar con Facturama ──────────────────────────────
    try {
      // ⚠️ Siempre hora México (UTC-6) — el SAT rechaza CFDIs con fecha > 72h
      const fechaTimbrado = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 19);

      const cfdi = await crearCfdi({
        folio: `${String(orderId).padStart(6, "0")}-${Date.now()}`,
        fecha:         fechaTimbrado,
        formaPago,
        receiver: {
          rfc:           rfc.toUpperCase(),
          razonSocial:   razonEf,
          regimenFiscal: regimenEf,
          codigoPostal:  cpEf,
          usoCfdi:       usoEf,
        },
        items: (itemRows as any[]).map(i => ({
          dishName:  i.item_name,
          quantity:  Number(i.quantity),
          unitPrice: Number(i.unit_price),
          subtotal:  Number(i.subtotal),
        })),
        email: email.toLowerCase().trim(),
      });

      // Camino de ÉXITO: procesada + UUID real + estado REAL del correo (Gap A).
      await pool.query(
        `UPDATE factura_requests SET status = 'procesada', notas = ? WHERE id = ?`,
        [`CFDI: ${cfdi.uuid} | ID: ${cfdi.cfdiId} | email:${cfdi.emailSent ? "ok" : "pendiente"}`, solicitudId]
      );

      res.status(201).json({
        success: true, solicitudId, uuid: cfdi.uuid,
        emailEnviado: cfdi.emailSent,
        message: cfdi.emailSent
          ? `Factura timbrada y enviada a ${email}.`
          : "Factura timbrada. No pudimos confirmar el envío a tu correo; descárgala o reenvíala desde aquí.",
      });

    } catch (factuErr: any) {
      // Motivo REAL del PAC (sin PII): se PERSISTE para diagnóstico/remediación y se alerta a Oscar.
      const tipo    = factuErr?.name ?? "Error";
      const esCaida = factuErr instanceof FacturamaUnavailableError;
      const detalle = (factuErr instanceof FacturamaRejectionError || factuErr instanceof FacturamaUnavailableError)
        ? factuErr.detail : (factuErr?.message ?? "error");

      // Grupo B: NO dejar la orden trabada → 'cancelada' (reintentable), guardando el motivo real.
      await pool.query(
        `UPDATE factura_requests SET status = 'cancelada', notas = ? WHERE id = ?`,
        [`timbrado fallido [${tipo}]: ${String(detalle).slice(0, 180)}`, solicitudId]
      ).catch(() => { /* no enmascarar el error original */ });

      // Grupo H: log SIN PII — solo solicitudId + tipo de error + detalle recortado.
      console.error(`[facturas] timbrado fallido solicitud=${solicitudId} tipo=${tipo} detalle=${String(detalle).slice(0, 200)}`);

      // Alerta fail-soft a Oscar (Telegram): infra caída → siempre (dedup corto); rechazo → 1/folio/día.
      void notifyOwner(
        `⚠️ Timbrado falló · ${sucursal} · folio ${String(orderId).padStart(6, "0")} · sol#${solicitudId}\n` +
        `tipo: ${tipo}${esCaida ? " (servicio caído)" : ""}\n` +
        `motivo: ${String(detalle).slice(0, 200)}`,
        esCaida
          ? { dedupKey: `down:${sucursal}`,             dedupMs: 30 * 60 * 1000 }
          : { dedupKey: `rej:${sucursal}:${orderId}`,   dedupMs: 24 * 60 * 60 * 1000 }
      );

      // Grupo C: devolver el error REAL y accionable con código correcto (nunca 201 success).
      if (esCaida) {
        res.status(503).json({
          ok: false, error: "facturama_no_disponible", solicitudId, reintentable: true,
          message: "El servicio de facturación no está disponible en este momento. Tu orden NO quedó bloqueada; vuelve a intentarlo en unos minutos.",
          detail: null,
        });
        return;
      }
      res.status(422).json({
        ok: false, error: "facturama_rechazo", solicitudId, reintentable: true,
        message: "No pudimos emitir tu factura. Verifica que tu RFC, nombre, régimen fiscal y código postal coincidan EXACTAMENTE con tu Constancia de Situación Fiscal.",
        detail: factuErr instanceof FacturamaRejectionError ? factuErr.detail : null,
      });
    }

  } catch (err) {
    console.error("[facturas] solicitarFactura error:", err);
    res.status(500).json({ error: "Error interno al guardar la solicitud." });
  }
};

/* ══════════════════════════════════════════════════════════════
   POST /api/facturas/timbrar/:solicitudId?sucursal=guerrero|madero
══════════════════════════════════════════════════════════════ */
export const timbrarFactura = async (req: Request, res: Response): Promise<void> => {
  const solicitudId = parseInt(req.params.solicitudId, 10);
  const sucursal    = parseSucursal(req.query.sucursal ?? req.body.sucursal);

  if (isNaN(solicitudId)) { res.status(400).json({ error: "ID inválido." }); return; }
  if (!sucursal)          { res.status(400).json({ error: "Sucursal requerida." }); return; }

  const pool = getPool(sucursal);

  try {
    const [solRows] = await pool.query(
      "SELECT * FROM factura_requests WHERE id = ? AND status = 'pendiente' LIMIT 1",
      [solicitudId]
    ) as [Array<Record<string, any>>, unknown];
    if (!solRows?.length) {
      res.status(404).json({ error: "Solicitud no encontrada o ya procesada." }); return;
    }
    const sol = solRows[0];

    const [orderRows] = await pool.query(
      `SELECT id, order_date, created_at, payment_method, total, tax, total_with_tax
       FROM orders WHERE id = ? LIMIT 1`, [sol.order_id]
    ) as [Array<Record<string, any>>, unknown];
    if (!orderRows?.length) {
      res.status(404).json({ error: "Orden no encontrada." }); return;
    }

    const [itemRows] = await pool.query(
      `SELECT item_name, quantity, price AS subtotal,
              ROUND(price / quantity, 6) AS unit_price
       FROM order_items WHERE order_id = ? ORDER BY id`,
      [sol.order_id]
    ) as [Array<Record<string, any>>, unknown];

    // ⚠️ Siempre hora México (UTC-6) — el SAT rechaza CFDIs con fecha > 72h
    const fechaTimbrado = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 19);
    const order = (orderRows as any[])[0];

    // Forma de pago: selección explícita (reintento de caja) > mapeo de la orden > null.
    const formaPago = resolveFormaPago(order.payment_method ?? null, req.body?.formaPago);
    if (formaPago === null) {
      res.status(422).json({
        ok: false, error: "forma_pago_requerida", reintentable: true,
        message: "Indica la forma de pago con la que se cubrió el consumo para poder timbrar.",
        detail: null,
      });
      return;
    }

    const result = await crearCfdi({
      folio:         `${String(sol.order_id).padStart(6, "0")}-${Date.now()}`,
      fecha:         fechaTimbrado,
      formaPago,
      receiver: {
        rfc:           sol.rfc,
        razonSocial:   sol.razon_social,
        regimenFiscal: sol.regimen_fiscal,
        codigoPostal:  sol.codigo_postal,
        usoCfdi:       sol.uso_cfdi,
      },
      items: (itemRows as any[]).map(i => ({
        dishName:  i.item_name,
        quantity:  Number(i.quantity),
        unitPrice: Number(i.unit_price),
        subtotal:  Number(i.subtotal),
      })),
      email: sol.email,
    });

    await pool.query(
      `UPDATE factura_requests SET status = 'procesada', notas = ? WHERE id = ?`,
      [`CFDI: ${result.uuid} | ID: ${result.cfdiId} | email:${result.emailSent ? "ok" : "pendiente"}`, solicitudId]
    );

    res.json({
      success:  true,
      uuid:     result.uuid,
      cfdiId:   result.cfdiId,
      emailEnviado: result.emailSent,
      message:  result.emailSent
        ? `Factura timbrada y enviada a ${sol.email}`
        : "Factura timbrada. No se pudo confirmar el envío del correo; usa la descarga o el reenvío.",
    });

  } catch (err: any) {
    // Grupo H: log SIN PII. La solicitud queda en 'pendiente' para que admin reintente.
    const tipo    = err?.name ?? "Error";
    const detalle = (err instanceof FacturamaRejectionError || err instanceof FacturamaUnavailableError)
      ? err.detail : (err?.message ?? "error");
    console.error(`[facturas] timbrarFactura fallido solicitud=${solicitudId} tipo=${tipo} detalle=${String(detalle).slice(0, 200)}`);

    // Persistir el motivo REAL (mantiene 'pendiente' para reintento de admin) + alerta a Oscar.
    await pool.query(
      `UPDATE factura_requests SET notas = ? WHERE id = ?`,
      [`timbrado fallido [${tipo}]: ${String(detalle).slice(0, 180)}`, solicitudId]
    ).catch(() => { /* fail-soft: no enmascarar el error original */ });
    void notifyOwner(
      `⚠️ Re-timbrado (admin) falló · ${sucursal} · sol#${solicitudId}\n` +
      `tipo: ${tipo}\nmotivo: ${String(detalle).slice(0, 200)}`,
      { dedupKey: `retimbrar:${sucursal}:${solicitudId}`, dedupMs: 60 * 60 * 1000 }
    );

    // Grupo C: error real y accionable con código correcto.
    if (err instanceof FacturamaUnavailableError) {
      res.status(503).json({
        ok: false, error: "facturama_no_disponible", reintentable: true,
        message: "El servicio de facturación no está disponible. Intenta de nuevo en unos minutos.",
        detail: null,
      });
      return;
    }
    if (err instanceof FacturamaRejectionError) {
      res.status(422).json({
        ok: false, error: "facturama_rechazo", reintentable: true,
        message: "El SAT rechazó el comprobante. Revisa que RFC, nombre, régimen fiscal y código postal coincidan con la Constancia.",
        detail: err.detail,
      });
      return;
    }
    res.status(500).json({ ok: false, error: "error_interno", message: "Error al timbrar." });
  }
};

/* ══════════════════════════════════════════════════════════════
   Reobtención de una factura YA emitida (Gap B) — descarga y reenvío.
   🔒 MISMO candado que el camino cliente: token del ticket + sucursal + folio + lockout
   por IP/folio + rate-limit (en la ruta). NUNCA re-timbra: opera sobre el CfdiId existente
   en Facturama. Matiz: SIN ventana de facturación (la factura ya existe; el cliente puede
   reobtenerla cuando sea con su código). Admin/caja autenticado queda exento del token.
══════════════════════════════════════════════════════════════ */

// Enmascara el correo para devolverlo sin exponerlo completo (j****@dominio.com).
const maskEmail = (email: string): string => {
  const [user, domain] = String(email ?? "").split("@");
  if (!domain) return "tu correo";
  return `${user.slice(0, 1)}${"*".repeat(Math.max(user.length - 1, 1))}@${domain}`;
};

// Verifica posesión del ticket SIN ventana y localiza la factura emitida. Devuelve sus
// identificadores, o responde (400/404/429) y devuelve null (todo fallo colapsa al 404).
async function gateFacturaEmitida(
  req: Request, res: Response,
): Promise<{ cfdiId: string; uuid: string; email: string } | null> {
  const orderId  = parseInt(req.params.orderId, 10);
  const sucursal = parseSucursal(req.query.sucursal ?? req.body?.sucursal);
  const token    = getTicketToken(req.query.t ?? req.body?.t);
  const isAdmin  = isAdminRequest(req);

  const notFound = () => res.status(404).json({
    error: "No encontramos tu factura. Escanea el QR o teclea el código de tu ticket.",
  });

  if (!sucursal) { res.status(400).json({ error: "Sucursal requerida (guerrero o madero)." }); return null; }
  if (isNaN(orderId) || orderId <= 0) { notFound(); return null; }
  if (!isAdmin && !token) { notFound(); return null; }

  const ip = clientIp(req);
  if (!isAdmin) {
    const lock = checkAccessLock(ip, sucursal, orderId);
    if (lock.blocked) { tooManyAttempts(res, lock.retryAfterSec); return null; }
  }

  const pool = getPool(sucursal);

  // Posesión del ticket SIN ventana (la factura ya existe). Mismo no-oráculo: todo al 404.
  if (!isAdmin) {
    const [okRows] = await pool.query(
      `SELECT id FROM orders WHERE id = ? AND factura_token = ? LIMIT 1`, [orderId, token]
    ) as [Array<unknown>, unknown];
    if (!okRows?.length) { registerAccessFailure(ip, sucursal, orderId); notFound(); return null; }
    resetAccessFailures(ip, sucursal, orderId);
  }

  const [factRows] = await pool.query(
    `SELECT email, notas FROM factura_requests
     WHERE order_id = ? AND status = 'procesada' ORDER BY id DESC LIMIT 1`, [orderId]
  ) as [Array<Record<string, any>>, unknown];
  const info = factRows?.length ? parseCfdiNotas(factRows[0].notas) : null;
  if (!info) { notFound(); return null; }

  return { cfdiId: info.cfdiId, uuid: info.uuid, email: factRows[0].email };
}

/* GET /api/facturas/factura/:orderId/documento?sucursal=&t=&formato=pdf|xml */
export const descargarFactura = async (req: Request, res: Response): Promise<void> => {
  const formato = req.query.formato === "xml" ? "xml" : "pdf";
  try {
    const gate = await gateFacturaEmitida(req, res);
    if (!gate) return; // gateFacturaEmitida ya respondió

    const contenido = await descargarCfdiDoc(gate.cfdiId, formato);
    if (!contenido) {
      res.status(502).json({ ok: false, error: "documento_vacio", message: "El documento no está disponible por ahora. Intenta de nuevo en un momento." });
      return;
    }
    res.json({
      ok: true, formato, contenido,
      filename: `factura-${String(req.params.orderId).padStart(6, "0")}.${formato}`,
    });
  } catch (err: any) {
    if (err instanceof FacturamaUnavailableError) {
      res.status(503).json({ ok: false, error: "facturama_no_disponible", message: "El servicio de facturación no está disponible. Intenta en unos minutos." });
      return;
    }
    console.error(`[facturas] descargarFactura error formato=${formato}:`, err?.name ?? "Error");
    res.status(500).json({ ok: false, error: "error_interno", message: "No pudimos generar tu documento." });
  }
};

/* POST /api/facturas/factura/:orderId/reenviar?sucursal=&t= */
export const reenviarFactura = async (req: Request, res: Response): Promise<void> => {
  try {
    const gate = await gateFacturaEmitida(req, res);
    if (!gate) return; // gateFacturaEmitida ya respondió

    // Reenvío SIEMPRE al correo registrado de la solicitud (no se acepta destino arbitrario
    // → no es un relay abierto). NO re-timbra: usa el CfdiId existente.
    const enviado = await enviarCfdiEmail(gate.cfdiId, gate.email);
    if (!enviado) {
      res.status(502).json({ ok: false, error: "email_no_confirmado", message: "No pudimos confirmar el reenvío. Intenta de nuevo o descarga tu factura." });
      return;
    }
    res.json({ ok: true, email: maskEmail(gate.email), message: `Te reenviamos tu factura a ${maskEmail(gate.email)}.` });
  } catch (err: any) {
    if (err instanceof FacturamaUnavailableError) {
      res.status(503).json({ ok: false, error: "facturama_no_disponible", message: "El servicio de facturación no está disponible. Intenta en unos minutos." });
      return;
    }
    console.error("[facturas] reenviarFactura error:", err?.name ?? "Error");
    res.status(500).json({ ok: false, error: "error_interno", message: "No pudimos reenviar tu factura." });
  }
};