-- ============================================================================
-- 01_precheck.sql — READ-ONLY. Pega en la pestaña SQL de phpMyAdmin con la BD DESTINO
-- seleccionada (testOrdenar en pruebas; ordenar / maderoOrdenar en prod).
--
-- ⚠️ Selecciona la BD destino, NO 'information_schema'. Este script NUNCA usa `USE`
--    ni cambia el contexto: las consultas a information_schema van SIEMPRE calificadas
--    por `WHERE TABLE_SCHEMA = DATABASE()`, así el contexto permanece en la BD destino.
--    Por eso NO se hardcodea el nombre de la BD (funciona igual en testOrdenar y prod).
-- ============================================================================

-- 0) CONTEXTO — debe mostrar la BD destino (testOrdenar / ordenar / maderoOrdenar),
--    NUNCA 'information_schema' ni NULL. Si lo es, selecciónala arriba y reejecuta
--    (es la causa del error 1109 "Unknown table … in information_schema").
SELECT DATABASE() AS bd_destino_seleccionada;

-- 1) PRECHECK del paso 6 — duplicados de SOLICITUD ACTIVA por order_id (tabla de negocio:
--    requiere la BD destino seleccionada). DEBE devolver 0 filas. Si devuelve filas, el
--    UNIQUE del paso 6 fallará: remediar esas trabadas/fantasmas ANTES y reejecutar.
SELECT order_id, COUNT(*) AS solicitudes_activas
FROM factura_requests
WHERE status IN ('pendiente','procesada')
GROUP BY order_id
HAVING COUNT(*) > 1;

-- 2) Versión de MariaDB (RANDOM_BYTES requiere ≥ 10.10; columnas generadas ≥ 10.2).
SELECT VERSION() AS mariadb_version;

-- 3) Motor de las tablas: AMBAS deben ser InnoDB (FOR UPDATE + columnas generadas).
--    information_schema calificado por TABLE_SCHEMA = DATABASE() → no cambia el contexto.
SELECT TABLE_NAME, ENGINE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('orders','factura_requests');

-- 4) ¿Ya se aplicó antes? (idempotencia — informativo)
SELECT
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'factura_token') AS ya_existe_columna,
  (SELECT COUNT(*) FROM information_schema.ROUTINES
     WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_NAME = 'gen_factura_token') AS ya_existe_funcion;
