-- ============================================================================
--  Rollback de migration.sql (factura_token + columnas CFDI + unicidad activa)
--  Motor: MariaDB 11.8.6  ·  Idempotente  ·  Aplica a las DOS BD
--
--  La migración es ADDITIVE-ONLY, así que el rollback es seguro y reversible:
--  borra columnas/índices/rutinas añadidos. NO toca datos de negocio existentes
--  (solo desaparece la columna factura_token y las columnas cfdi_id/uuid/active_order_id).
--
--  ⚠️ Respaldo antes (ver README.md). Correr con el cliente mariadb/mysql.
--  El ORDEN importa: índices antes que columnas; trigger antes que su función.
-- ============================================================================

-- 6) Unicidad de solicitud activa
ALTER TABLE factura_requests DROP INDEX  IF EXISTS uq_factura_active_order;
ALTER TABLE factura_requests DROP COLUMN IF EXISTS active_order_id;

-- 5) Columnas CFDI dedicadas
ALTER TABLE factura_requests DROP COLUMN IF EXISTS uuid;
ALTER TABLE factura_requests DROP COLUMN IF EXISTS cfdi_id;

-- 2) Trigger (depende de la función → se borra antes)
DROP TRIGGER IF EXISTS trg_orders_factura_token;

-- 4) + 1) Índice y columna del token
ALTER TABLE orders DROP INDEX  IF EXISTS uq_orders_factura_token;
ALTER TABLE orders DROP COLUMN IF EXISTS factura_token;

-- 0) Rutinas auxiliares
DROP FUNCTION  IF EXISTS gen_factura_token;
DROP PROCEDURE IF EXISTS backfill_factura_token;

-- Verificación: ninguna de estas debe existir tras el rollback.
--   SHOW TRIGGERS LIKE 'orders';
--   SHOW FUNCTION STATUS WHERE Name = 'gen_factura_token';
--   SELECT COLUMN_NAME FROM information_schema.COLUMNS
--     WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN
--       ('factura_token','cfdi_id','uuid','active_order_id');
