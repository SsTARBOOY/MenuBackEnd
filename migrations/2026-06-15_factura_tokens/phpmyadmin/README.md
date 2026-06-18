# Correr la migración en `testOrdenar` vía phpMyAdmin (SIN Docker)

Prueba de humo en la BD de pruebas **`testOrdenar`** (2 MB, mismo esquema que prod) antes de
tocar `ordenar`/`maderoOrdenar`. Todo se pega en la **pestaña SQL** de phpMyAdmin.

> phpMyAdmin SÍ entiende `DELIMITER` en el cuadro de SQL, así que `CREATE FUNCTION/TRIGGER/PROCEDURE`
> se crean correctamente. Si tu versión llegara a quejarse del `DELIMITER` en el textarea,
> usa la pestaña **Importar** y sube `../migration.sql` como archivo (mismo efecto).

## Orden de ejecución

1. **Selecciona la BD `testOrdenar`** en el panel izquierdo de phpMyAdmin.

2. **Paso 1 — Precheck (read-only).** Pega `01_precheck.sql` → **Continuar**. Verifica:
   - `mariadb_version` ≥ 10.10 (prod es 11.8.6).
   - `orders` y `factura_requests` → **InnoDB** ambas.
   - El resultado de **duplicados activos** debe ser **0 filas**. Si hay filas, NO migres:
     remedia esas trabadas/fantasmas primero (el `UNIQUE` del paso 6 fallaría).

3. **Paso 2 — Migración.** Pega el contenido COMPLETO de **`../migration.sql`** → **Continuar**.
   - Es idempotente: si la corres dos veces no rompe.
   - Verás resultados intermedios (la aserción de colisiones del paso 3c = 0, y el precheck
     del paso 6). Si el `ALTER … ADD UNIQUE` del paso 6 falla, es por duplicados activos
     (ver paso 1): remedia y vuelve a pegar la migración.

4. **Paso 3 — Aserciones.** Pega `03_assert.sql` → **Continuar**. **Todas** las columnas deben
   decir **`PASS`** (a1…a8). El resultado #9 es informativo (cuántas `procesada` se
   backfillearon con `cfdi_id`).

5. **(Opcional) Probar el TRIGGER con una orden desechable** — inserta y borra:
   ```sql
   INSERT INTO orders (name, order_status, payment_method) VALUES ('PRUEBA_TRIGGER', 'completed', 'efectivo');
   SELECT id, factura_token FROM orders WHERE name = 'PRUEBA_TRIGGER';  -- debe traer un token de 8 chars
   DELETE FROM orders WHERE name = 'PRUEBA_TRIGGER';                     -- limpieza
   ```

6. **(Opcional) Resetear `testOrdenar`** para volver a probar desde cero: pega `../rollback.sql`.

## Cómo leer el resultado
- phpMyAdmin muestra cada `SELECT` como una mini-tabla. Las aserciones (paso 3) son una sola
  fila/columna con el texto `PASS` o `FAIL (…detalle…)`.
- **Luz verde para prod** = el paso 2 corrió sin errores (función + trigger + procedure creados)
  **y** el paso 3 mostró `PASS` en todo.

## Nota Hostinger (binlog)
- La función `gen_factura_token()` se declara **`NOT DETERMINISTIC NO SQL`**. El `NO SQL` evita
  el error **1418** ("This function has none of DETERMINISTIC, NO SQL, or READS SQL DATA…")
  aunque el binlog esté activo → **no** necesitas `log_bin_trust_function_creators`.
- Sí necesitas que el usuario de la BD tenga privilegios **`CREATE ROUTINE`** y **`TRIGGER`**
  (lo normal sobre la propia BD en Hostinger).

## Para producción (después de la luz verde en testOrdenar)
1. **Respaldo primero** (ver `../README.md` → `mysqldump --single-transaction --routines --triggers`).
2. Correr `01_precheck.sql` → `../migration.sql` → `03_assert.sql` en `ordenar` y en `maderoOrdenar`.
3. La migración en prod va **ANTES** del deploy del backend nuevo (recordatorio: additive-only,
   el backend viejo la ignora).
