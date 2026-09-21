// 나모푸드: 식단표에 있지만 레시피가 없는 음식을 OpenCode Zen(LLM)으로 조사해 상태에 병합
// 호출: pg_cron → net.http_post (Authorization: Bearer NMF_CRON_SECRET) 또는 수동 POST
//   body: {"dry":true} → LLM 호출 없이 빠진 음식 목록만 반환 · {"force":true} → 최근 저장 대기(10분) 무시
// 비밀(supabase secrets set): NMF_PW(앱 비밀번호), NMF_CRON_SECRET, OPENCODE_API_KEY, [OPENCODE_MODEL]
import { askSimilar, buildPrompt, decryptText, encryptText, fetchReference, mergeRecipes, missingList, parseRecipesJson, recipeNames } from "./lib.ts";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const TABLE = env("NMF_TABLE", "namofood_state"), ROOM = env("NMF_ROOM", "namofood");
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json; charset=utf-8" } });

function rest(path: string) { return `${env("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/${path}`; }
function svc(extra: Record<string, string> = {}) { const k = env("SUPABASE_SERVICE_ROLE_KEY"); return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json", ...extra }; }
async function logRun(row: Record<string, unknown>) { try { await fetch(rest("namofood_recipe_runs"), { method: "POST", headers: svc({ Prefer: "return=minimal" }), body: JSON.stringify(row) }); } catch (_) { /* 로그 실패는 무시 */ } }

async function callLLM(prompt: string): Promise<string> {
  const key = env("OPENCODE_API_KEY") || env("OPENCODE_GO_API_KEY"); if (!key) throw new Error("OPENCODE_API_KEY 가 없습니다");
  const model = env("OPENCODE_MODEL", "deepseek-v4-pro"); const base = env("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1");
  const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "x-opencode-session": crypto.randomUUID() }, body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: "user", content: prompt }] }) });
  if (!r.ok) throw new Error(`LLM ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json(); const c = j?.choices?.[0]?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text || "").join("") : "";
  if (!text) throw new Error("LLM 응답이 비어 있습니다"); return text;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);
  const secret = env("NMF_CRON_SECRET"); const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || tok !== secret) return json({ ok: false, reason: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({})) as { dry?: boolean; force?: boolean; max?: number; llm?: boolean; menus?: string[] };
  const started = new Date().toISOString(); const today = started.slice(0, 10);
  const run: Record<string, unknown> = { started_at: started, trigger_source: req.headers.get("x-source") || "http", status: "running" };
  try {
    const pw = env("NMF_PW"); if (!pw) throw new Error("NMF_PW 가 없습니다");
    const r = await fetch(rest(`${TABLE}?id=eq.${encodeURIComponent(ROOM)}&select=data,updated_at`), { headers: svc() });
    if (!r.ok) throw new Error(`상태 불러오기 ${r.status}`); const rows = await r.json(); if (!rows[0]) throw new Error("저장된 데이터가 없습니다");
    const S = JSON.parse(await decryptText(pw, rows[0].data));
    const quietMin = +env("NMF_QUIET_MINUTES", "4"); const ageMs = Date.now() - new Date(rows[0].updated_at).getTime();
    if (!body.dry && !body.force && ageMs < quietMin * 60000) return json({ ok: true, skipped_reason: `마지막 저장 ${Math.round(ageMs / 60000)}분 전 — 입력 중일 수 있어 ${quietMin}분 뒤 다시 확인` });
    // 직전 실행이 오류였으면 1시간 동안 재시도하지 않음 (토큰 낭비 방지)
    if (!body.dry && !body.force) { const lr = await fetch(rest("namofood_recipe_runs?select=status,started_at&order=started_at.desc&limit=1"), { headers: svc() }).then((x) => x.json()).catch(() => []); if (lr[0]?.status === "error" && Date.now() - new Date(lr[0].started_at).getTime() < 3600000) return json({ ok: true, skipped_reason: "직전 실행 오류 — 1시간 뒤 재시도" }); }
    const all = missingList(S); const targets = all.filter((m) => !m.similar.length).slice(0, Math.max(1, Math.min(20, +(body.max || env("NMF_MAX_PER_RUN", "10")))));
    if (body.dry && !body.llm) return json({ ok: true, dry: true, recipes: recipeNames(S).size, missing: all, targets: targets.map((t) => t.menu) });
    if (body.dry && body.llm) {   // 형식 점검용: 지정 음식으로 LLM 까지 돌리고 저장은 안 함
      const list = (body.menus || targets.map((t) => t.menu)).map((menu) => ({ menu, comp: all.find((m) => m.menu === menu)?.comp || "주찬", used: [], similar: [], cells: [] }));
      const refs: Record<string, Awaited<ReturnType<typeof fetchReference>>> = {}; for (const m of list) refs[m.menu] = await fetchReference(m.menu);
      const text = await callLLM(buildPrompt(list, refs)); return json({ ok: true, dry: true, refs: Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, v?.url || null])), recipes: parseRecipesJson(text) });
    }
    const similar = all.filter((m) => m.similar.length && !(S.recipeAsk || {})[m.menu]);
    if (!targets.length && !similar.length) { await logRun({ ...run, status: "done", finished_at: new Date().toISOString(), added: [], note: "추가할 음식 없음" }); return json({ ok: true, added: [], skipped: [] }); }
    const refs: Record<string, Awaited<ReturnType<typeof fetchReference>>> = {}; for (const m of targets) refs[m.menu] = await fetchReference(m.menu);   // 만개의레시피 참고자료·출처
    const recipes = targets.length ? parseRecipesJson(await callLLM(buildPrompt(targets, refs))).filter((R) => targets.some((t) => t.menu === R.menu)) : [];
    // LLM 응답을 기다리는 동안 다른 기기가 저장했을 수 있으니, 최신 상태를 다시 받아 그 위에 병합 (덮어쓰기 방지)
    const r2 = await fetch(rest(`${TABLE}?id=eq.${encodeURIComponent(ROOM)}&select=data,updated_at`), { headers: svc() }); const [latest] = await r2.json();
    const S2 = latest.updated_at !== rows[0].updated_at ? JSON.parse(await decryptText(pw, latest.data)) : S;
    const { added, skipped } = mergeRecipes(S2, recipes, today, refs); const asked = askSimilar(S2, similar, today);
    if (added.length || asked.length) {
      S2.updatedAt = new Date().toISOString(); const blob = await encryptText(pw, JSON.stringify(S2)); const at = S2.updatedAt;
      const up = await fetch(rest(`${TABLE}?on_conflict=id`), { method: "POST", headers: svc({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify([{ id: ROOM, data: blob, updated_at: at }, { id: `${ROOM}@${at.slice(0, 10)}`, data: blob, updated_at: at }]) });
      if (!up.ok) throw new Error(`저장 실패 ${up.status} ${(await up.text()).slice(0, 200)}`);
    }
    await logRun({ ...run, status: "done", finished_at: new Date().toISOString(), added, note: [skipped.length ? `건너뜀: ${skipped.join(", ")}` : "", asked.length ? `유사이름 확인 요청: ${asked.join(", ")}` : ""].filter(Boolean).join(" · ") });
    return json({ ok: true, added, skipped, asked, targets: targets.map((t) => t.menu) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logRun({ ...run, status: "error", finished_at: new Date().toISOString(), error: msg });
    return json({ ok: false, error: msg }, 500);
  }
});
