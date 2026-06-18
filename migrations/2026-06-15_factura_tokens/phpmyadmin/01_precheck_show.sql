-- ============================================================================
-- 01_precheck_show.sql — Precheck PROD vía SHOW/SELECT (CERO information_schema).
-- Inmune al error 1109 "Unknown table … in information_schema": SHOW opera SIEMPRE
-- sobre la BD seleccionada. Read-only: no escribe nada.
--
-- ⚠️ SELECCIONA LA BD DESTINO en el panel izquierdo ANTES de pegar (ordenar / maderoOrdenar).
--    No se hardcodea el nombre: SHOW usa la BD activa. Si DATABASE() no es la destino, cámbiala.
-- ============================================================================

-- 0) CONTEXTO — debe mostrar la BD destino (ordenar / maderoOrdenar), NUNCA information_schema/NULL.
SELECT DATABASE() AS bd_destino_seleccionada;

-- 1) GATE del paso 6 — duplicados de SOLICITUD ACTIVA por order_id. DEBE devolver 0 filas.
--    Si devuelve filas, el UNIQUE del paso 6 fallará: remediar (cancelar/borrar las fantasmas)
--    y reejecutar la migración (es idempotente).
SELECT order_id, COUNT(*) AS solicitudes_activas
FROM factura_requests
WHERE status IN ('pendiente','procesada')
GROUP BY order_id HAVING COUNT(*) > 1;

-- 2) Versión MariaDB (≥ 10.10 para RANDOM_BYTES; ≥ 10.2 para columnas generadas). Prod: 11.8.6.
SHOW VARIABLES LIKE 'version';

-- 3) Motor de las tablas: AMBAS deben decir InnoDB en la columna `Engine`.
SHOW TABLE STATUS WHERE Name IN ('orders','factura_requests');

-- 4) ¿Ya se aplicó? (idempotencia — informativo; 1 fila c/u = ya existe)
SHOW COLUMNS FROM orders LIKE 'factura_token';
SHOW FUNCTION STATUS WHERE Db = DATABASE() AND Name = 'gen_factura_token';
