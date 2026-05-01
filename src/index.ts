import express from "express";
import cors from "cors";
import "dotenv/config";
import mysql from "mysql2/promise";
import { pool } from "./db.js";

const app = express();

// ==================== CORS CONFIG ====================
const ALLOWED_ORIGINS = [
  "https://lapeñadesantiago.com",
  "https://xn--lapeadesantiago-1qb.com",
  "https://www.lapeñadesantiago.com",
  "https://www.xn--lapeadesantiago-1qb.com",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
];

if (process.env.CORS_EXTRA_ORIGINS) {
  ALLOWED_ORIGINS.push(...process.env.CORS_EXTRA_ORIGINS.split(",").map(s => s.trim()));
}

const corsOptions: cors.CorsOptions = {
  origin(requestOrigin, callback) {
    if (!requestOrigin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(requestOrigin)) return callback(null, true);
    callback(new Error(`CORS bloqueado: ${requestOrigin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
// =====================================================

app.use(express.json());


// Base URL donde viven las imágenes (servidor Hostinger, no este container)
const STATIC_BASE_URL = (process.env.STATIC_BASE_URL ?? "").replace(/\/$/, "");

// ==================== POOL DB USUARIOS ====================
function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno requerida: ${name}`);
  return v;
}

const usersPool = mysql.createPool({
  host:     mustEnv("USERS_DB_HOST"),
  user:     mustEnv("USERS_DB_USER"),
  password: mustEnv("USERS_DB_PASSWORD"),
  database: mustEnv("USERS_DB_NAME"),
  port:     Number(process.env.USERS_DB_PORT ?? "3306"),
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 15000,
});

// ── Helpers JWT (mismo algoritmo que config.php) ──────────────
const TOKEN_SECRET = mustEnv("TOKEN_SECRET");
import crypto from "crypto";

function verifyToken(token: string): { sub: number; rol: string } | null {
  try {
    const [header, payload, sig] = token.split(".");
    if (!header || !payload || !sig) return null;
    const expected = crypto
      .createHmac("sha256", TOKEN_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64");
    if (expected !== sig) return null;
    const data = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    if (!data || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function getAuthUser(req: express.Request, res: express.Response): { sub: number; rol: string } | null {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, error: "No autorizado" });
    return null;
  }
  const data = verifyToken(auth.slice(7));
  if (!data) {
    res.status(401).json({ ok: false, error: "Token inválido o expirado" });
    return null;
  }
  return data;
}
// =============================================================

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// ==================== GALLERY COMMENTS ====================

// Rate limit: máximo 5 comentarios por usuario por hora
const commentRateLimit = new Map<number, { count: number; resetAt: number }>();
function checkCommentRateLimit(userId: number): boolean {
  const now = Date.now();
  const entry = commentRateLimit.get(userId);
  if (!entry || now > entry.resetAt) {
    commentRateLimit.set(userId, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

// GET — Leer comentarios (público)
app.get("/api/gallery-comments", async (_req, res) => {
  try {
    const [rows] = await usersPool.query(`
      SELECT id, author, avatar, text, date_label AS date
      FROM gallery_comments
      ORDER BY created_at DESC
      LIMIT 200
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error("[gallery-comments GET]", err);
    res.status(500).json({ ok: false, error: "Error al cargar comentarios" });
  }
});

// POST — Crear comentario (requiere token JWT)
app.post("/api/gallery-comments", async (req, res) => {
  const authData = getAuthUser(req, res);
  if (!authData) return;

  if (!checkCommentRateLimit(authData.sub)) {
    res.status(429).json({ ok: false, error: "Demasiados comentarios. Intenta más tarde." });
    return;
  }

  const text = (req.body?.text ?? "").toString().trim();
  if (!text || text.length > 500) {
    res.status(422).json({ ok: false, error: "El comentario debe tener entre 1 y 500 caracteres" });
    return;
  }

  try {
    // Obtener nombre real del usuario
    const [rows] = await usersPool.query(
      "SELECT id, nombre FROM usuarios WHERE id = ? LIMIT 1",
      [authData.sub]
    ) as [Array<{ id: number; nombre: string }>, unknown];

    const usuario = rows[0];
    if (!usuario) {
      res.status(404).json({ ok: false, error: "Usuario no encontrado" });
      return;
    }

    const author = usuario.nombre;
    const avatar = author.charAt(0).toUpperCase();
    const dateLabel = new Date().toLocaleDateString("es-MX", {
      day: "numeric", month: "short", year: "numeric",
    });

    const [result] = await usersPool.query(
      `INSERT INTO gallery_comments (usuario_id, author, avatar, text, date_label)
       VALUES (?, ?, ?, ?, ?)`,
      [usuario.id, author, avatar, text, dateLabel]
    ) as [mysql.ResultSetHeader, unknown];

    res.status(201).json({
      ok: true,
      data: {
        id:     String(result.insertId),
        author,
        avatar,
        text,
        date:   dateLabel,
      },
    });
  } catch (err) {
    console.error("[gallery-comments POST]", err);
    res.status(500).json({ ok: false, error: "Error al guardar comentario" });
  }
});
// ==========================================================

app.get("/api/dishes", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name FROM dishes ORDER BY id DESC");
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error leyendo dishes" });
  }
});

app.get("/api/menu", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        d.id,
        d.name,
        d.price,
        d.category_id,
        d.image_path,
        c.name  AS category_name
      FROM dishes d
      LEFT JOIN categories c ON c.id = d.category_id
      ORDER BY c.id, d.name
    `) as [Array<Record<string, unknown>>, unknown];
    const data = rows.map(row => ({
      ...row,
      image_path: STATIC_BASE_URL ? `${STATIC_BASE_URL}${row.image_path}` : row.image_path,
    }));
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error leyendo menú" });
  }
});

app.get("/api/products", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, price, category_id, image_path FROM products"
    ) as [Array<Record<string, unknown>>, unknown];
    const data = rows.map(row => ({
      ...row,
      image_path: STATIC_BASE_URL ? `${STATIC_BASE_URL}${row.image_path}` : row.image_path,
    }));
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error leyendo productos" });
  }
});

const PORT = Number(process.env.PORT ?? 4000);

app.listen(PORT, () => {
  console.log(`✅ API corriendo en http://localhost:${PORT}`);
  console.log(`🖼️  Imágenes en   http://localhost:${PORT}/uploads/`);
});