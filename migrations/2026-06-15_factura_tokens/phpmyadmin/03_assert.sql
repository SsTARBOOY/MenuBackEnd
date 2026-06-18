-- ============================================================================
-- 03_assert.sql — Aserciones post-migración, DATA-AGNÓSTICAS (sirven sobre los datos
-- reales de testOrdenar, no dependen de filas sembradas). Pegar en la pestaña SQL.
-- Cada SELECT imprime una columna con PASS / FAIL. Todas deben decir PASS.
-- NO inserta ni borra nada (la prueba del trigger va aparte en el README, opcional).
--
-- ⚠️ BD destino seleccionada (NO information_schema). Este script NUNCA usa `USE` ni
--    cambia el contexto: information_schema va SIEMPRE calificado por TABLE_SCHEMA =
--    DATABASE(). No se hardcodea el nombre de la BD (sirve en testOrdenar y prod).
-- ============================================================================

-- 1) Cero órdenes sin token (backfill completo).
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL (', COUNT(*), ' sin token)')) AS a1_backfill_sin_nulls
FROM orders WHERE factura_token IS NULL OR factura_token = '';

-- 2) Formato: 8 caracteres y solo el alfabeto permitido.
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL (', COUNT(*), ' inválidos)')) AS a2_formato
FROM orders
WHERE factura_token IS NOT NULL
  AND (CHAR_LENGTH(factura_token) <> 8
       OR factura_token REGEXP '[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]');

-- 3) Cero colisiones de token.
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL (', COUNT(*), ' colisiones)')) AS a3_token_unico
FROM (SELECT factura_token FROM orders GROUP BY factura_token HAVING COUNT(*) > 1) c;

-- 4) Índice UNIQUE de factura_token.
SELECT IF(COUNT(*) = 1, 'PASS', 'FAIL (sin UNIQUE)') AS a4_unique_token
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
  AND INDEX_NAME = 'uq_orders_factura_token' AND NON_UNIQUE = 0;

-- 5) La FUNCIÓN genera un token válido (sin insertar nada en la tabla).
SELECT IF(gen_factura_token() REGEXP '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$', 'PASS', 'FAIL') AS a5_funcion_ok;

-- 6) El TRIGGER existe.
SELECT IF(COUNT(*) = 1, 'PASS', 'FAIL') AS a6_trigger_existe
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = 'trg_orders_factura_token';

-- 7) Columnas cfdi_id + uuid en factura_requests.
SELECT IF(COUNT(*) = 2, 'PASS', 'FAIL') AS a7_cols_cfdi
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factura_requests'
  AND COLUMN_NAME IN ('cfdi_id','uuid');

-- 8) UNIQUE de solicitud activa (columna generada).
SELECT IF(COUNT(*) = 1, 'PASS', 'FAIL') AS a8_unique_activa
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factura_requests'
  AND INDEX_NAME = 'uq_factura_active_order' AND NON_UNIQUE = 0;

-- 9) Backfill informativo (no es PASS/FAIL): cuántas 'procesada' con UUID en notas
--    quedaron con cfdi_id poblado. Ambos números deberían coincidir.
SELECT
  SUM(status = 'procesada' AND notas LIKE 'CFDI:%' AND notas NOT LIKE '%undefined%') AS procesadas_con_uuid_en_notas,
  SUM(status = 'procesada' AND cfdi_id IS NOT NULL)                                   AS con_cfdi_id_backfilleado
FROM factura_requests;
