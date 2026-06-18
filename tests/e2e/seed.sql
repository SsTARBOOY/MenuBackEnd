-- server/tests/e2e/seed.sql
-- Datos de PRUEBA para la suite E2E con BD. Ejecutar en la BD de prueba de GUERRERO.
-- ⚠️ NUNCA en producción. Requiere el esquema (copia de prod SIN datos) + la migración
--    factura_token aplicada (la columna orders.factura_token debe existir).
-- Idempotente: borra y reinserta el rango reservado 990000–990099.
-- INSERT-ONLY: NO hace DROP/CREATE → seguro sobre un esquema EXISTENTE (p. ej. Hostinger testOrdenar).
-- El DELETE va hijos→padres (factura_requests/order_items antes que orders) por las FKs.

DELETE FROM factura_requests WHERE order_id BETWEEN 990000 AND 990099;
DELETE FROM order_items      WHERE order_id BETWEEN 990000 AND 990099;
DELETE FROM orders           WHERE id       BETWEEN 990000 AND 990099;

-- Órdenes completadas, del mes en curso, precio CON IVA incluido ($200 → base 172.41 + IVA 27.59).
-- phone/shift_id/user_id: NOT NULL sin default en el esquema de prod (testOrdenar es copia de prod).
INSERT INTO orders (id, name, phone, guests, order_status, order_date, total, tax, total_with_tax, payment_method, shift_id, user_id, factura_token)
VALUES
  (990001, 'TEST E2E', '0000000000', 2, 'completed', NOW(), 200, 0, 200, 'Efectivo', 1, 1, 'TOKEN001'),
  (990002, 'TEST E2E', '0000000000', 2, 'completed', NOW(), 200, 0, 200, 'Efectivo', 1, 1, 'TOKEN002'),
  (990003, 'TEST E2E', '0000000000', 2, 'completed', NOW(), 200, 0, 200, 'Efectivo', 1, 1, 'TOKEN003'),
  (990004, 'TEST E2E', '0000000000', 2, 'completed', NOW(), 200, 0, 200, 'Efectivo', 1, 1, 'TOKEN004');

INSERT INTO order_items (order_id, item_name, quantity, price)
VALUES
  (990001, 'Enchiladas de mole', 1, 200),
  (990002, 'Enchiladas de mole', 1, 200),
  (990003, 'Enchiladas de mole', 1, 200),
  (990004, 'Enchiladas de mole', 1, 200);

-- Nota: si tu esquema tiene más columnas NOT NULL sin default, añádelas arriba.
