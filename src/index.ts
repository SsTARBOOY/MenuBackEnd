import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { pool } from "./db.js";

const app = express();

// ── Para poder usar __dirname en ESM ──────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

app.use(cors());
app.use(express.json());

// ── Servir imágenes estáticas desde /uploads ──────────────────────────────────
// Las imágenes en la DB tienen image_path = "/uploads/dishes/imagen.png"
// El frontend las pide como: http://localhost:4000/uploads/dishes/imagen.png
app.use(
  "/uploads",
  express.static(path.join(__dirname, "../../uploads"))
);

/** Health */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/** SOLO NOMBRES */
app.get("/api/dishes", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name FROM dishes ORDER BY id DESC");
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error leyendo dishes" });
  }
});

/** MENÚ COMPLETO con imagen */
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

/** Products */
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