// server/src/db.ts
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

function must<T>(name: string): T {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Falta variable de entorno requerida: ${name}`);
  }
  return v as T;
}

const DB_HOST = must<string>('DB_HOST');
const DB_USER = must<string>('DB_USER');
const DB_PASSWORD = must<string>('DB_PASSWORD');
const DB_NAME   = must<string>('DB_NAME');
const DB_PORT   = Number(process.env.DB_PORT ?? '3306');

export const pool = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  port: DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 15000,         // 15 segundos
});

(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('¡Conexión MySQL EXITOSA!');
    console.log(`→ Host: ${DB_HOST}`);
    console.log(`→ Base: ${DB_NAME}`);
    console.log(`→ Usuario: ${DB_USER}`);
    conn.release();
  } catch (err: any) {
    console.error('❌ ERROR AL CONECTAR A LA BASE DE DATOS:');
    console.error(err.message);
    if (err.code) console.error('Código de error:', err.code);
    if (err.errno) console.error('Número de error:', err.errno);
    console.error('Verifica: IP permitida, contraseña, nombre BD, acceso remoto en Hostinger');
  }
})();