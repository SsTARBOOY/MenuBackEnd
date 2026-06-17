# Migración — `factura_token` + columnas CFDI + unicidad de solicitud activa

**Motor:** MariaDB 11.8.6 · **Idempotente** · **Additive-only** (el backend viejo la ignora) · **NO correr en prod sin respaldo**

Aplica IGUAL a las dos BD: `u522428285_ordenar` (Guerrero) y `u522428285_maderoOrdenar` (Madero).

## Qué hace
1. `orders` + `factura_token CHAR(8)`.
2. Trigger `BEFORE INSERT` que lo genera (alfabeto `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, RANDOM_BYTES + rejection sampling).
3. Backfill en lotes de las filas existentes + reparación de colisiones.
4. `UNIQUE(factura_token)` **después** del backfill.
5. `factura_requests` + `cfdi_id`, `uuid` (+ backfill opcional desde `notas`).
6. Unicidad de **solicitud activa** por `order_id` vía **columna generada** `active_order_id` + `UNIQUE` (MariaDB no tiene índice parcial).

## Archivos
- `migration.sql` — la migración.
- `rollback.sql` — revierte todo (additive → seguro).
- `test/` — harness Docker + verificación del algoritmo + aserciones.

---

## 1. Respaldo OBLIGATORIO antes de aplicar (mysqldump)
```bash
# Guerrero
mysqldump -h <DB_HOST> -u <DB_ADMIN_USER> -p \
  --single-transaction --routines --triggers --events --hex-blob \
  u522428285_ordenar > backup_ordenar_$(date +%F_%H%M).sql

# Madero
mysqldump -h <DB_HOST> -u <DB_ADMIN_USER> -p \
  --single-transaction --routines --triggers --events --hex-blob \
  u522428285_maderoOrdenar > backup_madero_$(date +%F_%H%M).sql
```
`--single-transaction` = dump consistente de InnoDB sin bloquear. `--routines --triggers` = incluye la función/trigger nuevos (para que el respaldo sea fiel tras aplicar).

## 2. Aplicar (con el cliente, NO con un driver)
```bash
mariadb -h <DB_HOST> -u <DB_ADMIN_USER> -p u522428285_ordenar       < migration.sql
mariadb -h <DB_HOST> -u <DB_ADMIN_USER> -p u522428285_maderoOrdenar < migration.sql
```
O subir el `.sql` en **phpMyAdmin → Importar** (entiende `DELIMITER`).

## 3. Revertir
```bash
mariadb ... u522428285_ordenar       < rollback.sql
mariadb ... u522428285_maderoOrdenar < rollback.sql
```

---

## ⚠️ Caveats de Hostinger (revisar antes de correr en prod)
- **Privilegios:** se necesitan `ALTER`, `INDEX`, `CREATE ROUTINE`, `TRIGGER`. El usuario suele tenerlos sobre su propia BD; si no, pedir al hosting.
- **`log_bin_trust_function_creators`:** si el binlog está activo, crear la función no-determinista puede requerir esta opción (o `SUPER`). El harness de prueba ya la activa. Si Hostinger lo bloquea → **alternativa**: generar el token desde la app (Node) al crear la orden y NO instalar la función/trigger (los pasos 1, 4, 5, 6 siguen aplicando).
- **`RANDOM_BYTES`** requiere MariaDB ≥ 10.10 (11.8.6 ✓).
- **Paso 6 (UNIQUE de solicitud activa):** si ya existen **duplicados activos** del bug de carrera viejo, el `ADD UNIQUE` falla. El script trae un **PRECHECK** que los lista. Remediar las trabadas/fantasmas primero y **re-ejecutar** (es idempotente).

---

## 4. Probar localmente (reproducible, sin tocar prod)
Desde `test/`, con Docker:
```bash
cd test && ./run-test.sh
```
Levanta MariaDB 11.8.6 efímera, siembra un esquema **sintético (sin PII)**, aplica la migración, corre aserciones, prueba el bloqueo de duplicado activo, la **idempotencia** (2ª corrida) y el **rollback**, y limpia.

### Estado de la verificación en esta entrega
- ✅ **Algoritmo del token VERIFICADO** (ejecutado): `node test/verify-token-algo.mjs` — 500k tokens sin colisión, distribución uniforme (Chi²≈25 ≪ 59.7), y se demuestra que el rejection sampling elimina el sesgo de módulo (sin él Chi²≈11030).
- ⚠️ **Ejecución del SQL contra MariaDB: PENDIENTE de correr el harness.** El entorno donde se redactó esto **no tiene Docker/MariaDB/cliente mysql**, por lo que el `.sql` se revisó estáticamente contra la semántica de MariaDB 11.8.6 pero **no se ejecutó aquí**. Corre `test/run-test.sh` en una máquina con Docker para obtener la evidencia de ejecución antes de aplicar en prod.
