# RUNBOOK PROD — migración `factura_token` + CFDI + unicidad de solicitud activa

**Motor:** MariaDB 11.8.6 (Hostinger) · **Additive-only · idempotente · el backend viejo la ignora**
**BD:** `u522428285_ordenar` (Guerrero) y `u522428285_maderoOrdenar` (Madero)
**Verificado en `testOrdenar`:** apply + backfill + assert (a1..a8) + rollback limpio + re-apply. Privilegios Hostinger OK (función + trigger se crean sin error).

> ## ✅ Estado (2026-06-17) — FASE DE BD CERRADA: LAS DOS SUCURSALES MIGRADAS Y VERIFICADAS
> - **Guerrero `u522428285_ordenar`: MIGRADO y verificado.** Backfill 5141/5141, 0 sin token, 0 colisiones,
>   trigger/función OK, `factura_requests` completo.
> - **Madero `u522428285_maderoOrdenar`: MIGRADO y verificado** (assert a1–a9 verde; trigger probado en vivo:
>   un INSERT nuevo generó `HNWD3EAK`, fila de prueba borrada).
> - **Nada más que correr del lado de BD.** Lo que resta es de aplicación: actualizar el POS (read-back +
>   `&t=`) y desplegar el backend nuevo. El backend sirve ambas sucursales; ambas ya tienen `factura_token`.

---

## Secuencia global de despliegue (orden importa)

```
1. MIGRACIÓN en BD (este runbook)   ← additive; la BD ya genera token a toda orden nueva vía trigger
2. Actualizar el POS                ← leer factura_token de vuelta + imprimir &t= y el código XXXX-XXXX
3. Deploy del backend nuevo         ← recién aquí se exige token en el camino cliente (admin/caja exento)
```

Por qué este orden: la migración es additive y el backend viejo ignora las columnas nuevas → es segura
de correr primero. El POS va después de la migración (necesita que la columna exista para leerla). El
backend nuevo va al final, cuando los tickets ya traen token; el camino **admin/caja queda exento**, así
que la caja sigue facturando durante toda la transición.

**Ventana:** bajo tráfico. El impacto es de segundos (ADD COLUMN nullable es instantáneo; backfill ~5k
filas en lotes de 500; el ADD UNIQUE construye índice sobre ~5k filas). No requiere parar la caja.

---

## Migración de Madero — `<BD>` = `u522428285_maderoOrdenar`

Guerrero ya está migrado y verificado (ver estado arriba); **NO se re-corre**. Los pasos de abajo aplican
**solo a Madero** (`<BD>` = `u522428285_maderoOrdenar`).

### Paso 1 — Respaldo FRESCO (obligatorio, sin excepción)

**Opción A — `mysqldump` (si tienes SSH a Hostinger):**
```bash
mysqldump -h <DB_HOST> -u <DB_ADMIN_USER> -p \
  --single-transaction --routines --triggers --events --hex-blob \
  <BD> > backup_<BD>_$(date +%F_%H%M).sql
```
`--single-transaction` = dump consistente de InnoDB sin bloquear · `--routines --triggers` = incluye lo nuevo.

**Opción B — phpMyAdmin (sin SSH):** selecciona `<BD>` → pestaña **Exportar** → método **Personalizado** →
formato SQL → marca **Estructura + Datos**, **Add DROP TABLE**, y **CREATE PROCEDURE/FUNCTION/EVENT** y
**triggers** → Continuar y guarda el `.sql`.

> ✋ No avances al paso 2 sin el archivo de respaldo guardado y verificado (que pese > 0 y abra).

### Paso 2 — Precheck (read-only) — **GATE**

Selecciona `<BD>` en phpMyAdmin → pestaña **SQL** → pega `phpmyadmin/01_precheck_show.sql` → Continuar.
Verifica:

- `bd_destino_seleccionada` = `<BD>` (NO information_schema).
- `version` ≥ 10.10 (prod 11.8.6).
- `orders` y `factura_requests` → **ambas InnoDB**.
- **GATE de duplicados activos → DEBE devolver 0 filas.**

**🔴 Si el GATE devuelve filas → DETENTE. NO migres.** Son `order_id` con >1 solicitud activa (residuo
del bug de carrera). El `ADD UNIQUE` del paso 6 fallaría. Remediación (es ESCRITURA; ya tienes respaldo):

```sql
-- 1) Inspecciona los duplicados (decide a mano cuál conservar):
SELECT id, order_id, status, created_at, updated_at,
       (notas LIKE 'CFDI:%' AND notas NOT LIKE '%undefined%') AS tiene_cfdi_real
FROM factura_requests
WHERE order_id IN ( /* los order_id que arrojó el GATE */ )
ORDER BY order_id, created_at;

-- 2) Conserva UNA por order_id (la timbrada real: tiene_cfdi_real=1 y status='procesada')
--    y pasa el resto a 'cancelada'. Ejemplo por id (NO un UPDATE ciego):
UPDATE factura_requests SET status='cancelada' WHERE id IN ( /* los ids fantasma a descartar */ );
```
Regla: cada `order_id` debe quedar con **a lo más una** fila en `('pendiente','procesada')`. Si dos
parecen timbradas reales para el mismo folio → revisión manual (posible doble timbrado). Tras remediar,
**re-corre el precheck** (debe dar 0 filas) y sigue.

### Paso 3 — Migración

Pestaña **Importar** → archivo `migration.sql` → **desmarca "Importación parcial"** (parcial OFF, para que
corra TODAS las sentencias) → Continuar. (phpMyAdmin entiende `DELIMITER`, así que función/trigger/procedure
se crean bien.)

- Es idempotente: si por algo la corres dos veces, no rompe.
- Resultados intermedios esperados: `colisiones_token_restantes` = **0** (paso 3c) y el precheck del paso 6
  = **0 filas**.
- **🔴 Si el `ADD UNIQUE` del paso 6 truena** → es por duplicados activos: regresa al paso 2, remedia, y
  vuelve a Importar `migration.sql` (idempotente).

### Paso 4 — Aserciones

Pestaña **SQL** → pega `phpmyadmin/03_assert_show.sql` → Continuar. Verde si:

| Check | Verde |
|-------|-------|
| a1, a2, a3, a5 | celda = **PASS** |
| a4 | `SHOW INDEX` orders: `uq_orders_factura_token` con **Non_unique=0** (cardinalidad ≈ AUTO_INCREMENT) |
| a6 | `trg_orders_factura_token` → 1 fila (Event=INSERT, Timing=BEFORE) |
| a7 | `cfdi_id` + `uuid` → 2 filas |
| a8 | `SHOW INDEX` factura_requests: `uq_factura_active_order` con **Non_unique=0** |

### Paso 5 — Probar el POS (integración real)

Camino recomendado (sin basura en prod): genera **una orden real con el POS** y verifica:
1. La orden recién creada trae `factura_token` poblado (8 chars).
2. El ticket impreso lleva el **QR con `&t=<token>`** y el **código `XXXX-XXXX`**.
3. Abre `lapeñadesantiago.com/facturacion?sucursal=<suc>&folio=<id>&t=<token>` → carga la orden.

**Smoke test del trigger SIN POS (recomendado en Madero recién migrado):** `orders` **no tiene FKs salientes**
(verificado), NOT NULL reales = `name, phone, guests, order_status, total, tax, total_with_tax, shift_id, user_id`.
`factura_token` se omite a propósito (lo pone el trigger). Deja un hueco de AUTO_INCREMENT (inofensivo).
```sql
INSERT INTO orders (name, phone, guests, order_status, order_date, total, tax, total_with_tax, payment_method, shift_id, user_id)
VALUES ('ZZ_PRUEBA_TRIGGER_DEL', '0000000000', 1, 'completed', NOW(), 1.00, 0.00, 1.00, 'efectivo', 1, 1);
SELECT id, factura_token, CHAR_LENGTH(factura_token) AS largo FROM orders WHERE name = 'ZZ_PRUEBA_TRIGGER_DEL';  -- token 8 chars
DELETE FROM orders WHERE name = 'ZZ_PRUEBA_TRIGGER_DEL';                                                        -- limpiar
```

---

## Criterio de aborto / rollback (por BD)

Si el assert no queda verde o el POS no ve el token, **revierte esa BD** y diagnostica antes de seguir:

```
phpMyAdmin → Importar → rollback.sql   (con <BD> seleccionada)
```
La migración es additive → el rollback es limpio y reversible (no toca datos de negocio; solo quita
`factura_token`, `cfdi_id`, `uuid`, `active_order_id`, sus índices y la función/trigger). Si necesitas
restaurar de cero, tienes el respaldo del paso 1.

---

## Después de las DOS BD en verde

1. **Actualizar el POS** (read-back del token + imprimir `&t=` y `XXXX-XXXX`) en ambas sucursales.
2. **Deploy del backend nuevo** (exige token en camino cliente; admin/caja exento).
3. **Smoke test en prod:** una factura self-service vía QR (cliente) + una vía caja (admin, sin token).

## Checklist final

- [x] **Guerrero: YA MIGRADO + verificado** (2026-06-17) — no re-correr
- [ ] Madero: respaldo · precheck 0 dup · migración OK · assert verde · trigger smoke test
- [ ] POS actualizado (ambas sucursales)
- [ ] **Madero migrado ANTES del deploy del backend** (el backend sirve ambas sucursales)
- [ ] Backend nuevo desplegado
- [ ] Smoke test prod (cliente QR Guerrero + Madero + caja admin)
