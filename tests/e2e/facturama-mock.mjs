// server/tests/e2e/facturama-mock.mjs
// Mock determinista de Facturama para los tests E2E. CERO folios, CERO red externa.
// El backend bajo prueba apunta aquí con FACTURAMA_URL=http://127.0.0.1:4555.
//
// Control desde los tests:
//   POST /__arm        { scenario: "ok" | "reject" | "unavailable" }  → arma la próxima respuesta
//   GET  /__last       → último body recibido en POST /3/cfdis (para asertar IVA)
//   GET  /__health     → 200
// Emula:
//   POST /3/cfdis                    → ok | reject(400) | unavailable(503)
//   GET  /Cfdi/:format/issued/:id    → { Content: base64 }   (fail-soft en el backend)
//   POST /cfdi                       → 200                     (envío de correo)
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? "4555");
let scenario = "ok";
let lastCfdiBody = null;

const readJson = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
});
const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  if (url === "/__health") return send(res, 200, { ok: true, scenario });
  if (method === "POST" && url === "/__arm") {
    const body = await readJson(req);
    scenario = body.scenario ?? "ok";
    lastCfdiBody = null;
    return send(res, 200, { ok: true, scenario });
  }
  if (url === "/__last") return send(res, 200, { body: lastCfdiBody });

  // Crear CFDI
  if (method === "POST" && url === "/3/cfdis") {
    lastCfdiBody = await readJson(req);
    if (scenario === "unavailable") return send(res, 503, { Message: "mock: servicio no disponible" });
    if (scenario === "reject") {
      return send(res, 400, {
        Message: "mock: rechazo del PAC",
        ModelState: { "Receiver.Name": ["El nombre del receptor no coincide con el registrado en el SAT."] },
      });
    }
    // ok
    return send(res, 200, {
      Id: "MOCK-CFDI-1",
      Folio: "1",
      Complement: { TaxStamp: { Uuid: randomUUID() } },
    });
  }

  // Descargar PDF/XML
  if (method === "GET" && /^\/Cfdi\/(pdf|xml)\/issued\//.test(url)) {
    return send(res, 200, { Content: Buffer.from("mock-doc").toString("base64") });
  }
  // Enviar correo
  if (method === "POST" && url.startsWith("/cfdi")) return send(res, 200, { ok: true });

  return send(res, 404, { Message: "mock: ruta no manejada", url });
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`🧪 Facturama MOCK en http://127.0.0.1:${PORT} (scenario inicial: ${scenario})`);
});
