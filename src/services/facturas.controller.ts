// server/src/controllers/facturas.controller.ts
import { Request, Response } from "express";
import { pool } from "../db.js"; // ← mismo pool que usa index.ts

/* ══════════════════════════════════════════════════════════════
   GET /api/facturas/orden/:id
   Devuelve datos completos de una orden para pre-llenar el ticket
══════════════════════════════════════════════════════════════ */
export const getOrden = async (req: Request, res: Response): Promise<void> => {
  const orderId = parseInt(req.params.id, 10);

  if (isNaN(orderId) || orderId <= 0) {
    res.status(400).json({ error: "Folio inválido." });
    return;
  }

  try {
    // ── 1. Datos principales de la orden ──────────────────────
    const [orderRows] = await pool.query(
      `SELECT
         o.id,
         o.name,
         o.phone,
         o.guests,
         o.order_status,
         o.order_date,
         o.total,
         o.tax,
         o.total_with_tax,
         o.payment_method,
         o.created_at,
         t.name AS table_name
       FROM orders o
       LEFT JOIN \`tables\` t ON t.id = o.table_id
       WHERE o.id = ?
       LIMIT 1`,
      [orderId]
    ) as [Array<Record<string, unknown>>, unknown];

    if (!orderRows || orderRows.length === 0) {
      res.status(404).json({ error: "No se encontró ninguna orden con ese folio." });
      return;
    }

    const order = orderRows[0] as Record<string, any>;

    // Solo órdenes completadas / pagadas son facturables
    const validStatuses = ["completed", "paid", "completada", "pagada"];
    if (!validStatuses.includes((order.order_status ?? "").toString().toLowerCase())) {
      res.status(422).json({
        error: `La orden #${orderId} tiene estatus "${order.order_status}" y no puede facturarse todavía.`,
      });
      return;
    }

    // ── 2. Items de la orden ───────────────────────────────────
    // order_items.price = subtotal de la línea (quantity × unitario)
    const [itemRows] = await pool.query(
      `SELECT
         id,
         item_name,
         quantity,
         price                       AS subtotal,
         ROUND(price / quantity, 2)  AS unit_price,
         notes
       FROM order_items
       WHERE order_id = ?
       ORDER BY id ASC`,
      [orderId]
    ) as [Array<Record<string, unknown>>, unknown];

    // ── 3. ¿Ya tiene solicitud activa? ────────────────────────
    const [existing] = await pool.query(
      `SELECT id, status FROM factura_requests
       WHERE order_id = ? AND status IN ('pendiente','procesada')
       LIMIT 1`,
      [orderId]
    ) as [Array<Record<string, unknown>>, unknown];

    res.json({
      order: {
        id:           order.id,
        folio:        String(order.id).padStart(6, "0"),
        name:         order.name,
        phone:        order.phone,
        guests:       order.guests,
        status:       order.order_status,
        date:         order.order_date ?? order.created_at,
        total:        Number(order.total),
        tax:          Number(order.tax),
        totalWithTax: Number(order.total_with_tax),
        paymentMethod: order.payment_method,
        tableName:    order.table_name ?? null,
      },
      items: (itemRows as any[]).map((i) => ({
        id:        i.id,
        dishName:  i.item_name ?? "Platillo",
        quantity:  Number(i.quantity),
        unitPrice: Number(i.unit_price),
        subtotal:  Number(i.subtotal),
        notes:     i.notes ?? null,
      })),
      alreadyRequested:
        existing && existing.length > 0
          ? { id: (existing[0] as any).id, status: (existing[0] as any).status }
          : null,
    });
  } catch (err) {
    console.error("[facturas] getOrden error:", err);
    res.status(500).json({ error: "Error interno al consultar la orden." });
  }
};

/* ══════════════════════════════════════════════════════════════
   POST /api/facturas/solicitar
   Guarda la solicitud de facturación en BD
══════════════════════════════════════════════════════════════ */
export const solicitarFactura = async (req: Request, res: Response): Promise<void> => {
  const { orderId, rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email } = req.body;

  if (!orderId || !rfc || !razonSocial || !regimenFiscal || !codigoPostal || !usoCfdi || !email) {
    res.status(400).json({ error: "Todos los campos son obligatorios." });
    return;
  }

  const rfcRegex = /^([A-ZÑ&]{3,4})\d{6}([A-Z\d]{3})$/;
  if (!rfcRegex.test(rfc.toUpperCase())) {
    res.status(400).json({ error: "RFC inválido." });
    return;
  }

  if (!/^\d{5}$/.test(codigoPostal)) {
    res.status(400).json({ error: "Código postal inválido." });
    return;
  }

  try {
    // Verificar que la orden exista
    const [orderCheck] = await pool.query(
      "SELECT id FROM orders WHERE id = ? LIMIT 1",
      [parseInt(orderId, 10)]
    ) as [Array<unknown>, unknown];

    if (!orderCheck || orderCheck.length === 0) {
      res.status(404).json({ error: "Orden no encontrada." });
      return;
    }

    // Verificar duplicado
    const [dup] = await pool.query(
      `SELECT id FROM factura_requests
       WHERE order_id = ? AND status IN ('pendiente','procesada') LIMIT 1`,
      [orderId]
    ) as [Array<unknown>, unknown];

    if (dup && dup.length > 0) {
      res.status(409).json({
        error: "Ya existe una solicitud de factura activa para esta orden.",
        existing: (dup[0] as any).id,
      });
      return;
    }

    // Insertar solicitud
    const [result] = await pool.query(
      `INSERT INTO factura_requests
         (order_id, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, email)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        parseInt(orderId, 10),
        rfc.toUpperCase(),
        razonSocial.trim(),
        regimenFiscal,
        codigoPostal,
        usoCfdi,
        email.toLowerCase().trim(),
      ]
    ) as [import("mysql2").ResultSetHeader, unknown];

    res.status(201).json({
      success: true,
      solicitudId: result.insertId,
      message: `Solicitud registrada. Recibirás tu CFDI en ${email} en 24–48 horas.`,
    });
  } catch (err) {
    console.error("[facturas] solicitarFactura error:", err);
    res.status(500).json({ error: "Error interno al guardar la solicitud." });
  }
};

/* ══════════════════════════════════════════════════════════════
   POST /api/facturas/timbrar/:solicitudId
   Timbra la factura con Facturama y actualiza el status en BD.
   ⚠️  Solo llamar desde panel de admin (proteger con middleware).
══════════════════════════════════════════════════════════════ */
export const timbrarFactura = async (req: Request, res: Response): Promise<void> => {
  const solicitudId = parseInt(req.params.solicitudId, 10);
  if (isNaN(solicitudId)) { res.status(400).json({ error: "ID inválido." }); return; }

  try {
    // ── 1. Obtener la solicitud ───────────────────────────────
    const [solRows] = await pool.query(
      "SELECT * FROM factura_requests WHERE id = ? AND status = 'pendiente' LIMIT 1",
      [solicitudId]
    ) as [Array<Record<string, any>>, unknown];

    if (!solRows || solRows.length === 0) {
      res.status(404).json({ error: "Solicitud no encontrada o ya procesada." });
      return;
    }
    const sol = solRows[0];

    // ── 2. Obtener orden + items ──────────────────────────────
    const [orderRows] = await pool.query(
      `SELECT id, order_date, created_at, payment_method, total, tax, total_with_tax
       FROM orders WHERE id = ? LIMIT 1`,
      [sol.order_id]
    ) as [Array<Record<string, any>>, unknown];

    if (!orderRows || orderRows.length === 0) {
      res.status(404).json({ error: "Orden no encontrada." });
      return;
    }
    const order = orderRows[0];

    const [itemRows] = await pool.query(
      `SELECT item_name, quantity, price AS subtotal,
              ROUND(price / quantity, 6) AS unit_price
       FROM order_items WHERE order_id = ? ORDER BY id`,
      [sol.order_id]
    ) as [Array<Record<string, any>>, unknown];

    // ── 3. Construir y timbrar CFDI ───────────────────────────
    const { crearCfdi } = await import("../services/facturama.service.js");

    const fecha = new Date(order.order_date ?? order.created_at)
      .toISOString()
      .slice(0, 19); // "2026-05-30T12:00:00"

    const result = await crearCfdi({
      folio:         String(sol.order_id).padStart(6, "0"),
      fecha,
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

    // ── 4. Actualizar status en BD ────────────────────────────
    await pool.query(
      `UPDATE factura_requests
       SET status = 'procesada',
           notas  = ?
       WHERE id = ?`,
      [`CFDI: ${result.uuid} | Facturama ID: ${result.cfdiId}`, solicitudId]
    );

    res.json({
      success:   true,
      uuid:      result.uuid,
      cfdiId:    result.cfdiId,
      message:   `Factura timbrada y enviada a ${sol.email}`,
    });
  } catch (err: any) {
    console.error("[facturas] timbrarFactura error:", err);
    res.status(500).json({ error: err?.message ?? "Error al timbrar la factura." });
  }
};