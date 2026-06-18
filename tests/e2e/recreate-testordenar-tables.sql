-- recreate-testordenar-tables.sql — RECUPERACIÓN de testOrdenar (Hostinger).
-- Recrea las tablas hijas `factura_requests` y `order_items` que se borraron por error al pegar
-- el seed Docker (que hace DROP TABLE) en phpMyAdmin. `orders` SOBREVIVIÓ y NO se toca aquí.
--
-- DDL copiado EXACTO de un branch de prod (Guerrero, ya migrada) vía SHOW CREATE TABLE — incluye
-- las columnas de la migración (`cfdi_id`, `uuid`, `active_order_id` VIRTUAL) y el índice
-- `uq_factura_active_order`, que la e2e usa.
--
-- Pegar en phpMyAdmin con **testOrdenar** seleccionada. Usa CREATE (no IF NOT EXISTS): si ya
-- existieran, falla ruidoso (señal de que no hacía falta). order_items trae su FK→orders(id);
-- orders ya existe, así que la FK valida. AUTO_INCREMENT se omite (arranca de 1).

-- GUARD: aborta si estás en una BD de PROD. Subquery escalar → 2 filas → ERROR 1242 (independiente
-- de sql_mode), deteniendo el script. En testOrdenar (no-prod) devuelve NULL y continúa.
SELECT (SELECT 1 FROM (SELECT 1 UNION SELECT 2) g
        WHERE DATABASE() IN ('u522428285_ordenar','u522428285_maderoOrdenar','u522428285_maderodenar','u522428285_lapena_db')
       ) AS _abortar_si_es_prod;

-- 1) factura_requests (sin FK; con la columna generada + el UNIQUE de solicitud activa)
CREATE TABLE `factura_requests` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id` int(11) NOT NULL,
  `rfc` varchar(13) NOT NULL,
  `razon_social` varchar(255) NOT NULL,
  `regimen_fiscal` varchar(10) NOT NULL,
  `codigo_postal` varchar(5) NOT NULL,
  `uso_cfdi` varchar(10) NOT NULL,
  `email` varchar(255) NOT NULL,
  `status` enum('pendiente','procesada','cancelada') NOT NULL DEFAULT 'pendiente',
  `notas` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE current_timestamp(),
  `cfdi_id` varchar(64) DEFAULT NULL,
  `uuid` char(36) DEFAULT NULL,
  `active_order_id` int(11) GENERATED ALWAYS AS (if(`status` in ('pendiente','procesada'),`order_id`,NULL)) VIRTUAL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_factura_active_order` (`active_order_id`),
  KEY `idx_order_id` (`order_id`),
  KEY `idx_status` (`status`),
  KEY `idx_rfc` (`rfc`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) order_items (FK→orders(id) ON DELETE CASCADE; orders ya existe)
CREATE TABLE `order_items` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id` int(11) NOT NULL,
  `item_name` varchar(100) DEFAULT NULL,
  `quantity` int(11) DEFAULT NULL,
  `price` decimal(10,2) DEFAULT NULL,
  `notes` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `order_id` (`order_id`),
  CONSTRAINT `order_items_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) Verificación (debe listar las dos tablas + el UNIQUE y la columna generada).
SHOW TABLES LIKE 'order_items';
SHOW TABLES LIKE 'factura_requests';
SHOW INDEX FROM factura_requests WHERE Key_name = 'uq_factura_active_order';
SHOW COLUMNS FROM factura_requests LIKE 'active_order_id';
