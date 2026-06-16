#!/usr/bin/env bash
# run-test.sh — Prueba end-to-end de la migración contra MariaDB 11.8.6 efímera.
# Requiere Docker. Desde esta carpeta:  ./run-test.sh
set -euo pipefail
cd "$(dirname "$0")"

DC="docker compose"
MARIADB="$DC exec -T db mariadb -uroot -prootpw testdb"

echo "== 1) Levantando MariaDB 11.8.6 =="
$DC up -d
echo "== 2) Esperando healthcheck =="
until [ "$($DC ps --format '{{.Health}}' db 2>/dev/null)" = "healthy" ]; do sleep 2; done

echo "== 3) Algoritmo del token (Node, independiente de la BD) =="
node verify-token-algo.mjs

echo "== 4) Seed (esquema sintético + filas preexistentes) =="
$MARIADB < seed.sql

echo "== 5) Migración =="
$MARIADB < ../migration.sql

echo "== 6) Aserciones =="
$MARIADB --table < assert.sql

echo "== 7) UNIQUE de solicitud activa: 2ª activa del mismo order_id DEBE fallar (1062) =="
if $MARIADB -e "INSERT INTO factura_requests (order_id,rfc,razon_social,regimen_fiscal,codigo_postal,uso_cfdi,email,status) VALUES (13,'GARL750120AAA','LAURA GARCIA','605','76000','G03','d@x.com','procesada');" 2>/tmp/dup.err; then
  echo "FAIL  8_unique_activa_bloquea: el INSERT duplicado NO falló"
else
  grep -q 1062 /tmp/dup.err && echo "PASS  8_unique_activa_bloquea (ERROR 1062 como se esperaba)" || { echo "FAIL  error inesperado:"; cat /tmp/dup.err; }
fi

echo "== 9) Idempotencia: re-ejecutar la migración no debe romper =="
$MARIADB < ../migration.sql >/dev/null && echo "PASS  9_idempotente (2ª corrida OK)"

echo "== 10) Rollback =="
$MARIADB < ../rollback.sql
LEFT=$($MARIADB -N -e "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME IN ('factura_token','cfdi_id','uuid','active_order_id');")
[ "$LEFT" = "0" ] && echo "PASS  10_rollback_limpio" || echo "FAIL  10_rollback dejó $LEFT columnas"

echo "== 11) Limpieza =="
$DC down -v
echo "== LISTO =="
