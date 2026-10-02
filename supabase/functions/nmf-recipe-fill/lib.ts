// 나모푸드 레시피 자동 채움 — 순수 로직 (nmf_cloud.mjs 와 같은 암호화/병합 규칙)
// Deno/Edge Runtime 전용: Web Crypto + CompressionStream 사용
import {
  assertMealMenuAllowed,
  prohibitedMenuReason,
} from "../_shared/menu-eligibility.ts";

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
/** Signed requests authorize status/run without putting the cron secret in a client. */
export async function verifyAppRequest(
  pw: string,
  action: string,
  timestamp: string,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !pw || !["status", "run"].includes(action) || !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 60000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(
    signature.match(/../g)!,
    (v) => parseInt(v, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    enc.encode("nmf-recipe:" + action + ":" + timestamp),
  );
}
export type Missing = {
  menu: string;
  comp: string;
  used: string[];
  similar: string[];
  cells: { ym: string; key: string }[];
  /** Existing AI recipe: replace only the method if this baseline is still current. */
  methodUpgrade?: { fingerprint: string; recipe: Recipe };
};

export const INSTITUTIONAL_COOKING_PROFILE = "institutional-v1";
const HOUSEHOLD_METHOD =
  /(프라이팬|후라이팬|가정용\s*팬|한\s*줌|종이컵|큰술|작은술)/;
const BULK_EQUIPMENT =
  /(회전솥|대형\s*(솥|냄비|볼|믹싱볼)|틸팅\s*팬|전판|그리들|튀김기|스팀솥|오븐|스텐\s*밧드|배식\s*용기)/;
const BATCH_METHOD = /(배치|분할|나누어|나눠|회차|차례로|분산)/;
const normalizeTemperature = (s: string) =>
  s.replace(/(\d)\s*(?:℃|°\s*C|C|도\s*씨)/gi, "$1℃");
const HOT_HOLDING =
  /(?<![\d.])(?:60|6[1-9]|[7-9]\d|1\d\d)\s*℃\s*(?:이상|↑|초과)/;
const COLD_HOLDING =
  /(?<![\d.])(?:[0-4](?:\.\d+)?|5(?:\.0+)?)\s*℃\s*(?:이하|↓|미만)/;

/** Reheating does not make serving leftovers reusable; only explicitly unserved food may be stored. */
function unsafeLeftoverInstructions(step: string): boolean {
  // '배식대의 찬 음식' alone is active holding, not a leftover-food subject.
  const subjectPattern =
    /(잔반|잔식|잔여\s*(?:분|음식)|남은\s*(?:음식|요리|완성품)|(?:손님|고객)[^,。.!?]{0,20}제공(?:된|한)\s*음식|제공(?:된|한)\s*음식)/;
  const unservedPattern =
    /(미배식|배식(?:하지|되지)\s*않은|제공(?:하지|되지)\s*않은)/;
  const servedPattern = /(잔반|배식\s*(?:후|하고)|제공(?:된|한)\s*음식)/;
  const prohibition =
    /(?:(?:재사용|재배식|재가열|재조리|냉각|냉장(?:\s*보관)?|보관|다시\s*(?:사용|배식|제공))\s*(?:[을를은는])?\s*(?:[·,\/]|및|또는|와|과|하거나)?\s*){1,6}(?:(?:절대(?:로)?|일체|모두|원칙적으로)\s*)?(?:하지\s*않|하지\s*말|금지|불가|할\s*수\s*없|없이|해서는\s*안\s*(?:된다|됩니다|돼)|해선\s*안|안\s*한다)/g;
  let previousSubject: "none" | "leftover" | "unserved" = "none";
  for (const rawSentence of step.split(/[。.!?；;]/)) {
    const sentence = rawSentence.replace(prohibition, "");
    let subject: "none" | "leftover" | "unserved" =
      /^\s*(?:이를|이\s*음식|해당\s*음식|그것)/.test(sentence)
        ? previousSubject
        : "none";
    for (
      const clause of sentence.split(
        /[,，]|(?=(?:배식용기|용기|도구|집게)[은는])/,
      )
    ) {
      if (/^\s*(?:배식용기|용기|도구|집게)[은는]/.test(clause)) {
        subject = "none";
      }
      const marker = clause.match(subjectPattern);
      if (unservedPattern.test(clause) && !servedPattern.test(clause)) {
        subject = "unserved";
        continue;
      }
      if (marker) subject = "leftover";
      if (subject !== "leftover") continue;
      // Only scan this food's actions: safe 냉장 equipment before 잔여분 is irrelevant.
      const relevant = marker ? clause.slice(marker.index) : clause;
      if (
        /(재사용|재배식|재가열|재조리|냉각|냉장|보관|다시\s*(?:사용|배식|제공))/
          .test(relevant)
      ) {
        return true;
      }
    }
    previousSubject = subject;
  }
  return false;
}

/** Shape gate used before accepting AI output, including ready-made/no-cook dishes. */
export function validateInstitutionalMethod(method: string): string {
  const text = normalizeTemperature(normalizeMethod(method));
  const steps = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (
    steps.length < 6 || steps.length > 10 ||
    steps.some((s, i) => !s.startsWith(`${i + 1}. `))
  ) {
    return "조리법은 순서대로 번호를 붙인 6~10단계가 필요합니다";
  }
  if (HOUSEHOLD_METHOD.test(text)) return "가정용 팬·한 줌·숟가락 계량 조리법";
  if (!BULK_EQUIPMENT.test(text)) return "대량 조리/배식 장비 누락";
  if (!BATCH_METHOD.test(text)) return "장비 용량에 맞춘 배치·분할 작업 누락";
  if (!/배식/.test(text)) return "배식 직전 마무리·보관 순서 누락";
  if (steps.some(unsafeLeftoverInstructions)) {
    return "배식 후 남은 음식·잔반은 보관·재사용하지 않고 폐기해야 합니다";
  }
  if (
    steps.some((step) =>
      /오븐/.test(step) &&
      !/(보유|있으면|없으면|없는\s*경우|선택|대체)/.test(step)
    )
  ) {
    return "보유 여부가 미확인인 오븐을 필수 장비로 지정";
  }
  if (
    !steps.some((step) =>
      /(보온|냉장|보관|유지)/.test(step) &&
      (HOT_HOLDING.test(step) || COLD_HOLDING.test(step))
    )
  ) return "배식 전 뜨거운 음식 60℃ 이상/찬 음식 5℃ 이하 보관 기준 누락";
  if (
    steps.some((step) =>
      /(냉장|찬\s*음식|차가운\s*음식)/.test(step) &&
      /(?<![\d.])(?:[6-9]|[1-9]\d|1\d\d)(?:\.\d+)?\s*℃\s*(?:이하|로\s*(?:보관|유지|냉장))/
        .test(step)
    )
  ) return "찬 음식은 5℃ 이하로 보관해야 합니다";
  if (
    /실온[^\n]{0,25}(?:[2-9]|\d{2,})\s*시간[^\n]{0,15}(?:방치|보관|둔다|유지)/
      .test(text)
  ) {
    return "조리 후 장시간 실온 보관 지시";
  }
  return "";
}

function currentMethod(S: State, menu: string): string {
  return String(
    S.methods?.[menu] ??
      (S.recipes || []).find((r: { menu: string }) => r.menu === menu)
        ?.method ??
      "",
  );
}
function methodUpgradeFingerprint(S: State, menu: string): string {
  return JSON.stringify({
    rows: (S.recipes || []).filter((r: { menu: string }) => r.menu === menu),
    method: S.methods?.[menu] ?? null,
    meta: S.recipeMeta?.[menu] ?? null,
    source: S.sources?.[menu] ?? null,
    ask: S.recipeAsk?.[menu] ?? null,
  });
}

/** Manual recipes stay protected; even tagged AI methods are rechecked for current safety rules. */
export function needsInstitutionalUpgrade(S: State, menu: string): boolean {
  if (prohibitedMenuReason(menu)) return false;
  const meta = S.recipeMeta?.[menu];
  if (meta?.by !== "ai") return false;
  const method = currentMethod(S, menu);
  return Boolean(validateInstitutionalMethod(method));
}

/** Pending upgrades are independent of missing recipes and processed after them. */
export function institutionalUpgradeList(S: State): Missing[] {
  return [...recipeNames(S)].filter((menu) =>
    needsInstitutionalUpgrade(S, menu)
  )
    .map((menu) => {
      const rows = (S.recipes || []).filter((r: { menu: string }) =>
        r.menu === menu
      );
      return {
        menu,
        comp: rows[0]?.comp || "주찬",
        used: ["기존 AI 레시피 대량조리 전환"],
        similar: [],
        cells: [],
        methodUpgrade: {
          fingerprint: methodUpgradeFingerprint(S, menu),
          recipe: {
            menu,
            comp: rows[0]?.comp || "주찬",
            allergy: rows[0]?.allergy || "",
            source: S.sources?.[menu] || "",
            method: currentMethod(S, menu),
            items: rows.filter((r: { item?: string }) =>
              String(r.item || "").trim()
            )
              .map((r: Recipe["items"][number]) => ({
                item: r.item,
                qty: r.qty,
                unit: r.unit,
                storage: r.storage,
                loss: r.loss,
                form: r.form,
              })),
          },
        },
      };
    }).sort((a, b) => a.menu.localeCompare(b.menu, "ko"));
}

/** Missing dishes stay first; recently failed dishes yield to untried peers in each queue. */
export function selectRecipeTargets(
  missing: Missing[],
  upgrades: Missing[],
  max: number,
  recentRuns: {
    status?: string;
    targets?: unknown;
    note?: string;
    started_at?: string;
  }[] = [],
): Missing[] {
  const lastFailure = (menu: string) =>
    Math.max(
      0,
      ...recentRuns.filter((run) => {
        if (
          run.status === "error" && Array.isArray(run.targets) &&
          run.targets.includes(menu)
        ) {
          return true;
        }
        const failedPart =
          run.note?.match(/생성 실패\(다음 실행 재시도\):\s*([^·]*)/)?.[1] ||
          "";
        return failedPart.split(",").map((m) => m.trim()).includes(menu);
      }).map((run) => Date.parse(run.started_at || "") || 0),
    );
  const order = (list: Missing[]) =>
    [...list].sort((a, b) =>
      lastFailure(a.menu) - lastFailure(b.menu) ||
      a.menu.localeCompare(b.menu, "ko")
    );
  const selectedMissing = order(missing).slice(0, max);
  return [
    ...selectedMissing,
    ...order(upgrades).slice(
      0,
      Math.max(0, Math.min(2, max - selectedMissing.length)),
    ),
  ];
}

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
      if (ci === "n" || !v || have.has(v) || prohibitedMenuReason(v)) continue;
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
    if (prohibitedMenuReason(menu)) continue;
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
    const invalid = validateRecipeContent(R);
    if (invalid) {
      skipped.push(R.menu + "(" + invalid + ")");
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
    S.recipeMeta[R.menu] = {
      by: "ai",
      updated: today,
      cookingProfile: INSTITUTIONAL_COOKING_PROFILE,
    };
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

/** Only replace the method; concurrent/manual edits and all ingredient rows are protected. */
export function mergeInstitutionalMethods(
  S: State,
  recipes: Recipe[],
  targets: Missing[],
  today: string,
): { upgraded: string[]; skipped: string[] } {
  const upgraded: string[] = [], skipped: string[] = [];
  for (const target of targets) {
    if (!target.methodUpgrade) continue;
    const R = recipes.find((r) => r.menu === target.menu);
    if (!R) continue;
    if (
      !needsInstitutionalUpgrade(S, target.menu) ||
      methodUpgradeFingerprint(S, target.menu) !==
        target.methodUpgrade.fingerprint
    ) {
      skipped.push(target.menu + "(기존 레시피 변경됨)");
      continue;
    }
    // Identity is checked against the preserved ingredients, never invented replacements.
    const candidate = { ...target.methodUpgrade.recipe, method: R.method };
    const invalid = validateRecipeContent(candidate);
    if (invalid) {
      skipped.push(target.menu + "(" + invalid + ")");
      continue;
    }
    S.methods = S.methods || {};
    S.methods[target.menu] = normalizeMethod(R.method || "");
    S.recipeMeta[target.menu] = {
      ...S.recipeMeta[target.menu],
      updated: today,
      cookingProfile: INSTITUTIONAL_COOKING_PROFILE,
    };
    upgraded.push(target.menu);
  }
  return { upgraded, skipped };
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
  for (const R of arr) {
    if (R?.menu) assertMealMenuAllowed(String(R.menu));
  }
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
  if (out.length !== targets.size) throw new Error("동일 음식 응답 중복");
  const invalid = out.map((R) => {
    const reason = validateRecipeContent(R);
    return reason ? `${R.menu}(${reason})` : "";
  }).filter(Boolean);
  if (invalid.length) throw new Error(`내용 불일치: ${invalid.join(", ")}`);
  return out;
}
function validateRecipeContent(R: Recipe): string {
  const prohibited = prohibitedMenuReason(R.menu);
  if (prohibited) return prohibited;
  if (
    !Array.isArray(R.items) || !R.items.length ||
    !R.items.some((it) =>
      it && String(it.item || "").trim() && it.item !== "물"
    )
  ) {
    return "재료 누락";
  }
  if (
    R.items.some((it) =>
      !it || !String(it.item || "").trim() ||
      !Number.isFinite(Number(it.qty)) || Number(it.qty) <= 0 ||
      !["g", "ml", "ea"].includes(it.unit || "")
    )
  ) {
    return "재료 분량·단위 확인 실패(g/ml/ea만 허용)";
  }
  return validateRecipeIdentity(R) ||
    validateInstitutionalMethod(R.method || "") || validateFoodSafety(R);
}
function validateFoodSafety(R: Recipe): string {
  const raw = R.items.map((it) => String(it.item || ""))
    .filter((name) =>
      !/(익힌|가열완료|조리완료|통조림|캔참치|캔\s*참치|분말|액젓|새우젓|소스|조미김|건멸치|건새우|마른|말린|육수용)/
        .test(name)
    );
  const meat = raw.filter((name) =>
    /(소고기|쇠고기|돼지고기|닭고기|오리고기|우육|돈육|계육|홍두깨|목살|삼겹|안심|등심|부채살|설도|전각|생닭|돈까스|돈가스|치킨까스|치킨가스)/
      .test(name)
  );
  const seafood = raw.filter((name) =>
    /(오징어|낙지|쭈꾸미|주꾸미|문어|새우|꽃게|게살|대게|홍합|조개|바지락|굴|전복|가리비|생선|고등어|삼치|갈치|꽁치|명태|대구|연어|가자미|참치|해물|어패류)/
      .test(name)
  );
  if (!meat.length && !seafood.length) return "";
  const minimum = seafood.length ? 85 : 75;
  const steps = normalizeTemperature(normalizeMethod(R.method || "")).split(
    /\r?\n/,
  );
  const safe = steps.some((step) => {
    if (!/(중심\s*온도|온도계)/.test(step)) return false;
    const centers = [
      ...step.matchAll(/중심\s*온도[^\d\n]{0,12}(\d+(?:\.\d+)?)\s*℃/g),
    ];
    return centers.some((center) => {
      if (Number(center[1]) < minimum) return false;
      const end = (center.index || 0) + center[0].length;
      const after = step.slice(end, end + 45);
      return [...after.matchAll(/(\d+(?:\.\d+)?)\s*분/g)].some((m) =>
        Number(m[1]) >= 1
      ) ||
        [...after.matchAll(/(\d+(?:\.\d+)?)\s*초/g)].some((m) =>
          Number(m[1]) >= 60
        );
    });
  });
  return safe
    ? ""
    : `${
      seafood.length ? "어패류" : "육류"
    } 중심온도 ${minimum}℃ 1분 이상 확인 누락 (판정 재료: ${
      JSON.stringify(
        [...new Set(seafood.length ? seafood : meat)].slice(0, 4).map((name) =>
          name.slice(0, 100)
        ),
      )
    })`;
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
    const ingredients = (R.items || []).map((it) => it.item).join(" ");
    const hasBeef = /(소고기|쇠고기|우육|홍두깨|설도|부채살|전각)/.test(
      ingredients,
    );
    const hasEgg = /(계란|달걀|난액)/.test(ingredients);
    const hasCoating = /(밀가루|부침가루|튀김가루|전분)/.test(ingredients);
    const hasPanCook = /(전판|그리들)/.test(R.method || "") &&
      /(굽|구워|부치|부친|부쳐)/.test(t);
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

const EXAMPLE = String
  .raw`{"recipes":[{"menu":"오징어무침","comp":"부찬","allergy":"오징어, 밀, 대두","source":"https://www.10000recipe.com/recipe/7021555",
"method":"1. 기준 작업량은 100명이며 실제 식수에 맞춰 1인 재료량을 곱해 계량한다. 대형솥, 대형 믹싱볼, 얕은 배식용기를 준비하고 장비 용량에 맞게 25명분씩 4배치로 분할한다.\n2. 오징어는 전용 칼과 도마로 내장·눈·입을 제거하고 같은 크기로 절단한다. 채소는 별도 작업대에서 세척·손질해 물기를 뺀다.\n3. 대형솥의 물이 다시 끓도록 배치별로 오징어를 넣는다(과다 투입으로 온도가 떨어지지 않도록 한다).\n4. 가장 두꺼운 오징어의 중심온도 85℃를 1분 이상 확인한 뒤 건진다. 시간만으로 익음을 판단하지 않는다.\n5. 가열한 오징어는 얕은 용기에 나누어 빠르게 냉각하고 5℃ 이하로 보관한다. 생재료와 조리된 재료의 도구를 분리한다.\n6. 대형 믹싱볼에서 계량한 고추장·식초 등 양념을 먼저 고르게 섞고 배치별 양념량을 나눈다.\n7. 배식 직전 필요한 배치만 오징어·채소와 양념을 버무린다(전체를 미리 버무려 물이 생기지 않게 한다).\n8. 완성품은 배식용기에 분할해 5℃ 이하로 보관하고 배식 회차에 맞춰 소량씩 교체한다.",
"items":[{"item":"오징어","qty":100,"unit":"g","storage":"냉장","loss":0.1,"form":"전처리"},{"item":"오이","qty":20,"unit":"g","storage":"냉장","loss":0.05,"form":"전처리"},{"item":"고추장","qty":10,"unit":"g","storage":"실온","loss":0.03,"form":"원물"},{"item":"식초","qty":8,"unit":"ml","storage":"실온","loss":0.03,"form":"원물"}]}]}`;

export function buildPrompt(
  list: Missing[],
  refs: Record<string, Ref | null> = {},
): string {
  for (const menu of list) assertMealMenuAllowed(menu.menu);
  const refText = (m: Missing) => {
    if (m.methodUpgrade) {
      return `- ${m.menu} | 기존 AI 레시피의 조리법만 대량조리로 전환\n` +
        `  기존 레시피: ${JSON.stringify(m.methodUpgrade.recipe)}\n` +
        "  menu/comp/allergy/source/items는 기존 값 그대로 반환. 재료를 추가·삭제하거나 분량을 다시 산정하지 말고 method만 새로 작성.";
    }
    const r = refs[m.menu];
    if (!r) {
      return `- ${m.menu} | 구성: ${m.comp} | 참고자료 없음 → source 는 "일반 급식 레시피"`;
    }
    return `- ${m.menu} | 구성: ${m.comp} | source: ${r.url}\n  참고 제목: ${r.title}\n  참고 재료: ${
      r.ingredients.slice(0, 500)
    }\n  참고 조리: ${r.steps.join(" / ").slice(0, 900)}`;
  };
  return [
    "당신은 한국 공장 구내식당의 단체급식 조리 실무자입니다. 재료량은 기존 발주 계산과 호환되는 1인 분량, method는 100명 기준 대량 조리 작업서로 작성하세요. JSON 으로만 출력하고 설명 문장·마크다운은 쓰지 마세요.",
    "출력 형식과 문체는 아래 예시와 똑같이 맞추세요:",
    EXAMPLE,
    "규칙:",
    "- 공장 구내식당 급식이므로 맥주·소주·막걸리·와인·하이볼 등 주류, 무알콜·논알콜 맥주형 음료와 그 브랜드는 독립 메뉴로 생성하지 마세요. 조리 재료인 맛술·와인 등을 실제 요리에 사용하는 것은 가능하지만 음료 메뉴를 다른 음식으로 바꿔 쓰거나 같은 menu 이름 아래 콘치즈 등 다른 음식의 레시피를 넣지 마세요.",
    "- menu 는 주어진 이름과 글자 그대로 동일. comp 는 기본적으로 주어진 구성을 쓰되, 메뉴와 명백히 맞지 않으면 실제 조리 역할로 바로잡으세요(예: 육전이 밥으로 들어오면 comp 는 주찬).",
    "- method 는 순서대로 6~10단계, 각 단계는 '숫자. ' 로 시작하고 줄바꿈(\\n)으로 구분. 준비·계량→대량 전처리→배치별 조리→온도계 확인→보관·배식 순서. 첫 단계에 100명 기준, 사용할 장비와 장비 용량에 맞춘 분할 배치(예: 25명분씩 4회, 실제 식수에 맞춰 환산)를 명시하세요.",
    "- 회전솥 또는 대형솥·틸팅팬·튀김기·전판(그리들)을 음식에 맞게 선택. 프라이팬/후라이팬/가정용 팬, 한 줌, 종이컵, 큰술/작은술 계량은 금지. 오븐 보유가 확인되지 않았으므로 필수로 쓰지 말고, 쓸 경우 '보유 시 선택'으로 쓰고 대형솥·튀김기·전판 조리 대안을 같이 적으세요. 육전은 소고기·가루옷·계란물을 준비해 전판에 겹치지 않게 배치별로 부치세요.",
    "- 팬·솥에 전량을 한꺼번에 넣지 말고 용량과 가열 회복에 맞춰 배치/분할 작업을 설명. 튀김은 튀김기 사용, 메뉴별 기름 온도와 투입량을 제시하되 기름 온도만으로 익음을 판단하지 마세요. 배식 직전 마무리, 보관온도, 배식 회차별 교체를 반드시 적으세요.",
    "- 식약처 대량 조리 위생 기준: 육류는 중심온도 75℃ 1분 이상, 어패류는 85℃ 1분 이상을 온도계로 확인. 뜨거운 음식은 60℃ 이상 보온, 찬 음식은 5℃ 이하. 냉각이 필요한 음식은 얕은 용기에 분할해 빠르게 냉각. 짧은 고정 시간만 제시해 가열 기준과 모순되게 쓰지 마세요. 가열하지 않는 완제품 김치·절임 등은 불필요하게 익히지 말고 대형 믹싱볼/배식용기, 개봉·위생·분할·냉장·배식 작업을 6~10단계로 작성하세요.",
    "- 생으로 배식하는 채소는 식품용 살균·소독제의 표시 농도·접촉 시간을 지켜 세척·소독하고 충분히 헹구세요. 식초·소금물 세척을 살균·소독의 대체로 쓰지 마세요.",
    "- 배식대에 나갔거나 손님에게 제공된 음식, 배식 후 남은 음식·잔반은 재사용·재조리·보관하지 않고 폐기. 재가열하면 재사용할 수 있다고 쓰지 마세요. 냉각·보관 안내는 명확히 구분된 '미배식분'에만 시설의 위생관리 기준을 따르는 조건으로 작성하고, 단순히 '남은 음식'이라 하지 마세요.",
    "- items 는 물 제외 5~13개, 양념까지 모두 포함. 1인 분량은 급식 기준(밥 쌀 100g, 국 건더기 60~80g, 주찬 육류·어류 70~120g, 부찬 채소 50~80g, 김치 50g). unit 은 g/ml/ea 만. storage 는 냉장/냉동/실온. form 은 원물/전처리/가공. loss 는 육류·어류 0.1, 채소 0.05, 양념 0.03.",
    '- allergy 는 식약처 표시 대상 알레르기 유발물질을 쉼표로 (없으면 "").',
    '- 이름이 오타·상표·구호처럼 보이거나 어떤 음식인지 확신이 없으면(예: \'엄마파이팅\'), 가장 그럴듯한 레시피를 쓰되 "ask":{"question":"…인지 확인해 주세요","rename":["올바른 이름 후보1","후보2"]} 를 그 레시피에 덧붙임. 확실하면 ask 생략.',
    "- source 는 참고자료 URL 을 그대로. 참고자료는 음식의 정체성·재료 참고일 뿐, 가정용 장비·가열 시간·숟가락 계량은 복사하지 말고 대량 조리 공정으로 재설계. 참고자료가 없으면 일반적인 급식 레시피로 작성.",
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
