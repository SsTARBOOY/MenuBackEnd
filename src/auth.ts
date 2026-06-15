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

// Exportada para reutilizarla en el controlador (misma lógica de IP que el rate-limit;
// depende de app.set("trust proxy", 1) en index.ts para no confiar en X-Forwarded-For falso).
export function clientIp(req: Request): string {
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

// ── Lockout por FALLOS para el código del ticket (GA) ──────────────────────────
// Defensa que sostiene la seguridad del código corto (8 chars ≈ 40 bits). Se cuentan
// SOLO los fallos (código equivocado/ausente en el camino cliente); el éxito limpia.
//
//   • PRINCIPAL — por IP: frena la fuerza bruta desde una fuente.
//   • SECUNDARIO — por folio: MUY suave y CORTO. Acota un ataque DISTRIBUIDO sobre un
//     mismo folio sin habilitar un DoS dirigido fácil: el bloqueo es de minutos (se
//     autocura) y quien lo provoca desde una IP se auto-bloquea por IP antes.
//
// Umbrales PRO usuario no técnico (toleran errores de tecleo, bloqueos cortos) y
// env-configurables. Cota de fuerza bruta documentada en el spec del token:
//   peor caso (ataque distribuido sostenido 24h sobre 1 folio) ≈ FOLIO_MAX fallos por
//   bloqueo → ~8 cada 5 min ⇒ ~2.3k intentos/24h ⇒ P ≈ 2.7×10⁻⁹ (orden ~1e-9); en la
//   práctica mucho menor por el throttle por IP y porque el código expira en 24h.
//
// ⚠️ En memoria: válido con UNA instancia (Coolify actual). Con réplicas, el lock por
//    folio se evade rotando instancias → requiere store compartido (Redis/tabla). Ver spec.
type LockEntry = { fails: number; windowEndsAt: number; blockedUntil: number };
const accessAttempts = new Map<string, LockEntry>();

const IP_MAX_FAILS     = Number(process.env.FACT_IP_MAX_FAILS     ?? "15");
const IP_WINDOW_MS     = Number(process.env.FACT_IP_WINDOW_MS     ?? String(10 * 60_000));
const IP_BLOCK_MS      = Number(process.env.FACT_IP_BLOCK_MS      ?? String(5 * 60_000));
const FOLIO_MAX_FAILS  = Number(process.env.FACT_FOLIO_MAX_FAILS  ?? "8");
const FOLIO_WINDOW_MS  = Number(process.env.FACT_FOLIO_WINDOW_MS  ?? String(10 * 60_000));
const FOLIO_BLOCK_MS   = Number(process.env.FACT_FOLIO_BLOCK_MS   ?? String(5 * 60_000));

const ipKey    = (ip: string): string => `ip:${ip}`;
const folioKey = (sucursal: string, folio: number | string): string => `folio:${sucursal}:${folio}`;

// Barrido perezoso para que el Map no crezca sin límite (atiende el backlog del leak).
let lastSweep = 0;
function sweepAccess(now: number): void {
  if (now - lastSweep < 5 * 60_000) return;
  lastSweep = now;
  for (const [k, e] of accessAttempts) {
    if (e.blockedUntil <= now && e.windowEndsAt <= now) accessAttempts.delete(k);
  }
}

function bumpFailure(key: string, maxFails: number, windowMs: number, blockMs: number, now: number): void {
  let e = accessAttempts.get(key);
  if (!e || e.windowEndsAt <= now) {
    e = { fails: 0, windowEndsAt: now + windowMs, blockedUntil: 0 };
    accessAttempts.set(key, e);
  }
  e.fails += 1;
  if (e.fails >= maxFails) {
    e.blockedUntil  = now + blockMs;   // bloqueo temporal corto
    e.fails         = 0;               // ventana fresca al expirar
    e.windowEndsAt  = now + blockMs + windowMs;
  }
}

function blockedUntilOf(key: string, now: number): number {
  const e = accessAttempts.get(key);
  return e && e.blockedUntil > now ? e.blockedUntil : 0;
}

// Llamar ANTES de tocar la BD. Si está bloqueado (por IP o por folio) → el controlador
// responde 429 genérico ("demasiados intentos") sin revelar si el folio existe.
export function checkAccessLock(
  ip: string, sucursal: string, folio: number | string,
): { blocked: boolean; retryAfterSec: number } {
  const now = Date.now();
  sweepAccess(now);
  const until = Math.max(
    blockedUntilOf(ipKey(ip), now),
    blockedUntilOf(folioKey(sucursal, folio), now),
  );
  return { blocked: until > now, retryAfterSec: until > now ? Math.ceil((until - now) / 1000) : 0 };
}

// Registrar un intento FALLIDO (código equivocado/ausente en el camino cliente).
export function registerAccessFailure(ip: string, sucursal: string, folio: number | string): void {
  const now = Date.now();
  bumpFailure(ipKey(ip),               IP_MAX_FAILS,    IP_WINDOW_MS,    IP_BLOCK_MS,    now);
  bumpFailure(folioKey(sucursal, folio), FOLIO_MAX_FAILS, FOLIO_WINDOW_MS, FOLIO_BLOCK_MS, now);
}

// Éxito (código correcto): limpia los contadores de esa IP y ese folio.
export function resetAccessFailures(ip: string, sucursal: string, folio: number | string): void {
  accessAttempts.delete(ipKey(ip));
  accessAttempts.delete(folioKey(sucursal, folio));
}
