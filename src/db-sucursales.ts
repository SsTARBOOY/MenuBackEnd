// server/src/db-sucursales.ts
import mysql from "mysql2/promise";

export type Sucursal = "guerrero" | "madero";

export const guerreroPool = mysql.createPool({
  host:               process.env.DB_GUERRERO_HOST     ?? "srv1250.hstgr.io",
  user:               process.env.DB_GUERRERO_USER     ?? "",
  password:           process.env.DB_GUERRERO_PASSWORD ?? "",
  database:           process.env.DB_GUERRERO_NAME     ?? "",
  port:               Number(process.env.DB_GUERRERO_PORT ?? "3306"),
  waitForConnections: true,
  connectionLimit:    10,
  connectTimeout:     15000,
});

export const maderoPool = mysql.createPool({
  host:               process.env.DB_MADERO_HOST     ?? "srv1250.hstgr.io",
  user:               process.env.DB_MADERO_USER     ?? "",
  password:           process.env.DB_MADERO_PASSWORD ?? "",
  database:           process.env.DB_MADERO_NAME     ?? "",
  port:               Number(process.env.DB_MADERO_PORT ?? "3306"),
  waitForConnections: true,
  connectionLimit:    10,
  connectTimeout:     15000,
});

export const getPool = (sucursal: Sucursal) =>
  sucursal === "guerrero" ? guerreroPool : maderoPool;