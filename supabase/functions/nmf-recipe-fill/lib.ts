// 나모푸드 레시피 자동 채움 — 순수 로직 (nmf_cloud.mjs 와 같은 암호화/병합 규칙)
// Deno/Edge Runtime 전용: Web Crypto + CompressionStream 사용

export const SLOT_COMP = ["밥", "국", "주찬", "부찬", "부찬", "김치", "후식"];

const b64e = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
type U8 = Uint8Array<ArrayBuffer>;
const u8 = (x: Uint8Array): U8 => new Uint8Array(x) as U8;
async function deriveKey(pw: string, salt: Uint8Array) {
  const km = await crypto.subtle.importKey("raw", u8(new TextEncoder().encode(pw)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: u8(salt), iterations: 150000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function gzip(u8_: Uint8Array, mode: "gzip" | "gunzip") {
  const s = mode === "gzip" ? new CompressionStream("gzip") : new DecompressionStream("gzip");
  const w = s.writable.getWriter(); w.write(u8(u8_)); w.close();
  return new Uint8Array(await new Response(s.readable).arrayBuffer());
}
export async function decryptText(pw: string, blob: string): Promise<string> {
  const o = JSON.parse(blob);
  const key = await deriveKey(pw, b64d(o.salt));
  let pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u8(b64d(o.iv)) }, key, u8(b64d(o.ct))));
  if (o.z) pt = await gzip(pt, "gunzip");
  return new TextDecoder().decode(pt);
}
export async function encryptText(pw: string, text: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pw, salt);
  const data = await gzip(new TextEncoder().encode(text), "gzip");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: u8(iv) }, key, u8(data)));
  return JSON.stringify({ v: 2, z: 1, iter: 150000, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) });
}

// deno-lint-ignore no-explicit-any
export type State = any;
export type Missing = { menu: string; comp: string; used: string[]; similar: string[] };

export function recipeNames(S: State): Set<string> { const s = new Set<string>(); for (const r of S.recipes || []) if (r.menu) s.add(r.menu); return s; }
function lev(a: string, b: string) { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
export function missingList(S: State): Missing[] {
  const have = recipeNames(S); const out: Record<string, Missing> = {};
  for (const [ym, m] of Object.entries(S.menus || {}) as [string, Record<string, string>][]) {
    for (const [k, v] of Object.entries(m)) {
      const [d, meal, ci] = k.split("|"); if (ci === "n" || !v || have.has(v)) continue;
      const o = out[v] || (out[v] = { menu: v, comp: SLOT_COMP[+ci] || "주찬", used: [], similar: [] });
      o.used.push(`${ym}-${String(d).padStart(2, "0")} ${meal}`);
    }
  }
  const names = [...have];
  for (const o of Object.values(out)) {
    const norm = o.menu.replace(/\s/g, "");
    o.similar = names.filter((n) => { const nn = n.replace(/\s/g, ""); return nn === norm || (Math.abs(nn.length - norm.length) <= 1 && lev(nn, norm) <= 1); });
  }
  return Object.values(out).sort((a, b) => a.menu.localeCompare(b.menu, "ko"));
}

export type Recipe = { menu: string; comp?: string; allergy?: string; source?: string; method?: string; items: { item: string; qty: number; unit?: string; storage?: string; loss?: number; form?: string }[] };
/** 레시피를 상태에 병합. 반환: 추가된 음식 이름 */
export function mergeRecipes(S: State, recipes: Recipe[], today: string): { added: string[]; skipped: string[] } {
  const have = recipeNames(S); const added: string[] = [], skipped: string[] = [];
  S.methods = S.methods || {}; S.sources = S.sources || {}; S.recipeMeta = S.recipeMeta || {};
  for (const R of recipes || []) {
    if (!R || !R.menu || !Array.isArray(R.items) || !R.items.length) { skipped.push(R?.menu || "?"); continue; }
    if (have.has(R.menu)) { skipped.push(R.menu + "(이미 있음)"); continue; }
    const items = R.items.filter((it) => it && String(it.item || "").trim() && +it.qty > 0 && String(it.item).trim() !== "물");
    if (!items.length) { skipped.push(R.menu + "(재료 없음)"); continue; }
    for (const it of items) S.recipes.push({ comp: R.comp || "주찬", menu: R.menu, item: String(it.item).trim(), qty: +it.qty, unit: ["g", "ml", "ea"].includes(it.unit || "") ? it.unit : "g", storage: it.storage || "냉장", loss: +(it.loss ?? 0.03) || 0.03, form: it.form || "원물", method: "", allergy: R.allergy || "" });
    if (R.method) S.methods[R.menu] = R.method; if (R.source) S.sources[R.menu] = R.source;
    S.recipeMeta[R.menu] = { by: "ai", updated: today }; have.add(R.menu); added.push(R.menu);
  }
  return { added, skipped };
}

/** LLM 응답에서 {"recipes":[...]} 를 최대한 관대하게 추출 */
export function parseRecipesJson(text: string): Recipe[] {
  const t = text.replace(/```(?:json)?/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("응답에 JSON 이 없습니다");
  const j = JSON.parse(t.slice(a, b + 1));
  const arr = Array.isArray(j) ? j : j.recipes;
  if (!Array.isArray(arr)) throw new Error("recipes 배열이 없습니다");
  return arr;
}

export function buildPrompt(list: Missing[]): string {
  return [
    "당신은 한국 공장 구내식당(단체급식) 영양사입니다. 아래 음식들의 1인 분량 레시피를 JSON 으로만 출력하세요. 설명 문장은 쓰지 마세요.",
    "출력 형식: {\"recipes\":[{\"menu\":\"<아래 이름과 글자 그대로 동일>\",\"comp\":\"<주어진 구성>\",\"allergy\":\"밀, 대두, …\",\"source\":\"일반 급식 레시피\",\"method\":\"1. … 2. … (중심온도 75℃ 등 위생 주의점 포함)\",\"items\":[{\"item\":\"재료명\",\"qty\":<1인 수량 숫자>,\"unit\":\"g|ml|ea\",\"storage\":\"냉장|냉동|상온\",\"loss\":0.03,\"form\":\"원물|손질|가공\"}]}]}",
    "규칙: 물은 재료에 넣지 않음. 재료 3~8개. 1인 분량은 급식 현실에 맞게(밥 쌀 100g, 국 육수 200ml·건더기 60~80g, 주찬 육류 70~120g, 부찬 채소 50~80g, 김치 50g, 후식 1ea 등). 단위는 g/ml/ea 만 사용. loss 는 0~0.2 사이 소수.",
    "음식 목록 (이름 | 구성):",
    ...list.map((m) => `- ${m.menu} | ${m.comp}`),
  ].join("\n");
}
