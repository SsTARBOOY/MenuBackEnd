-- ============================================================================
-- 03_assert_show.sql — Aserciones PROD post-migración, SIN information_schema.
--   · Las de DATOS (a1,a2,a3,a5,a9) siguen imprimiendo PASS/FAIL en una celda.
--   · Las de METADATA (a4,a6,a7,a8) usan SHOW → revisión VISUAL (qué buscar anotado).
--
-- ⚠️ SELECCIONA LA BD DESTINO antes de pegar. No inserta ni borra nada.
-- ============================================================================

-- a1) Cero órdenes sin token (backfill completo) → PASS/FAIL.
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL (', COUNT(*), ' sin token)')) AS a1_backfill_sin_nulls
FROM orders WHERE factura_token IS NULL OR factura_token = '';

-- a2) Formato: 8 caracteres y solo el alfabeto permitido → PASS/FAIL.
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL (', COUNT(*), ' inválidos)')) AS a2_formato
FROM orders
WHERE factura_token IS NOT NULL
  AND (CHAR_LENGTH(factura_token) <> 8
       OR factura_token REGEXP '[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]');

-- a3) Cero colisiones de token → PASS/FAIL.
SELECT IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL (', COUNT(*), ' colisiones)')) AS a3_token_unico
FROM (SELECT factura_token FROM orders GROUP BY factura_token HAVING COUNT(*) > 1) c;

-- a5) La FUNCIÓN genera un token válido (sin insertar nada) → PASS/FAIL.
SELECT IF(gen_factura_token() REGEXP '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$', 'PASS', 'FAIL') AS a5_funcion_ok;

-- ── Metadata vía SHOW (revisión visual; "qué buscar" en cada comentario) ─────────────
-- a4) UNIQUE de factura_token → busca la fila Key_name='uq_orders_factura_token' con Non_unique=0.
SHOW INDEX FROM orders WHERE Key_name = 'uq_orders_factura_token';

-- a6) El TRIGGER existe → debe listar 1 fila (Event=INSERT, Timing=BEFORE).
SHOW TRIGGERS WHERE `Trigger` = 'trg_orders_factura_token';

-- a7) Columnas cfdi_id + uuid en factura_requests → deben aparecer las DOS filas.
SHOW COLUMNS FROM factura_requests WHERE Field IN ('cfdi_id','uuid');

-- a8) UNIQUE de solicitud activa → busca Key_name='uq_factura_active_order' con Non_unique=0.
--     (active_order_id sale como 'VIRTUAL GENERATED' en: SHOW COLUMNS FROM factura_requests LIKE 'active_order_id')
SHOW INDEX FROM factura_requests WHERE Key_name = 'uq_factura_active_order';

-- a9) Informativo (no PASS/FAIL): backfill cfdi_id desde notas. Ambos números deberían coincidir.
SELECT
  SUM(status = 'procesada' AND notas LIKE 'CFDI:%' AND notas NOT LIKE '%undefined%') AS procesadas_con_uuid_en_notas,
  SUM(status = 'procesada' AND cfdi_id IS NOT NULL)                                   AS con_cfdi_id_backfilleado
FROM factura_requests;
