-- seed.sql — Esquema SINTÉTICO (sin PII real) que reproduce las columnas relevantes de las
-- BD de La Peña, con filas PREEXISTENTES (sin factura_token) para probar el backfill.
-- Se carga ANTES de migration.sql.

SET NAMES utf8mb4;

-- ── orders (InnoDB; sin factura_token: lo agrega la migración) ──────────────────
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS factura_requests;
DROP TABLE IF EXISTS orders;

CREATE TABLE orders (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(120) NULL,
  guests         INT NULL,
  order_status   VARCHAR(30)  NULL,
  order_date     DATETIME     NULL,
  total          DECIMAL(10,2) NULL,
  tax            DECIMAL(10,2) NULL,
  total_with_tax DECIMAL(10,2) NULL,
  payment_method VARCHAR(50)  NULL,
  table_id       INT NULL,
  created_at     DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 1000 órdenes preexistentes (sin token) usando la SEQUENCE de MariaDB.
INSERT INTO orders (name, guests, order_status, order_date, total, tax, total_with_tax, payment_method, table_id)
SELECT CONCAT('Cliente ', seq), 1 + (seq % 6), 'completed',
       NOW() - INTERVAL (seq % 28) DAY,
       100 + (seq % 900), 0, 100 + (seq % 900),
       ELT(1 + (seq % 3), 'efectivo', 'tarjeta', 'Pending'), 1 + (seq % 20)
FROM seq_1_to_1000;

-- ── factura_requests (InnoDB) ───────────────────────────────────────────────────
CREATE TABLE factura_requests (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  order_id       INT NOT NULL,
  rfc            VARCHAR(13) NOT NULL,
  razon_social   VARCHAR(255) NOT NULL,
  regimen_fiscal VARCHAR(10) NOT NULL,
  codigo_postal  VARCHAR(5) NOT NULL,
  uso_cfdi       VARCHAR(10) NOT NULL,
  email          VARCHAR(255) NOT NULL,
  status         ENUM('pendiente','procesada','cancelada') NOT NULL DEFAULT 'pendiente',
  notas          TEXT NULL,
  created_at     DATETIME NOT NULL DEFAULT current_timestamp(),
  updated_at     TIMESTAMP NULL,
  KEY idx_order (order_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- procesada REAL (con UUID + ID en notas → debe backfillear cfdi_id/uuid)
INSERT INTO factura_requests (order_id, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, email, status, notas)
VALUES (10, 'XAXX010101000', 'PUBLICO EN GENERAL', '616', '76000', 'S01', 'a@x.com', 'procesada',
        'CFDI: 12345678-90ab-cdef-1234-567890abcdef | ID: abc123XYZ | email:ok');

-- procesada FANTASMA (sin UUID, ID undefined → NO debe backfillear)
INSERT INTO factura_requests (order_id, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, email, status, notas)
VALUES (11, 'PEPJ800101AAA', 'JUAN PEREZ', '612', '76000', 'G03', 'b@x.com', 'procesada',
        'CFDI:  | ID: undefined');

-- pendiente y cancelada (la cancelada NO cuenta como activa)
INSERT INTO factura_requests (order_id, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, email, status)
VALUES (12, 'PEPJ800101AAA', 'JUAN PEREZ', '612', '76000', 'G03', 'c@x.com', 'pendiente'),
       (12, 'PEPJ800101AAA', 'JUAN PEREZ', '612', '76000', 'G03', 'c@x.com', 'cancelada'),
       (13, 'GARL750120AAA', 'LAURA GARCIA', '605', '76000', 'G03', 'd@x.com', 'pendiente');
-- Nota: order_id=12 tiene 1 activa (pendiente) + 1 cancelada → NO viola el UNIQUE activo.
