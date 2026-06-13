// server/src/routes/facturas.route.ts
import { Router } from "express";
import { getOrden, solicitarFactura, timbrarFactura } from "../controllers/facturas.controller.js";
import { requireAdmin, solicitarRateLimit } from "../auth.js";

const router = Router();

// Público — cliente consulta su orden
// ⚠️ Pendiente (orden APARTE, prioridad ALTA): IDOR — :id secuencial sin auth expone PII.
//    Fix recomendado: token de un solo uso ligado al folio impreso en el QR del ticket.
router.get("/orden/:id", getOrden);

// Público — cliente envía solicitud de factura (Grupo G: rate-limit por IP)
router.post("/solicitar", solicitarRateLimit, solicitarFactura);

// Admin — timbrar/re-timbrar factura con Facturama (Grupo G: requiere JWT rol=admin)
router.post("/timbrar/:solicitudId", requireAdmin, timbrarFactura);

export default router;
