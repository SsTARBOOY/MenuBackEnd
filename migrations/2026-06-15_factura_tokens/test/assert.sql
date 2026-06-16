-- assert.sql — Aserciones post-migración. Cada bloque imprime un PASS/FAIL legible.
-- Correr DESPUÉS de seed.sql + migration.sql.

-- 1) Todas las órdenes preexistentes quedaron con token (backfill).
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL (', COUNT(*), ' sin token)')) AS `1_backfill_sin_nulls`
FROM orders WHERE factura_token IS NULL OR factura_token = '';

-- 2) Todos los tokens miden 8 y solo usan el alfabeto permitido.
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL (', COUNT(*), ' inválidos)')) AS `2_formato_token`
FROM orders
WHERE factura_token IS NOT NULL
  AND (CHAR_LENGTH(factura_token) <> 8
       OR factura_token REGEXP '[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]');

-- 3) Cero colisiones de token.
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL (', COUNT(*), ' colisiones)')) AS `3_token_unico`
FROM (SELECT factura_token FROM orders GROUP BY factura_token HAVING COUNT(*) > 1) c;

-- 4) Existe el índice UNIQUE de factura_token.
SELECT IF(COUNT(*) = 1, 'PASS', 'FAIL (sin UNIQUE)') AS `4_unique_token`
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
  AND INDEX_NAME = 'uq_orders_factura_token' AND NON_UNIQUE = 0;

-- 5) El trigger genera token en un INSERT nuevo (sin proveerlo).
INSERT INTO orders (name, order_status, payment_method) VALUES ('Nuevo', 'completed', 'efectivo');
SELECT IF(factura_token REGEXP '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$', 'PASS', 'FAIL') AS `5_trigger_genera`
FROM orders WHERE id = LAST_INSERT_ID();

-- 6) Backfill de cfdi_id/uuid: la procesada real SÍ, la fantasma NO.
SELECT IF(cfdi_id = 'abc123XYZ' AND uuid = '12345678-90ab-cdef-1234-567890abcdef', 'PASS', 'FAIL')
       AS `6a_backfill_cfdi_real`
FROM factura_requests WHERE order_id = 10 AND status = 'procesada';

SELECT IF(cfdi_id IS NULL AND uuid IS NULL, 'PASS', 'FAIL') AS `6b_fantasma_sin_backfill`
FROM factura_requests WHERE order_id = 11 AND status = 'procesada';

-- 7) Existe el UNIQUE de solicitud activa (columna generada).
SELECT IF(COUNT(*) = 1, 'PASS', 'FAIL') AS `7_unique_activa`
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factura_requests'
  AND INDEX_NAME = 'uq_factura_active_order' AND NON_UNIQUE = 0;

-- 8) Insertar una 2ª solicitud ACTIVA del mismo order_id DEBE fallar (clave duplicada).
--    Se ejecuta con tolerancia a error; si NO falla, queda la fila y lo detecta el conteo.
-- (En el runner: este INSERT se corre por separado esperando ERROR 1062.)
--    order_id=13 ya tiene una 'pendiente'; intentar otra activa:
-- INSERT INTO factura_requests (order_id, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, email, status)
--   VALUES (13, 'GARL750120AAA', 'LAURA GARCIA', '605', '76000', 'G03', 'd@x.com', 'procesada');
--   → debe responder: ERROR 1062 (23000): Duplicate entry '13' for key 'uq_factura_active_order'
