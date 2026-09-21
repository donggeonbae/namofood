// 나모푸드: 식단표에 있지만 레시피가 없는 음식을 OpenCode Zen(LLM)으로 조사해 상태에 병합
// 호출: pg_cron → net.http_post (Authorization: Bearer NMF_CRON_SECRET) 또는 수동 POST
//   body: {"dry":true} → LLM 호출 없이 빠진 음식 목록만 반환 · {"force":true} → 최근 저장 대기(10분) 무시
// 비밀(supabase secrets set): NMF_PW(앱 비밀번호), NMF_CRON_SECRET, OPENCODE_API_KEY, [OPENCODE_MODEL]
import { buildPrompt, decryptText, encryptText, mergeRecipes, missingList, parseRecipesJson, recipeNames } from "./lib.ts";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const TABLE = env("NMF_TABLE", "namofood_state"), ROOM = env("NMF_ROOM", "namofood");
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json; charset=utf-8" } });

function rest(path: string) { return `${env("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/${path}`; }
function svc(extra: Record<string, string> = {}) { const k = env("SUPABASE_SERVICE_ROLE_KEY"); return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json", ...extra }; }
async function logRun(row: Record<string, unknown>) { try { await fetch(rest("namofood_recipe_runs"), { method: "POST", headers: svc({ Prefer: "return=minimal" }), body: JSON.stringify(row) }); } catch (_) { /* 로그 실패는 무시 */ } }

async function callLLM(prompt: string): Promise<string> {
  const key = env("OPENCODE_API_KEY") || env("OPENCODE_GO_API_KEY"); if (!key) throw new Error("OPENCODE_API_KEY 가 없습니다");
  const model = env("OPENCODE_MODEL", "deepseek-v4-pro"); const base = env("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1");
  const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: "user", content: prompt }] }) });
  if (!r.ok) throw new Error(`LLM ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json(); const c = j?.choices?.[0]?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text || "").join("") : "";
  if (!text) throw new Error("LLM 응답이 비어 있습니다"); return text;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);
  const secret = env("NMF_CRON_SECRET"); const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || tok !== secret) return json({ ok: false, reason: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({})) as { dry?: boolean; force?: boolean; max?: number };
  const started = new Date().toISOString(); const today = started.slice(0, 10);
  const run: Record<string, unknown> = { started_at: started, trigger_source: req.headers.get("x-source") || "http", status: "running" };
  try {
    const pw = env("NMF_PW"); if (!pw) throw new Error("NMF_PW 가 없습니다");
    const r = await fetch(rest(`${TABLE}?id=eq.${encodeURIComponent(ROOM)}&select=data,updated_at`), { headers: svc() });
    if (!r.ok) throw new Error(`상태 불러오기 ${r.status}`); const rows = await r.json(); if (!rows[0]) throw new Error("저장된 데이터가 없습니다");
    const S = JSON.parse(await decryptText(pw, rows[0].data));
    const quietMin = +env("NMF_QUIET_MINUTES", "10"); const ageMs = Date.now() - new Date(rows[0].updated_at).getTime();
    if (!body.dry && !body.force && ageMs < quietMin * 60000) return json({ ok: true, skipped_reason: `마지막 저장 ${Math.round(ageMs / 60000)}분 전 — 입력 중일 수 있어 ${quietMin}분 뒤 다시 확인` });
    const all = missingList(S); const targets = all.filter((m) => !m.similar.length).slice(0, Math.max(1, Math.min(20, +(body.max || env("NMF_MAX_PER_RUN", "10")))));
    if (body.dry) return json({ ok: true, dry: true, recipes: recipeNames(S).size, missing: all, targets: targets.map((t) => t.menu) });
    if (!targets.length) { await logRun({ ...run, status: "done", finished_at: new Date().toISOString(), added: [], note: `추가할 음식 없음 (유사이름 ${all.length}개)` }); return json({ ok: true, added: [], skipped: all.map((m) => m.menu) }); }
    const text = await callLLM(buildPrompt(targets));
    const recipes = parseRecipesJson(text).filter((R) => targets.some((t) => t.menu === R.menu));
    const { added, skipped } = mergeRecipes(S, recipes, today);
    if (added.length) {
      // 누가 90초 안에 저장했으면 이번 회차는 건너뜀 (덮어쓰기 방지)
      const r2 = await fetch(rest(`${TABLE}?id=eq.${encodeURIComponent(ROOM)}&select=updated_at`), { headers: svc() }); const [{ updated_at }] = await r2.json();
      if (updated_at !== rows[0].updated_at) throw new Error("작업 중 다른 기기가 저장해 이번 회차를 건너뜁니다");
      S.updatedAt = new Date().toISOString(); const blob = await encryptText(pw, JSON.stringify(S)); const at = S.updatedAt;
      const up = await fetch(rest(`${TABLE}?on_conflict=id`), { method: "POST", headers: svc({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify([{ id: ROOM, data: blob, updated_at: at }, { id: `${ROOM}@${at.slice(0, 10)}`, data: blob, updated_at: at }]) });
      if (!up.ok) throw new Error(`저장 실패 ${up.status} ${(await up.text()).slice(0, 200)}`);
    }
    await logRun({ ...run, status: "done", finished_at: new Date().toISOString(), added, note: skipped.length ? `건너뜀: ${skipped.join(", ")}` : "" });
    return json({ ok: true, added, skipped, targets: targets.map((t) => t.menu) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logRun({ ...run, status: "error", finished_at: new Date().toISOString(), error: msg });
    return json({ ok: false, error: msg }, 500);
  }
});
