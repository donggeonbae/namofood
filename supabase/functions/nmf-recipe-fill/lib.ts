// 나모푸드 레시피 자동 채움 — 순수 로직 (nmf_cloud.mjs 와 같은 암호화/병합 규칙)
// Deno/Edge Runtime 전용: Web Crypto + CompressionStream 사용

// 0은 기본 쌀밥, 편집 필수칸은 1·2·7·3·4·8, 옛 5·6·9와 10 이상은 선택 추가메뉴다.
export const SLOT_COMP = [
  "밥",
  "국",
  "주찬",
  "부찬",
  "부찬",
  "김치",
  "부찬",
  "주찬",
  "부찬",
  "부찬",
];
export function slotComp(ci: string | number): string {
  const n = +ci;
  return SLOT_COMP[n] || (n >= SLOT_COMP.length ? "부찬" : "주찬");
}

const b64e = (u8: Uint8Array) => {
  let t = "";
  for (let i = 0; i < u8.length; i += 8192) {
    t += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 8192)));
  }
  return btoa(t);
};
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
type U8 = Uint8Array<ArrayBuffer>;
const u8 = (x: Uint8Array): U8 => new Uint8Array(x) as U8;
async function deriveKey(pw: string, salt: Uint8Array) {
  const km = await crypto.subtle.importKey(
    "raw",
    u8(new TextEncoder().encode(pw)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: u8(salt), iterations: 150000, hash: "SHA-256" },
    km,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function gzip(u8_: Uint8Array, mode: "gzip" | "gunzip") {
  const s = mode === "gzip"
    ? new CompressionStream("gzip")
    : new DecompressionStream("gzip");
  const w = s.writable.getWriter();
  w.write(u8(u8_));
  w.close();
  return new Uint8Array(await new Response(s.readable).arrayBuffer());
}
export async function decryptText(pw: string, blob: string): Promise<string> {
  const o = JSON.parse(blob);
  const key = await deriveKey(pw, b64d(o.salt));
  let pt = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: u8(b64d(o.iv)) },
      key,
      u8(b64d(o.ct)),
    ),
  );
  if (o.z) pt = await gzip(pt, "gunzip");
  return new TextDecoder().decode(pt);
}
export async function encryptText(pw: string, text: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pw, salt);
  const data = await gzip(new TextEncoder().encode(text), "gzip");
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: u8(iv) }, key, u8(data)),
  );
  return JSON.stringify({
    v: 2,
    z: 1,
    iter: 150000,
    salt: b64e(salt),
    iv: b64e(iv),
    ct: b64e(ct),
  });
}

// deno-lint-ignore no-explicit-any
export type State = any;
export type Missing = {
  menu: string;
  comp: string;
  used: string[];
  similar: string[];
  cells: { ym: string; key: string }[];
};

export function shouldErrorBackoff(
  latest: { status?: string; started_at?: string } | undefined,
  nowMs: number,
  backoffMinutes: number,
): boolean {
  if (
    latest?.status !== "error" || !latest.started_at || backoffMinutes <= 0
  ) return false;
  const startedMs = Date.parse(latest.started_at);
  return Number.isFinite(startedMs) &&
    nowMs - startedMs < backoffMinutes * 60_000;
}

/** 재료가 하나라도 적힌 레시피의 음식 이름 (레시피 탭에서 이름만 만든 빈 레시피는 제외 → 자동 채움 대상) */
export function recipeNames(S: State): Set<string> {
  const s = new Set<string>();
  for (const r of S.recipes || []) {
    if (r.menu && String(r.item || "").trim()) s.add(r.menu);
  }
  return s;
}
function emptyRecipes(S: State): Record<string, string> {
  const have = recipeNames(S);
  const out: Record<string, string> = {};
  for (const r of S.recipes || []) {
    if (r.menu && !have.has(r.menu)) out[r.menu] = r.comp || "주찬";
  }
  return out;
}
function lev(a: string, b: string) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[m][n];
}
export function missingList(S: State): Missing[] {
  const have = recipeNames(S);
  const out: Record<string, Missing> = {};
  for (
    const [ym, m] of Object.entries(S.menus || {}) as [
      string,
      Record<string, string>,
    ][]
  ) {
    for (const [k, v] of Object.entries(m)) {
      const [d, meal, ci] = k.split("|");
      if (ci === "n" || !v || have.has(v)) continue;
      const o = out[v] ||
        (out[v] = {
          menu: v,
          comp: slotComp(ci),
          used: [],
          similar: [],
          cells: [],
        });
      o.used.push(`${ym}-${String(d).padStart(2, "0")} ${meal}`);
      o.cells.push({ ym, key: k });
    }
  }
  for (const [menu, comp] of Object.entries(emptyRecipes(S))) {
    const o = out[menu] ||
      (out[menu] = { menu, comp, used: [], similar: [], cells: [] });
    o.used.push("레시피 탭(재료 없음)");
  }
  const names = [...have];
  for (const o of Object.values(out)) {
    const norm = o.menu.replace(/\s/g, "");
    o.similar = names.filter((n) => {
      const nn = n.replace(/\s/g, "");
      if (nn === norm) return true;
      return nn.length >= 3 && norm.length >= 3 &&
        Math.abs(nn.length - norm.length) <= 1 && lev(nn, norm) <= 1;
    });
  }
  return Object.values(out).sort((a, b) => a.menu.localeCompare(b.menu, "ko"));
}

export type Recipe = {
  menu: string;
  comp?: string;
  allergy?: string;
  source?: string;
  method?: string;
  ask?: { question?: string; rename?: string[] } | null;
  items: {
    item: string;
    qty: number;
    unit?: string;
    storage?: string;
    loss?: number;
    form?: string;
  }[];
};
/** 레시피를 상태에 병합. 반환: 추가된 음식 이름 */
export function mergeRecipes(
  S: State,
  recipes: Recipe[],
  today: string,
  refs: Record<string, Ref | null> = {},
): { added: string[]; skipped: string[] } {
  const have = recipeNames(S);
  const added: string[] = [], skipped: string[] = [];
  S.methods = S.methods || {};
  S.sources = S.sources || {};
  S.recipeMeta = S.recipeMeta || {};
  S.recipeAsk = S.recipeAsk || {};
  for (const R of recipes || []) {
    if (!R || !R.menu || !Array.isArray(R.items) || !R.items.length) {
      skipped.push(R?.menu || "?");
      continue;
    }
    if (have.has(R.menu)) {
      skipped.push(R.menu + "(이미 있음)");
      continue;
    }
    const items = R.items.filter((it) =>
      it && String(it.item || "").trim() && +it.qty > 0 &&
      String(it.item).trim() !== "물"
    );
    if (!items.length) {
      skipped.push(R.menu + "(재료 없음)");
      continue;
    }
    S.recipes = S.recipes.filter((r: { menu: string; item?: string }) =>
      !(r.menu === R.menu && !String(r.item || "").trim())
    ); // 빈 줄 제거 후 채움
    for (const it of items) {
      S.recipes.push({
        comp: R.comp || "주찬",
        menu: R.menu,
        item: String(it.item).trim(),
        qty: +it.qty,
        unit: ["g", "ml", "ea"].includes(it.unit || "") ? it.unit : "g",
        storage: it.storage || "냉장",
        loss: +(it.loss ?? 0.03) || 0.03,
        form: it.form || "원물",
        method: "",
        allergy: R.allergy || "",
      });
    }
    if (R.method) S.methods[R.menu] = normalizeMethod(R.method);
    if (R.source) S.sources[R.menu] = R.source;
    S.recipeMeta[R.menu] = { by: "ai", updated: today };
    have.add(R.menu);
    added.push(R.menu);
    delete S.recipeAsk[R.menu];
    // 확인 필요 안내: 이름이 애매하면 LLM 의 질문·이름 후보, 만개의레시피에 없으면 일반 레시피로 썼다는 안내
    const renames = (R.ask?.rename || []).filter((n) => n && n !== R.menu)
      .slice(0, 3);
    if (R.ask?.question || renames.length) {
      S.recipeAsk[R.menu] = {
        ask: R.ask?.question || `'${R.menu}' 이름이 정확한지 확인해 주세요.`,
        date: today,
        options: renames.map((n) => ({
          label: `'${n}'(으)로 이름 바꾸기`,
          kind: "rename",
          to: n,
        })),
      };
    } else if (R.menu in refs && !refs[R.menu]) {
      S.recipeAsk[R.menu] = {
        ask:
          "만개의레시피에서 같은 이름을 찾지 못해 일반적인 급식 레시피로 작성했습니다. 재료·분량을 확인해 주세요.",
        date: today,
        options: [],
      };
    }
  }
  return { added, skipped };
}

/** 이미 있는 레시피와 이름이 비슷한 음식: 레시피를 새로 만들지 않고 식단표 이름을 바꾸라는 확인 안내를 남긴다 */
export function askSimilar(S: State, list: Missing[], today: string): string[] {
  S.recipeAsk = S.recipeAsk || {};
  const out: string[] = [];
  for (const m of list) {
    if (!m.similar.length || S.recipeAsk[m.menu]) continue;
    S.recipeAsk[m.menu] = {
      ask: `'${m.menu}'은(는) 이미 있는 '${
        m.similar.join("', '")
      }'과 이름이 비슷합니다. 같은 음식이면 식단표 이름을 바꿔 주세요. 다른 음식이면 레시피를 직접 넣어 주세요.`,
      date: today,
      options: m.similar.map((to) => ({
        label: `식단표를 '${to}'(으)로 바꾸기`,
        kind: "menu",
        to,
        cells: m.cells,
      })),
    };
    if (!(S.recipes || []).some((r: { menu: string }) => r.menu === m.menu)) {
      S.recipes.push({
        comp: m.comp,
        menu: m.menu,
        item: "",
        qty: 100,
        unit: "g",
        storage: "냉장",
        loss: 0.03,
        form: "원물",
        method: "",
        allergy: "",
      }); // 앱에서 안내가 보이도록 빈 레시피 한 줄
    }
    out.push(m.menu);
  }
  return out;
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

export type GenerateRecipesOptions = {
  prompt: string;
  targetMenus: string[];
  apiKey: string;
  baseUrl: string;
  primaryModel: string;
  fallbackModel: string;
  timeoutMs: number;
  maxTokens: number;
  fetchImpl?: typeof fetch;
  sessionId?: () => string;
};
export type GenerateRecipesResult = {
  recipes: Recipe[];
  model: string;
  fallback: boolean;
  attempts: { model: string; protocol: OpenCodeProtocol; error?: string }[];
};

export type OpenCodeProtocol = "chat-completions" | "messages";

/** OpenCode Go 모델 표의 endpoint 구분을 따른다. */
export function openCodeProtocol(model: string): OpenCodeProtocol {
  const id = model.trim().toLowerCase().replace(/^opencode-go\//, "");
  return /^(minimax-m|qwen3\.)/.test(id) ? "messages" : "chat-completions";
}

function responseText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const value = part as { text?: unknown };
    return typeof value.text === "string" ? value.text : "";
  }).join("");
}

function parseOpenCodeResponse(
  protocol: OpenCodeProtocol,
  payload: unknown,
): string {
  const value = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  let finish: unknown;
  let content: unknown;
  if (protocol === "messages") {
    finish = value.stop_reason;
    if (
      finish !== undefined && finish !== null && finish !== "end_turn" &&
      finish !== "stop_sequence"
    ) {
      throw new Error(`LLM finish_reason=${String(finish)}`);
    }
    content = value.content;
  } else {
    const choices = Array.isArray(value.choices) ? value.choices : [];
    const choice = choices[0] && typeof choices[0] === "object"
      ? choices[0] as Record<string, unknown>
      : {};
    finish = choice.finish_reason;
    if (finish !== undefined && finish !== null && finish !== "stop") {
      throw new Error(`LLM finish_reason=${String(finish)}`);
    }
    const message = choice.message && typeof choice.message === "object"
      ? choice.message as Record<string, unknown>
      : {};
    content = message.content;
  }
  const text = responseText(content).trim();
  if (!text) throw new Error("LLM 응답이 비어 있습니다");
  return text;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function validateRecipesForTargets(recipes: Recipe[], targetMenus: string[]) {
  const targets = new Set(targetMenus);
  const out = recipes.filter((R) => targets.has(R.menu));
  const got = new Set(out.map((R) => R.menu));
  const missing = [...targets].filter((menu) => !got.has(menu));
  if (missing.length) throw new Error(`응답 누락: ${missing.join(", ")}`);
  const empty = out.filter((R) => !Array.isArray(R.items) || !R.items.length)
    .map((R) => R.menu);
  if (empty.length) throw new Error(`재료 누락: ${empty.join(", ")}`);
  const invalid = out.map(validateRecipeIdentity).filter(Boolean);
  if (invalid.length) throw new Error(`내용 불일치: ${invalid.join(", ")}`);
  return out;
}
function recipeText(R: Recipe) {
  return [
    R.menu,
    R.method || "",
    R.source || "",
    ...(R.items || []).map((it) => it.item || ""),
  ].join(" ");
}
function validateRecipeIdentity(R: Recipe): string {
  const t = recipeText(R).replace(/\s/g, "");
  if (R.menu === "육전") {
    const hasBeef = /(소고기|쇠고기|우육|홍두깨|설도|부채살|전각)/.test(t);
    const hasEgg = /(계란|달걀|난액)/.test(t);
    const hasCoating = /(밀가루|부침가루|튀김가루|전분)/.test(t);
    const hasPanCook = /(굽|부치|전판|팬|기름)/.test(t);
    if (!hasBeef || !hasEgg || !hasCoating || !hasPanCook) {
      return "육전(소고기·계란·가루옷·부침 조리 확인 실패)";
    }
  }
  return "";
}
async function callRecipeModel(
  o: GenerateRecipesOptions,
  model: string,
  protocol: OpenCodeProtocol,
): Promise<string> {
  const fetchImpl = o.fetchImpl || fetch;
  const path = protocol === "messages" ? "messages" : "chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${o.apiKey}`,
    "x-opencode-session": o.sessionId?.() || crypto.randomUUID(),
  };
  if (protocol === "messages") {
    headers["x-api-key"] = o.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  let r: Response;
  try {
    r = await fetchImpl(`${o.baseUrl.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(o.timeoutMs),
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: o.maxTokens,
        messages: [{ role: "user", content: o.prompt }],
      }),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`LLM ${o.timeoutMs}ms timeout`);
    }
    throw e;
  }
  if (!r.ok) {
    throw new Error(`LLM ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  return parseOpenCodeResponse(protocol, await r.json());
}
export async function generateRecipesWithFallback(
  o: GenerateRecipesOptions,
): Promise<GenerateRecipesResult> {
  if (!o.targetMenus.length) {
    return { recipes: [], model: "", fallback: false, attempts: [] };
  }
  const models = [o.primaryModel, o.fallbackModel].filter((m, i, a) =>
    m && a.indexOf(m) === i
  );
  const attempts: {
    model: string;
    protocol: OpenCodeProtocol;
    error?: string;
  }[] = [];
  for (const model of models) {
    const protocol = openCodeProtocol(model);
    try {
      const text = await callRecipeModel(o, model, protocol);
      const recipes = validateRecipesForTargets(
        parseRecipesJson(text),
        o.targetMenus,
      );
      attempts.push({ model, protocol });
      return {
        recipes,
        model,
        fallback: model !== o.primaryModel,
        attempts,
      };
    } catch (e) {
      attempts.push({ model, protocol, error: errMsg(e) });
    }
  }
  throw new Error(
    "LLM 생성 실패: " +
      attempts.map((a) => `${a.model}: ${a.error || "ok"}`).join(" | "),
  );
}

export type Ref = {
  url: string;
  title: string;
  ingredients: string;
  steps: string[];
};
const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
};
const strip = (h: string) =>
  h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(
    /&nbsp;/g,
    " ",
  ).replace(/\s+/g, " ").trim();
/** 만개의레시피에서 첫 검색 결과를 참고자료로 가져온다 (없거나 차단되면 null) */
export async function fetchReference(menu: string): Promise<Ref | null> {
  try {
    const q = menu.replace(/\(.*?\)/g, " ").trim();
    const r = await fetch(
      "https://www.10000recipe.com/recipe/list.html?q=" + encodeURIComponent(q),
      { headers: UA, signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return null;
    const id = (await r.text()).match(/\/recipe\/(\d{6,8})/)?.[1];
    if (!id) return null;
    const url = "https://www.10000recipe.com/recipe/" + id;
    const p = await fetch(url, {
      headers: UA,
      signal: AbortSignal.timeout(8000),
    });
    if (!p.ok) return { url, title: "", ingredients: "", steps: [] };
    const t = await p.text();
    const title = strip(t.match(/<title>([^<]*)/)?.[1] || "").replace(
      /-.*$/,
      "",
    ).trim();
    const ingredients = strip(
      t.match(/<div class="ready_ingre3"[\s\S]*?<div class="view_step/)?.[0] ||
        "",
    ).replace(/구매/g, "").slice(0, 700);
    const steps = [
      ...t.matchAll(
        /id="stepdescr\d+"[\s\S]*?<div class="media-body">([\s\S]*?)<\/div>/g,
      ),
    ].map((m) => strip(m[1])).filter(Boolean).slice(0, 12);
    return { url, title, ingredients, steps };
  } catch {
    return null;
  }
}

const EXAMPLE =
  `{"recipes":[{"menu":"오징어무침","comp":"부찬","allergy":"오징어, 밀, 대두","source":"https://www.10000recipe.com/recipe/7021555",
"method":"1. 오징어는 몸통과 다리를 손질해 내장과 눈, 입을 제거하고 껍질을 벗긴다.\n2. 몸통 안쪽에 어슷하게 칼집을 넣고 먹기 좋은 크기로 썬다.\n3. 끓는 물에 식초와 소금을 넣고 오징어를 15~20초만 짧게 데친다(오래 데치면 질겨진다).\n4. 중심온도 75℃ 1분 이상을 확인한 뒤 건져 찬물에 헹궈 급속으로 식히고 물기를 뺀다.\n5. 오이, 당근, 양파는 전용 도마와 칼로 채 썰어 준비한다.\n6. 고추장, 고춧가루, 식초, 설탕, 물엿, 다진마늘로 양념장을 만든다.\n7. 배식 직전 오징어와 채소를 양념장에 버무리고 참기름, 통깨로 마무리한다(미리 버무리면 물이 생긴다).\n8. 완성 후 10℃ 이하로 냉장 보관한다.",
"items":[{"item":"오징어","qty":100,"unit":"g","storage":"냉장","loss":0.1,"form":"전처리"},{"item":"오이","qty":20,"unit":"g","storage":"냉장","loss":0.05,"form":"전처리"},{"item":"고추장","qty":10,"unit":"g","storage":"실온","loss":0.03,"form":"원물"},{"item":"식초","qty":8,"unit":"ml","storage":"실온","loss":0.03,"form":"원물"}]}]}`;

export function buildPrompt(
  list: Missing[],
  refs: Record<string, Ref | null> = {},
): string {
  const refText = (m: Missing) => {
    const r = refs[m.menu];
    if (!r) {
      return `- ${m.menu} | 구성: ${m.comp} | 참고자료 없음 → source 는 "일반 급식 레시피"`;
    }
    return `- ${m.menu} | 구성: ${m.comp} | source: ${r.url}\n  참고 제목: ${r.title}\n  참고 재료: ${
      r.ingredients.slice(0, 500)
    }\n  참고 조리: ${r.steps.join(" / ").slice(0, 900)}`;
  };
  return [
    "당신은 한국 공장 구내식당(단체급식) 영양사입니다. 아래 음식들의 1인 분량 레시피를 JSON 으로만 출력하세요. 설명 문장·마크다운은 쓰지 마세요.",
    "출력 형식과 문체는 아래 예시와 똑같이 맞추세요:",
    EXAMPLE,
    "규칙:",
    "- menu 는 주어진 이름과 글자 그대로 동일. comp 는 기본적으로 주어진 구성을 쓰되, 메뉴와 명백히 맞지 않으면 실제 조리 역할로 바로잡으세요(예: 육전이 밥으로 들어오면 comp 는 주찬).",
    "- method 는 6~9단계, 각 단계는 '숫자. ' 로 시작하고 단계 사이는 반드시 줄바꿈(\n)으로 구분. 손질→조리→위생 확인(중심온도 75℃ 1분, 튀김 170℃ 등)→보관·배식(60℃ 이상 보온 또는 10℃ 이하 냉장) 순서. 주의점은 괄호로 덧붙임.",
    "- items 는 물 제외 5~13개, 양념까지 모두 포함. 1인 분량은 급식 기준(밥 쌀 100g, 국 건더기 60~80g, 주찬 육류·어류 70~120g, 부찬 채소 50~80g, 김치 50g). unit 은 g/ml/ea 만. storage 는 냉장/냉동/실온. form 은 원물/전처리/가공. loss 는 육류·어류 0.1, 채소 0.05, 양념 0.03.",
    '- allergy 는 식약처 표시 대상 알레르기 유발물질을 쉼표로 (없으면 "").',
    '- 이름이 오타·상표·구호처럼 보이거나 어떤 음식인지 확신이 없으면(예: \'엄마파이팅\'), 가장 그럴듯한 레시피를 쓰되 "ask":{"question":"…인지 확인해 주세요","rename":["올바른 이름 후보1","후보2"]} 를 그 레시피에 덧붙임. 확실하면 ask 생략.',
    "- source 는 참고자료 URL 을 그대로. 참고자료가 있으면 그 재료·조리 순서를 바탕으로 하되 가정용 분량을 1인 급식 분량으로 환산하고, 참고자료가 없으면 일반적인 급식 레시피로 작성.",
    "음식 목록:",
    ...list.map(refText),
  ].join("\n");
}

/** 줄바꿈 없이 '1. … 2. …' 로 이어진 조리법을 단계별 줄바꿈으로 */
export function normalizeMethod(m: string): string {
  const t = String(m || "").trim();
  if (!t || t.includes("\n")) return t;
  return t.replace(/\s+(?=\d{1,2}\.\s)/g, "\n");
}
