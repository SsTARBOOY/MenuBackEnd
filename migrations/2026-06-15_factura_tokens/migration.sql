-- ============================================================================
--  Migración: factura_token + columnas CFDI + unicidad de solicitud activa
--  Motor:   MariaDB 11.8.6   ·   Idempotente · ADDITIVE-ONLY · re-ejecutable
--  Aplica IGUAL a las DOS BD:  u522428285_ordenar  y  u522428285_maderoOrdenar
--
--  ⚠️ NO correr en producción sin respaldo previo (ver README.md → mysqldump).
--  ⚠️ Correr con el CLIENTE mariadb/mysql (entiende DELIMITER). NO con un driver
--     que no soporte multi-statement/rutinas.
--  ⚠️ El backend VIEJO ignora estas columnas/índices (additive) → seguro desplegar antes
--     o después del código nuevo.
--
--  Privilegios necesarios: ALTER, INDEX, CREATE ROUTINE, TRIGGER sobre la BD.
--  Si el binlog está activo y rechaza la función no-determinista, pedir al hosting
--  `log_bin_trust_function_creators=1` o crear la rutina con un usuario con SUPER.
--  Alternativa si el hosting bloquea rutinas: generar el token desde la app (ver README).
-- ============================================================================

-- Alfabeto (31): 23456789ABCDEFGHJKMNPQRSTUVWXYZ  (sin 0 O 1 I L, anti-ambigüedad)
-- 8 chars → 31^8 ≈ 8.5e11 ≈ 39.6 bits de entropía.

-- ---------------------------------------------------------------------------
-- 0) Función generadora del token (rejection sampling, SIN sesgo de módulo)
--    RANDOM_BYTES requiere MariaDB ≥ 10.10 (11.8.6 ✓).
--    NO consulta la tabla `orders` (un BEFORE INSERT trigger no puede leer su propia
--    tabla → error 1442); la unicidad la garantiza el índice UNIQUE del paso 4. En la
--    colisión astronómicamente rara (~1 en 8.5e11) el INSERT falla con clave duplicada
--    y la app/POS reintenta el INSERT (nuevo token). Verificado: test/verify-token-algo.mjs
-- ---------------------------------------------------------------------------
DELIMITER $$
CREATE OR REPLACE FUNCTION gen_factura_token() RETURNS CHAR(8)
  NOT DETERMINISTIC
  NO SQL
BEGIN
  DECLARE alphabet CHAR(31) DEFAULT '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  DECLARE tok CHAR(8) DEFAULT '';
  DECLARE b SMALLINT;
  WHILE CHAR_LENGTH(tok) < 8 DO
    SET b = ORD(RANDOM_BYTES(1));            -- byte cripto 0..255
    -- 248 = 8*31 → aceptar 0..247 (uniforme vía MOD 31); descartar 248..255 evita el sesgo.
    IF b < 248 THEN
      SET tok = CONCAT(tok, SUBSTRING(alphabet, (b MOD 31) + 1, 1));
    END IF;
  END WHILE;
  RETURN tok;
END$$
DELIMITER ;

-- ---------------------------------------------------------------------------
-- 1) orders: columna factura_token (NULL por ahora; el UNIQUE va en el paso 4)
-- ---------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS factura_token CHAR(8) NULL;

-- ---------------------------------------------------------------------------
-- 2) Trigger BEFORE INSERT: genera el token si la app no lo provee.
-- ---------------------------------------------------------------------------
DELIMITER $$
CREATE OR REPLACE TRIGGER trg_orders_factura_token
BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
  IF NEW.factura_token IS NULL OR NEW.factura_token = '' THEN
    SET NEW.factura_token = gen_factura_token();
  END IF;
END$$
DELIMITER ;

-- ---------------------------------------------------------------------------
-- 3) Backfill de filas existentes EN LOTES + reparación de colisiones.
--    Idempotente: solo toca filas con token NULL y duplicados.
-- ---------------------------------------------------------------------------
DELIMITER $$
CREATE OR REPLACE PROCEDURE backfill_factura_token()
BEGIN
  DECLARE n INT DEFAULT 1;
  -- 3a) Rellenar NULLs en lotes de 500 (cada fila obtiene un token nuevo).
  WHILE n > 0 DO
    UPDATE orders SET factura_token = gen_factura_token()
      WHERE factura_token IS NULL OR factura_token = ''
      LIMIT 500;
    SET n = ROW_COUNT();
  END WHILE;
  -- 3b) Reparar colisiones: regenerar el token de cada duplicado (conserva el id menor)
  --     hasta que no quede ninguno. Con ~40 bits esto casi nunca itera.
  SET n = 1;
  WHILE n > 0 DO
    UPDATE orders o
      JOIN (
        SELECT MIN(id) AS keep_id, factura_token
        FROM orders
        WHERE factura_token IS NOT NULL
        GROUP BY factura_token
        HAVING COUNT(*) > 1
      ) d ON o.factura_token = d.factura_token AND o.id <> d.keep_id
      SET o.factura_token = gen_factura_token();
    SET n = ROW_COUNT();
  END WHILE;
END$$
DELIMITER ;

CALL backfill_factura_token();
DROP PROCEDURE IF EXISTS backfill_factura_token;

-- 3c) ASERCIÓN: debe devolver 0. Si no, NO continuar (revisar el backfill).
SELECT COUNT(*) AS colisiones_token_restantes FROM (
  SELECT factura_token FROM orders
  WHERE factura_token IS NOT NULL
  GROUP BY factura_token HAVING COUNT(*) > 1
) x;

-- ---------------------------------------------------------------------------
-- 4) UNIQUE sobre factura_token (DESPUÉS del backfill: ya no hay NULLs ni dupes).
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD UNIQUE INDEX IF NOT EXISTS uq_orders_factura_token (factura_token);

-- ---------------------------------------------------------------------------
-- 5) factura_requests: columnas dedicadas cfdi_id + uuid (dejar de parsear `notas`).
-- ---------------------------------------------------------------------------
ALTER TABLE factura_requests
  ADD COLUMN IF NOT EXISTS cfdi_id VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS uuid    CHAR(36)    NULL;

-- 5b) Backfill opcional desde `notas` ("CFDI: <uuid> | ID: <cfdiId>"). Idempotente.
--     Ignora fantasmas (sin UUID o ID 'undefined'). MariaDB usa PCRE (lookbehind OK).
UPDATE factura_requests
SET uuid    = REGEXP_SUBSTR(notas, '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'),
    cfdi_id = REGEXP_SUBSTR(notas, '(?<=ID: )[^ |]+')
WHERE status = 'procesada'
  AND (uuid IS NULL OR cfdi_id IS NULL)
  AND notas LIKE 'CFDI:%'
  AND notas NOT LIKE '%undefined%';

-- ---------------------------------------------------------------------------
-- 6) Unicidad de SOLICITUD ACTIVA por order_id.
--    MariaDB NO tiene índice parcial → se emula con una COLUMNA GENERADA que vale
--    order_id cuando la solicitud está activa y NULL cuando no. Como los NULL se repiten
--    libremente en un UNIQUE, solo se bloquea una 2ª fila ACTIVA del mismo order_id.
--
--    ⚠️ PRECHECK: si ya existen duplicados activos (del bug de carrera viejo), el UNIQUE
--       fallará. Remediar las trabadas/fantasmas ANTES y RE-EJECUTAR (es idempotente).
-- ---------------------------------------------------------------------------
-- PRECHECK (debe devolver 0 filas para que el paso 6 pueda completar):
SELECT order_id, COUNT(*) AS solicitudes_activas
FROM factura_requests
WHERE status IN ('pendiente','procesada')
GROUP BY order_id HAVING COUNT(*) > 1;

ALTER TABLE factura_requests
  ADD COLUMN IF NOT EXISTS active_order_id INT
    AS (IF(status IN ('pendiente','procesada'), order_id, NULL)) VIRTUAL;

ALTER TABLE factura_requests
  ADD UNIQUE INDEX IF NOT EXISTS uq_factura_active_order (active_order_id);

-- ============================================================================
-- Fin. Verificación rápida post-migración (ver test/assert.sql para el set completo):
--   SHOW INDEX FROM orders WHERE Key_name = 'uq_orders_factura_token';
--   SELECT COUNT(*) FROM orders WHERE factura_token IS NULL;          -- esperado 0
--   SELECT CHAR_LENGTH(factura_token), COUNT(*) FROM orders GROUP BY 1; -- esperado solo (8, N)
-- ============================================================================
