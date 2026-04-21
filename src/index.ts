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
app.use(
  cors({
    origin: [
      "https://lapeñadesantiago.com",
      "https://xn--lapeadesantiago-1qb.com",
      "https://www.lapeñadesantiago.com",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
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