// server/src/services/notify.ts
// ─────────────────────────────────────────────────────────────────
//  Alerta al dueño (Oscar) por Telegram cuando un timbrado falla.
//  Principios:
//   • FAIL-SOFT: jamás lanza ni bloquea el flujo de facturación (se llama con `void`).
//   • ENV-GATED: sin NOTIFY_TELEGRAM_TOKEN/CHAT_ID es un no-op silencioso.
//   • SIN PII sensible: el llamador manda RFC enmascarado; nunca el payload del receptor.
//   • DEDUP: evita spam — una alerta por clave dentro de su ventana (p. ej. 1/folio/día).
//  Cero dependencias nuevas: usa fetch nativo (Node 18+), igual que facturama.service.
// ─────────────────────────────────────────────────────────────────

// clave de dedup -> epoch ms del último envío. Vive en memoria del proceso (single-instance).
// ⚠️ Si Coolify corre múltiples réplicas, el dedup no se comparte (peor caso: N alertas, no 0).
const lastSent = new Map<string, number>();

export interface NotifyOpts {
  dedupKey?: string;
  dedupMs?: number; // ventana de dedup; default 24 h
}

export async function notifyOwner(text: string, opts: NotifyOpts = {}): Promise<void> {
  const token  = process.env.NOTIFY_TELEGRAM_TOKEN;
  const chatId = process.env.NOTIFY_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // alertas desactivadas (sin credenciales)

  if (opts.dedupKey) {
    const now    = Date.now();
    const window = opts.dedupMs ?? 24 * 60 * 60 * 1000;
    const last   = lastSent.get(opts.dedupKey) ?? 0;
    if (now - last < window) return; // ya se avisó hace poco
    lastSent.set(opts.dedupKey, now);
    // Limpieza perezosa para que el Map no crezca sin límite.
    if (lastSent.size > 500) {
      for (const [k, t] of lastSent) if (now - t > window) lastSent.delete(k);
    }
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // FAIL-SOFT: la alerta nunca rompe el timbrado. (El fallo ya quedó en console.error.)
  }
}
