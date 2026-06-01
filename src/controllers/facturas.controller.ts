// server/src/controllers/facturas.controller.ts
import { Request, Response } from "express";
import { getPool, Sucursal } from "../db-sucursales.js";

const parseSucursal = (val: unknown): Sucursal | null => {
  if (val === "guerrero" || val === "madero") return val;
  return null;
};

/* ══════════════════════════════════════════════════════════════
   GET /api/facturas/orden/:id?sucursal=guerrero|madero
══════════════════════════════════════════════════════════════ */
export const getOrden = async (req: Request, res: Response): Promise<void> => {
  const orderId  = parseInt(req.params.id, 10);
  const sucursal = parseSucursal(req.query.sucursal);

  if (isNaN(orderId) || orderId <= 0) {
    res.status(400).json({ error: "Folio inválido." }); return;
  }
  if (!sucursal) {
    res.status(400).json({ error: "Sucursal requerida (guerrero o madero)." }); return;
  }

  const pool = getPool(sucursal);

  try {
    const [orderRows] = await pool.query(
      `SELECT id, name, phone, guests, order_status, order_date,
              total, tax, total_with_tax, payment_method, created_at, table_id
       FROM orders WHERE id = ? LIMIT 1`,
      [orderId]
    ) as [Array<Record<string, any>>, unknown];

    if (!orderRows?.length) {
      res.status(404).json({ error: "No se encontró ninguna orden con ese folio." }); return;
    }

    const order = orderRows[0];
    const validStatuses = ["completed","paid","completada","pagada","pagado","cerrada","closed"];

    if (!validStatuses.includes((order.order_status ?? "").toString().toLowerCase())) {
      res.status(422).json({
        error: `La orden #${orderId} tiene estatus "${order.order_status}" y no puede facturarse todavía.`,
      }); return;
    }

    const [itemRows] = await pool.query(
      `SELECT id, item_name, quantity,
              price                      AS subtotal,
              ROUND(price / quantity, 2) AS unit_price,
              notes
       FROM order_items WHERE order_id = ? ORDER BY id ASC`,
      [orderId]
    ) as [Array<Record<string, any>>, unknown];

    const [existing] = await pool.query(
      `SELECT id, status FROM factura_requests
       WHERE order_id = ? AND status IN ('pendiente','procesada') LIMIT 1`,
      [orderId]
    ) as [Array<Record<string, any>>, unknown];

    res.json({
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
      alreadyRequested: existing?.length
        ? { id: existing[0].id, status: existing[0].status }
        : null,
    });
  } catch (err) {
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
          regimenFiscal, codigoPostal, usoCfdi, email } = req.body;

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

  const pool = getPool(sucursal);

  try {
    const [orderCheck] = await pool.query(
      "SELECT id FROM orders WHERE id = ? LIMIT 1", [parseInt(orderId, 10)]
    ) as [Array<unknown>, unknown];
    if (!orderCheck?.length) { res.status(404).json({ error: "Orden no encontrada." }); return; }

    const [dup] = await pool.query(
      `SELECT id FROM factura_requests
       WHERE order_id = ? AND status IN ('pendiente','procesada') LIMIT 1`,
      [orderId]
    ) as [Array<unknown>, unknown];
    if (dup?.length) {
      res.status(409).json({ error: "Ya existe una solicitud activa para esta orden." }); return;
    }

    // ── 1. Guardar solicitud ──────────────────────────────────
    const [result] = await pool.query(
      `INSERT INTO factura_requests
         (order_id, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, email)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [parseInt(orderId, 10), rfc.toUpperCase(), razonSocial.trim(),
       regimenFiscal, codigoPostal, usoCfdi, email.toLowerCase().trim()]
    ) as [import("mysql2").ResultSetHeader, unknown];

    const solicitudId = result.insertId;

    // ── 2. Obtener orden e items para timbrar ─────────────────
    const [orderRows] = await pool.query(
      `SELECT id, order_date, created_at, payment_method, total, tax, total_with_tax
       FROM orders WHERE id = ? LIMIT 1`, [parseInt(orderId, 10)]
    ) as [Array<Record<string, any>>, unknown];

    const [itemRows] = await pool.query(
      `SELECT item_name, quantity, price AS subtotal,
              ROUND(price / quantity, 6) AS unit_price
       FROM order_items WHERE order_id = ? ORDER BY id`,
      [parseInt(orderId, 10)]
    ) as [Array<Record<string, any>>, unknown];

    // ── 3. Timbrar con Facturama ──────────────────────────────
    try {
      const { crearCfdi } = await import("../services/facturama.service.js");
      const order = (orderRows as any[])[0];

      // ⚠️ Siempre usar fecha actual — el SAT no permite timbrar con más de 72h de antigüedad
      const fechaTimbrado = new Date().toISOString().slice(0, 19);

      const cfdi = await crearCfdi({
        folio: `${String(orderId).padStart(6, "0")}-${Date.now()}`,
        fecha:         fechaTimbrado,
        paymentMethod: order.payment_method,
        receiver: {
          rfc:           rfc.toUpperCase(),
          razonSocial:   razonSocial.trim(),
          regimenFiscal, codigoPostal, usoCfdi,
        },
        items: (itemRows as any[]).map(i => ({
          dishName:  i.item_name,
          quantity:  Number(i.quantity),
          unitPrice: Number(i.unit_price),
          subtotal:  Number(i.subtotal),
        })),
        email: email.toLowerCase().trim(),
      });

      // Actualizar a procesada con UUID
      await pool.query(
        `UPDATE factura_requests SET status = 'procesada', notas = ? WHERE id = ?`,
        [`CFDI: ${cfdi.uuid} | ID: ${cfdi.cfdiId}`, solicitudId]
      );

      res.status(201).json({
        success: true, solicitudId, uuid: cfdi.uuid,
        message: `Factura timbrada y enviada a ${email}.`,
      });

    } catch (factuErr: any) {
      console.error("[facturas] timbrado automático falló:", factuErr?.message);
      res.status(201).json({
        success: true, solicitudId,
        warning: "Solicitud registrada. El timbrado se procesará en 24–48 horas.",
        message: `Tu solicitud fue registrada. Recibirás tu CFDI en ${email} pronto.`,
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

    const { crearCfdi } = await import("../services/facturama.service.js");

    // ⚠️ Siempre usar fecha actual — el SAT no permite timbrar con más de 72h de antigüedad
    const fechaTimbrado = new Date().toISOString().slice(0, 19);
    const order = (orderRows as any[])[0];

    const result = await crearCfdi({
      folio:         String(sol.order_id).padStart(6, "0"),
      fecha:         fechaTimbrado,
      paymentMethod: order.payment_method,
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
      [`CFDI: ${result.uuid} | ID: ${result.cfdiId}`, solicitudId]
    );

    res.json({
      success:  true,
      uuid:     result.uuid,
      cfdiId:   result.cfdiId,
      message:  `Factura timbrada y enviada a ${sol.email}`,
    });

  } catch (err: any) {
    console.error("[facturas] timbrarFactura error:", err);
    res.status(500).json({ error: err?.message ?? "Error al timbrar." });
  }
};