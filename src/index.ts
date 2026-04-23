import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { pool } from "./db.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ==================== CORS CONFIG ====================
const ALLOWED_ORIGINS = [
  // Producción (Unicode y punycode del mismo dominio)
  "https://lapeñadesantiago.com",
  "https://xn--lapeadesantiago-1qb.com",
  "https://www.lapeñadesantiago.com",
  "https://www.xn--lapeadesantiago-1qb.com",
  // Dev local
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
];

// Agrega orígenes extra desde variable de entorno (ej: CORS_EXTRA_ORIGINS=https://miapp.com)
if (process.env.CORS_EXTRA_ORIGINS) {
  ALLOWED_ORIGINS.push(...process.env.CORS_EXTRA_ORIGINS.split(",").map(s => s.trim()));
}

const corsOptions: cors.CorsOptions = {
  origin(requestOrigin, callback) {
    // Peticiones sin Origin (curl, Postman, SSR) → permitir
    if (!requestOrigin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(requestOrigin)) return callback(null, true);
    callback(new Error(`CORS bloqueado: ${requestOrigin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200, // algunos proxies no manejan 204
};

app.use(cors(corsOptions));
// Responde preflight OPTIONS en todas las rutas (necesario cuando Traefik/Nginx interfiere)
app.options("*", cors(corsOptions));
// =====================================================

app.use(express.json());

app.use(
  "/uploads",
  express.static(path.join(__dirname, "../../uploads"))
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

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
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error leyendo menú" });
  }
});

app.get("/api/products", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, price, category_id, image_path FROM products"
    );
    res.json(rows);
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