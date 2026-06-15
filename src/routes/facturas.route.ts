// server/src/routes/facturas.route.ts
import { Router } from "express";
import {
  getOrden, solicitarFactura, timbrarFactura,
  descargarFactura, reenviarFactura,
} from "../controllers/facturas.controller.js";
import { requireAdmin, solicitarRateLimit, reobtencionRateLimit } from "../auth.js";

const router = Router();

// Público — cliente consulta su orden (candado: token del ticket + ventana; ver getOrden)
router.get("/orden/:id", getOrden);

// Público — cliente envía solicitud de factura (Grupo G: rate-limit por IP)
router.post("/solicitar", solicitarRateLimit, solicitarFactura);

// Público — reobtención de una factura YA emitida (Gap B): descarga PDF/XML y reenvío.
// 🔒 Mismo candado token+sucursal+folio+lockout (en el controlador) + rate-limit (aquí),
//    SIN ventana. NO re-timbra.
router.get("/factura/:orderId/documento", reobtencionRateLimit, descargarFactura);
router.post("/factura/:orderId/reenviar", reobtencionRateLimit, reenviarFactura);

// Admin — timbrar/re-timbrar factura con Facturama (Grupo G: requiere JWT rol=admin)
router.post("/timbrar/:solicitudId", requireAdmin, timbrarFactura);

export default router;
