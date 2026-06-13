// server/src/auth.ts
// ─────────────────────────────────────────────────────────────────
//  Middlewares de seguridad para las rutas de facturas (Grupo G).
//  Reutiliza el MISMO esquema JWT HS256 que ya valida index.ts y que
//  emite la capa PHP (api/config.php createToken): firma base64 sobre
//  `${header}.${payload}` con TOKEN_SECRET, payload con { sub, rol, exp }.
//  TODO: unificar verifyToken de index.ts con este archivo (qa-fixer).
// ─────────────────────────────────────────────────────────────────
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const TOKEN_SECRET = process.env.TOKEN_SECRET ?? "";

export function verifyToken(token: string): { sub: number; rol: string; exp: number } | null {
  try {
    // Fail-closed: sin secreto NINGÚN token es válido. Evita que con TOKEN_SECRET
    // vacío se acepten tokens forjados firmados con clave vacía (qa-fixer, ALTA).
    if (!TOKEN_SECRET) return null;
    const [header, payload, sig] = token.split(".");
    if (!header || !payload || !sig) return null;

    const expected = crypto
      .createHmac("sha256", TOKEN_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64");

    // Comparación en tiempo constante (evita timing attacks). Distinta longitud => inválido.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const data = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    if (!data || typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

// Exige un JWT válido con rol === "admin". Protege POST /timbrar/:id.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, error: "No autorizado" });
    return;
  }
  const data = verifyToken(auth.slice(7));
  if (!data) {
    res.status(401).json({ ok: false, error: "Token inválido o expirado" });
    return;
  }
  if (data.rol !== "admin") {
    res.status(403).json({ ok: false, error: "Requiere permisos de administrador" });
    return;
  }
  next();
}

// ── Rate-limit por IP para el endpoint público /solicitar (Grupo G/H) ──
// Mismo patrón en memoria que /api/reviews y /api/gallery-comments en index.ts.
// Requiere app.set("trust proxy", 1) en index.ts: así req.ip es la IP real depurada por
// el proxy de confianza (Coolify/Cloudflare) y NO un X-Forwarded-For falsificable.
const solicitarHits = new Map<string, { count: number; resetAt: number }>();
const SOLICITAR_MAX = Number(process.env.SOLICITAR_RATE_MAX ?? "5");
const SOLICITAR_WINDOW_MS = Number(process.env.SOLICITAR_RATE_WINDOW_MS ?? String(3_600_000));

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function solicitarRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = solicitarHits.get(ip);
  if (!entry || now > entry.resetAt) {
    solicitarHits.set(ip, { count: 1, resetAt: now + SOLICITAR_WINDOW_MS });
    next();
    return;
  }
  if (entry.count >= SOLICITAR_MAX) {
    res.status(429).json({
      ok: false, error: "rate_limit",
      message: "Demasiadas solicitudes de factura. Espera unos minutos e intenta de nuevo.",
    });
    return;
  }
  entry.count++;
  next();
}
