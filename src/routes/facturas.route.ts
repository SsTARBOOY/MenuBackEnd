// server/src/routes/facturas.route.ts
import { Router } from "express";
import { getOrden, solicitarFactura, timbrarFactura } from "../controllers/facturas.controller.js";

const router = Router();

// Público — cliente consulta su orden
router.get("/orden/:id", getOrden);

// Público — cliente envía solicitud de factura
router.post("/solicitar", solicitarFactura);

// Admin — timbrar factura con Facturama
// ⚠️ Agregar middleware de autenticación admin antes de producción
router.post("/timbrar/:solicitudId", timbrarFactura);

export default router;