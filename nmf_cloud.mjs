// 나모푸드 Supabase 데이터 도구 (Node 18+ 필요, 추가 설치 없음)
//   node nmf_cloud.mjs missing            → 식단표에 있지만 레시피가 없는 음식 목록(JSON) 출력
//   node nmf_cloud.mjs apply recipes.json → 레시피를 병합해 Supabase에 저장(현재 + 오늘 기록)
//   node nmf_cloud.mjs backup out.json    → 현재 데이터를 평문 JSON으로 저장
// 비밀번호: 환경변수 NMF_PW 또는 %USERPROFILE%\.namofood_pw 파일 (홈페이지 비밀번호와 같음)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import zlib from "node:zlib";
const { webcrypto: crypto } = await import("node:crypto");

const URL_ = "https://rycibsczsgbkgtwfxyim.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5Y2lic2N6c2dia2d0d2Z4eWltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MjkzMTAsImV4cCI6MjEwNDAwNTMxMH0.gfo03oiZT6FPMGQaa9pF5it2BY6oL1CoxWpd7-fk0OY";
const TABLE = "namofood_state", ROOM = "namofood";
const SLOT_COMP = ["밥", "국", "주찬", "부찬", "부찬", "김치", "후식"];

function getPw() {
  if (process.env.NMF_PW) return process.env.NMF_PW;
  const f = path.join(os.homedir(), ".namofood_pw");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  throw new Error("비밀번호가 없습니다. NMF_PW 환경변수 또는 ~/.namofood_pw 파일을 만들어 주세요.");
}
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
const api = URL_ + "/rest/v1/" + TABLE;
const b64e = (u8) => Buffer.from(u8).toString("base64");
const b64d = (s) => new Uint8Array(Buffer.from(s, "base64"));
async function deriveKey(pw, salt) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function decryptText(pw, blob) {
  const o = typeof blob === "string" ? JSON.parse(blob) : blob;
  const key = await deriveKey(pw, b64d(o.salt));
  let pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(o.iv) }, key, b64d(o.ct)));
  if (o.z) pt = zlib.gunzipSync(pt);
  return Buffer.from(pt).toString("utf8");
}
async function encryptText(pw, text) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pw, salt);
  const data = zlib.gzipSync(Buffer.from(text, "utf8"));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return JSON.stringify({ v: 2, z: 1, iter: 150000, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) });
}
async function fetchState(pw) {
  const r = await fetch(`${api}?id=eq.${ROOM}&select=data,updated_at`, { headers: H });
  if (!r.ok) throw new Error("불러오기 실패 " + r.status);
  const rows = await r.json(); if (!rows[0]) throw new Error("저장된 데이터가 없습니다");
  return { S: JSON.parse(await decryptText(pw, rows[0].data)), updated_at: rows[0].updated_at };
}
function recipeNames(S) { const s = new Set(); for (const r of S.recipes) if (r.menu) s.add(r.menu); return s; }
function lev(a, b) { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
function missingList(S) {
  const have = recipeNames(S); const out = {};
  for (const [ym, m] of Object.entries(S.menus || {})) for (const [k, v] of Object.entries(m)) {
    const [d, meal, ci] = k.split("|"); if (ci === "n" || !v || have.has(v)) continue;
    const o = out[v] || (out[v] = { menu: v, comp: SLOT_COMP[+ci] || "주찬", used: [] });
    o.used.push(`${ym}-${String(d).padStart(2, "0")} ${meal}`);
  }
  const names = [...have];
  for (const o of Object.values(out)) {
    const norm = o.menu.replace(/\s/g, "");
    o.similar = names.filter((n) => { const nn = n.replace(/\s/g, ""); return nn === norm || (Math.abs(nn.length - norm.length) <= 1 && lev(nn, norm) <= 1); });
  }
  return Object.values(out).sort((a, b) => a.menu.localeCompare(b.menu, "ko"));
}
async function main() {
  const [cmd, arg] = process.argv.slice(2); const pw = getPw();
  if (cmd === "missing") { const { S, updated_at } = await fetchState(pw); console.log(JSON.stringify({ updated_at, count: recipeNames(S).size, missing: missingList(S) }, null, 1)); return; }
  if (cmd === "backup") { const { S } = await fetchState(pw); fs.writeFileSync(arg || "namofood_backup.json", JSON.stringify(S), "utf8"); console.log("saved", arg); return; }
  if (cmd === "apply") {
    // 입력 형식: {"recipes":[{"menu":"돈가스","comp":"주찬","allergy":"밀, 대두, 난류, 돼지고기","source":"https://…",
    //   "method":"1. … 2. …","items":[{"item":"돼지고기 등심","qty":120,"unit":"g","storage":"냉장","loss":0.05,"form":"원물"}, …]}]}
    const inp = JSON.parse(fs.readFileSync(arg, "utf8")); const today = new Date().toISOString().slice(0, 10);
    const { S, updated_at } = await fetchState(pw);
    if (Date.now() - new Date(updated_at).getTime() < 90000) throw new Error("누군가 90초 안에 저장했습니다. 잠시 뒤 다시 시도하세요.");
    const have = recipeNames(S); const added = [], skipped = [];
    S.methods = S.methods || {}; S.sources = S.sources || {}; S.recipeMeta = S.recipeMeta || {};
    for (const R of inp.recipes || []) {
      if (!R.menu || !Array.isArray(R.items) || !R.items.length) { skipped.push(R.menu || "?"); continue; }
      if (have.has(R.menu)) { skipped.push(R.menu + "(이미 있음)"); continue; }
      for (const it of R.items) S.recipes.push({ comp: R.comp || "주찬", menu: R.menu, item: String(it.item || "").trim(), qty: +it.qty || 0, unit: it.unit || "g", storage: it.storage || "냉장", loss: +it.loss || 0.03, form: it.form || "원물", method: "", allergy: R.allergy || "" });
      if (R.method) S.methods[R.menu] = R.method; if (R.source) S.sources[R.menu] = R.source;
      S.recipeMeta[R.menu] = { by: "ai", updated: today }; have.add(R.menu); added.push(R.menu);
    }
    if (!added.length) { console.log(JSON.stringify({ added, skipped })); return; }
    S.updatedAt = new Date().toISOString(); const blob = await encryptText(pw, JSON.stringify(S)); const at = S.updatedAt;
    const r = await fetch(`${api}?on_conflict=id`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id: ROOM, data: blob, updated_at: at }, { id: `${ROOM}@${at.slice(0, 10)}`, data: blob, updated_at: at }]) });
    if (!r.ok) throw new Error("저장 실패 " + r.status + " " + (await r.text()).slice(0, 200));
    console.log(JSON.stringify({ added, skipped, saved_at: at })); return;
  }
  console.log("사용법: node nmf_cloud.mjs missing | apply <json> | backup <out.json>");
}
main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
