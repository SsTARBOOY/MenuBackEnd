// verify-token-algo.mjs — Verifica el algoritmo del token (espejo EXACTO de la función SQL
// gen_factura_token) sin necesidad de MariaDB. Prueba: alfabeto, longitud, ausencia de sesgo
// de módulo (rejection sampling) y tasa de colisión acorde a ~40 bits.
// Correr:  node verify-token-algo.mjs
import crypto from "node:crypto";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 símbolos, sin 0 O 1 I L
const N = ALPHABET.length;                          // 31
const REJECT_AT = Math.floor(256 / N) * N;          // 248 = 8*31  → bytes 248..255 se descartan

// Espejo de la función SQL: por cada char, un byte cripto; rejection sampling para no sesgar.
function genToken(len = 8) {
  let out = "";
  while (out.length < len) {
    const b = crypto.randomBytes(1)[0]; // 0..255
    if (b < REJECT_AT) out += ALPHABET[b % N];
  }
  return out;
}

let fail = 0;
const eq = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };

console.log(`Alfabeto: "${ALPHABET}"  (N=${N})  ·  umbral de rechazo: b<${REJECT_AT}\n`);

// 1) Alfabeto y longitud sobre una muestra grande
const SAMPLE = 500000;
const valid = new Set(ALPHABET);
const freq = new Map([...ALPHABET].map(c => [c, 0]));
const seen = new Set();
let dupes = 0, badChar = 0, badLen = 0;
for (let i = 0; i < SAMPLE; i++) {
  const t = genToken(8);
  if (t.length !== 8) badLen++;
  for (const c of t) { if (!valid.has(c)) badChar++; else freq.set(c, freq.get(c) + 1); }
  if (seen.has(t)) dupes++; else seen.add(t);
}
eq(badLen === 0,  `Todos los tokens miden 8 (violaciones: ${badLen})`);
eq(badChar === 0, `Todos los caracteres están en el alfabeto (violaciones: ${badChar})`);
eq(dupes === 0,   `Sin colisiones en ${SAMPLE.toLocaleString()} tokens de 8 (colisiones: ${dupes})`);

// 2) Uniformidad: chi-cuadrado sobre la distribución de símbolos (sin sesgo de módulo)
const totalChars = SAMPLE * 8;
const expected = totalChars / N;
let chi2 = 0;
let min = Infinity, max = -Infinity;
for (const c of ALPHABET) {
  const o = freq.get(c);
  chi2 += (o - expected) ** 2 / expected;
  min = Math.min(min, o); max = Math.max(max, o);
}
// 30 g.l., valor crítico α=0.001 ≈ 59.70. Un generador uniforme debe quedar MUY por debajo.
eq(chi2 < 59.70, `Chi² = ${chi2.toFixed(2)} (30 g.l., crítico α=0.001 ≈ 59.70) → distribución uniforme`);
console.log(`        esperado/símbolo=${expected.toFixed(0)}  min=${min}  max=${max}  desvío máx=${(100*Math.max(max-expected,expected-min)/expected).toFixed(2)}%`);

// 3) Demostración de que el rejection sampling IMPORTA: sin él (byte%31 directo) los primeros
//    8 símbolos saldrían sesgados (256%31=8 → 0..7 aparecen una vez más por cada 256 bytes).
function genBiased(len = 8) {
  let out = "";
  while (out.length < len) out += ALPHABET[crypto.randomBytes(1)[0] % N];
  return out;
}
const fb = new Map([...ALPHABET].map(c => [c, 0]));
for (let i = 0; i < SAMPLE; i++) for (const c of genBiased(8)) fb.set(c, fb.get(c) + 1);
let chi2b = 0;
for (const c of ALPHABET) chi2b += (fb.get(c) - expected) ** 2 / expected;
eq(chi2b > chi2, `Sin rejection sampling el Chi² empeora (${chi2b.toFixed(2)} > ${chi2.toFixed(2)}) → el rejection sampling SÍ corrige el sesgo`);

// 4) Tasa de colisión empírica en un espacio reducido (tokens de 3 → 31³=29 791) para
//    confirmar el comportamiento de cumpleaños esperado; valida que no haya colapso de entropía.
const space3 = N ** 3;
const draws = 2000;
let col = 0; const s3 = new Set();
for (let i = 0; i < draws; i++) { const t = genToken(3); if (s3.has(t)) col++; else s3.add(t); }
const expectedCol = draws - space3 * (1 - Math.pow((space3 - 1) / space3, draws)); // aprox
eq(Math.abs(col - expectedCol) < 40, `Colisiones en espacio 31³ (${draws} draws): observadas=${col}, esperadas≈${expectedCol.toFixed(1)} → entropía sana`);

console.log(`\n${fail === 0 ? "TODAS LAS PRUEBAS DEL ALGORITMO PASARON ✓" : `HUBO ${fail} FALLO(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);
