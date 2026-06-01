import express from "express";
import cors from "cors";
import "dotenv/config";
import mysql from "mysql2/promise";
import { pool } from "./db.js";
import { googleReviewsRouter } from "./googleReviews.js";
import facturasRouter from "./routes/facturas.route.js"; // ← NUEVO

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

app.use(cors(corsOptions));
app.use(express.json());

app.use("/api", googleReviewsRouter);
app.use("/api/facturas", facturasRouter); // ← NUEVO

// Base URL donde viven las imágenes (servidor Hostinger, no este container)
const STATIC_BASE_URL = (process.env.STATIC_BASE_URL ?? "").replace(/\/$/, "");

// ==================== POOL DB USUARIOS ====================
import crypto from "crypto";

const USERS_DB_CONFIGURED = !!(
  process.env.USERS_DB_HOST &&
  process.env.USERS_DB_USER &&
  process.env.USERS_DB_PASSWORD &&
  process.env.USERS_DB_NAME &&
  process.env.TOKEN_SECRET
);

const usersPool = USERS_DB_CONFIGURED
  ? mysql.createPool({
      host:     process.env.USERS_DB_HOST!,
      user:     process.env.USERS_DB_USER!,
      password: process.env.USERS_DB_PASSWORD!,
      database: process.env.USERS_DB_NAME!,
      port:     Number(process.env.USERS_DB_PORT ?? "3306"),
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 15000,
    })
  : null;

if (!USERS_DB_CONFIGURED) {
  console.warn("⚠️  USERS_DB / TOKEN_SECRET no configurados — comentarios y reseñas deshabilitados");
}

// ── Helpers JWT ──────────────────────────────────────────────
const TOKEN_SECRET = process.env.TOKEN_SECRET ?? "";

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

function getAuthUser(
  req: express.Request,
  res: express.Response
): { sub: number; rol: string } | null {
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

app.get("/api/gallery-comments", async (_req, res) => {
  if (!usersPool) { res.json({ ok: true, data: [] }); return; }
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

app.post("/api/gallery-comments", async (req, res) => {
  if (!usersPool) {
    res.status(503).json({ ok: false, error: "Comentarios no disponibles en este entorno" });
    return;
  }
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
    const [rows] = await usersPool.query(
      "SELECT id, nombre FROM usuarios WHERE id = ? LIMIT 1",
      [authData.sub]
    ) as [Array<{ id: number; nombre: string }>, unknown];

    const usuario = rows[0];
    if (!usuario) { res.status(404).json({ ok: false, error: "Usuario no encontrado" }); return; }

    const author    = usuario.nombre;
    const avatar    = author.charAt(0).toUpperCase();
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
      data: { id: String(result.insertId), author, avatar, text, date: dateLabel },
    });
  } catch (err) {
    console.error("[gallery-comments POST]", err);
    res.status(500).json({ ok: false, error: "Error al guardar comentario" });
  }
});
// ==========================================================

// ==================== REVIEWS ============================

const reviewRateLimit = new Map<number, { count: number; resetAt: number }>();
function checkReviewRateLimit(userId: number): boolean {
  const now = Date.now();
  const entry = reviewRateLimit.get(userId);
  if (!entry || now > entry.resetAt) {
    reviewRateLimit.set(userId, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }
  if (entry.count >= 3) return false;
  entry.count++;
  return true;
}

app.get("/api/reviews", async (req, res) => {
  if (!usersPool) { res.json({ ok: true, data: [] }); return; }

  const sucursal = (req.query.sucursal as string) ?? "";
  if (!["guerrero", "madero"].includes(sucursal)) {
    res.status(400).json({ ok: false, error: 'Parámetro sucursal inválido. Usa "guerrero" o "madero"' });
    return;
  }

  try {
    const [rows] = await usersPool.query(
      `SELECT
         id, author, avatar, rating, comment, dish, sucursal, verified,
         DATE_FORMAT(created_at, '%Y-%m-%d') AS date
       FROM reviews
       WHERE sucursal = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [sucursal]
    ) as [Array<{
      id: number; author: string; avatar: string; rating: number;
      comment: string; dish: string | null; sucursal: string;
      verified: number; date: string;
    }>, unknown];

    res.json({ ok: true, data: rows.map(r => ({ ...r, id: String(r.id), verified: Boolean(r.verified) })) });
  } catch (err) {
    console.error("[reviews GET]", err);
    res.status(500).json({ ok: false, error: "Error al cargar reseñas" });
  }
});

app.post("/api/reviews", async (req, res) => {
  if (!usersPool) {
    res.status(503).json({ ok: false, error: "Reseñas no disponibles en este entorno" });
    return;
  }

  const authData = getAuthUser(req, res);
  if (!authData) return;

  if (!checkReviewRateLimit(authData.sub)) {
    res.status(429).json({ ok: false, error: "Demasiadas reseñas. Intenta más tarde." });
    return;
  }

  const rating   = Number(req.body?.rating   ?? 0);
  const comment  = (req.body?.comment  ?? "").toString().trim();
  const dish     = (req.body?.dish     ?? "").toString().trim();
  const sucursal = (req.body?.sucursal ?? "").toString().trim();

  if (rating < 1 || rating > 5) {
    res.status(422).json({ ok: false, error: "Calificación inválida (1-5)" }); return;
  }
  if (comment.length < 10 || comment.length > 1000) {
    res.status(422).json({ ok: false, error: "Comentario inválido (10-1000 caracteres)" }); return;
  }
  if (!["guerrero", "madero"].includes(sucursal)) {
    res.status(422).json({ ok: false, error: "Sucursal inválida" }); return;
  }

  try {
    const [rows] = await usersPool.query(
      "SELECT id, nombre FROM usuarios WHERE id = ? LIMIT 1",
      [authData.sub]
    ) as [Array<{ id: number; nombre: string }>, unknown];

    const usuario = rows[0];
    if (!usuario) { res.status(404).json({ ok: false, error: "Usuario no encontrado" }); return; }

    const author = usuario.nombre;
    const avatar = author.charAt(0).toUpperCase();

    const [result] = await usersPool.query(
      `INSERT INTO reviews (usuario_id, author, avatar, rating, comment, dish, sucursal, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [usuario.id, author, avatar, rating, comment, dish || null, sucursal]
    ) as [mysql.ResultSetHeader, unknown];

    res.status(201).json({
      ok: true,
      data: {
        id: String(result.insertId), author, avatar, rating, comment,
        dish: dish || null, sucursal, verified: false,
        date: new Date().toISOString().split("T")[0],
      },
    });
  } catch (err) {
    console.error("[reviews POST]", err);
    res.status(500).json({ ok: false, error: "Error al guardar reseña" });
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
      SELECT d.id, d.name, d.price, d.category_id, d.image_path, c.name AS category_name
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