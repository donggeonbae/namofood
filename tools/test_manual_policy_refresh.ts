// Manual-policy repair acceptance: no production access or real credentials.
import {
  decryptText,
  encryptText,
  type State,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
import {
  applyInstitutionalRefresh,
  type CatalogEntry,
  type CloudRow,
  type OwnershipProofs,
  planInstitutionalRefresh,
  REFRESH_MODEL,
  type RefreshStorage,
} from "./refresh_institutional_menus.ts";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const method = [
  "1. 식재료를 검수하고 계량한다.",
  "2. 세척하고 교차오염을 예방한다.",
  "3. 대형 회전솥 용량에 맞춰 배치로 나누어 준비한다.",
  "4. 나누어 가열하고 양념을 섞는다.",
  "5. 배식 직전 맛을 확인하고 60℃ 이상 보온 유지한다.",
  "6. 배식용기에 나누어 배식하고 배식 후 남은 음식은 폐기한다.",
].join("\n");
const definitions = [
  ["제육볶음", "돼지고기", "pork", "stirfry", "gochujang"],
  ["고등어구이", "고등어", "fish", "grill", "salt"],
  ["소불고기", "소고기", "beef", "stirfry", "soy"],
  ["닭갈비", "닭고기", "chicken", "stirfry", "gochujang"],
  ["돈가스", "돼지고기", "pork", "fry", "cutlet"],
  ["생선가스", "명태", "fish", "fry", "cutlet"],
  ["오징어볶음", "오징어", "seafood", "stirfry", "gochujang"],
  ["간장찜닭", "닭고기", "chicken", "braise", "soy"],
  ["갈치조림", "갈치", "fish", "braise", "gochujang"],
  ["돈육간장불고기", "돼지고기", "pork", "stirfry", "soy"],
  ["계란찜", "달걀", "egg", "steam", "salt"],
  ["두부조림", "두부", "tofu", "braise", "soy"],
];
const bank: CatalogEntry[] = definitions.map(
  ([menu, item, protein, cooking, seasoning]) => ({
    role: "main",
    method: cooking,
    protein,
    seasoning,
    recipe: {
      menu,
      comp: "주찬",
      source: "수정 식단 검증용",
      method,
      items: [{ item, qty: 130, unit: "g" }],
    },
  }),
);
const state: State = {
  menus: { "2026-10": {} },
  menuPlanMeta: {},
  recipes: bank.flatMap((entry) =>
    entry.recipe.items.map((row) => ({
      ...row,
      menu: entry.recipe.menu,
      comp: entry.recipe.comp,
    }))
  ),
  methods: Object.fromEntries(bank.map((entry) => [entry.recipe.menu, method])),
  headcountMeta: { "2026-10-08|조식": { by: "manual", updated: "keep" } },
  settings: { keep: "all" },
};
const ownership: OwnershipProofs = { runAdded: { prior: [] } };
function meal(
  date: string,
  main1: string,
  main2: string,
  bonus = "감자채볶음",
  ai = true,
) {
  const day = Number(date.split("-")[2]);
  const values: Record<string, string> = {
    "0": "쌀밥",
    "n": "321",
    "1": "맑은콩나물국",
    "2": main1,
    "7": main2,
    "3": "오이무침",
    "4": "감자조림",
    "8": "배추김치",
    "10": bonus,
  };
  for (const [slot, value] of Object.entries(values)) {
    state.menus!["2026-10"][`${day}|조식|${slot}`] = value;
    if (ai && !["0", "n"].includes(slot)) {
      ownership.runAdded.prior.push(`${date}|조식|${slot}`);
    }
  }
  if (ai) {
    state.menuPlanMeta![`${date}|조식`] = {
      by: "ai",
      updated: "keep",
      model: REFRESH_MODEL,
      runId: "prior",
    };
  }
}
meal("2026-10-07", "제육볶음", "고등어구이"); // Past must not be repaired.
meal("2026-10-08", "제육볶음", "고등어구이"); // Today is in scope.
meal("2026-10-09", "닭갈비", "돈가스", "감자채볶음", false); // Manual.
meal("2026-10-16", "닭갈비", "돈가스");
meal("2026-10-24", "소불고기", "생선가스", "계란찜"); // Compliant AI.
const snapshot = structuredClone(state);
const options = {
  today: "2026-10-08",
  updated: "2026-10-08T05:00:00.000Z",
  runId: "premium-run",
  manualPolicy: true,
};
const result = planInstitutionalRefresh(state, bank, ownership, options);
assert(
  result.refreshedMeals.join() === "2026-10-08|조식,2026-10-16|조식",
  "Manual policy repairs TODAY and future noncompliant AI meals even after institutional refresh",
);
assert(
  JSON.stringify(state) === JSON.stringify(snapshot),
  "Planner remains pure",
);
assert(
  result.catalogAdded.length === 0,
  "Manual policy never expands or rewrites recipes",
);
for (const date of ["2026-10-07", "2026-10-09", "2026-10-24"]) {
  const day = Number(date.split("-")[2]);
  for (const slot of ["0", "n", "1", "2", "7", "3", "4", "8", "10"]) {
    assert(
      result.after.menus!["2026-10"][`${day}|조식|${slot}`] ===
        state.menus!["2026-10"][`${day}|조식|${slot}`],
      `Protected or compliant meal remains exact ${date}|${slot}`,
    );
  }
  assert(
    JSON.stringify(result.after.menuPlanMeta?.[`${date}|조식`]) ===
      JSON.stringify(state.menuPlanMeta?.[`${date}|조식`]),
    "Skipped meal metadata exact",
  );
}
for (const day of [8, 16]) {
  for (const slot of ["0", "n", "1", "2", "7", "3", "4", "8", "10"]) {
    assert(
      result.after.menus!["2026-10"][`${day}|조식|${slot}`] ===
        state.menus!["2026-10"][`${day}|조식|${slot}`],
      "Premium repair keeps valid old dishes, rice and counts; adds actual third main",
    );
  }
  assert(
    Boolean(result.after.menus!["2026-10"][`${day}|조식|11`]),
    "Third main is appended without deleting existing bonus",
  );
}
assert(
  result.protectedChanged.length === 0 && result.missingNewRecipes.length === 0,
  "All protections and recipes verified",
);
assert(result.changedCells.length === 2, "Minimum necessary food edits");
const again = planInstitutionalRefresh(
  result.after,
  bank,
  result.generatedOwnership,
  { ...options, runId: "premium-again" },
);
assert(
  again.changedCells.length === 0 && again.refreshedMeals.length === 0 &&
    JSON.stringify(again.after) === JSON.stringify(result.after),
  "Policy repair rerun is exactly idempotent",
);
const plantPair = structuredClone(state);
plantPair.menus!["2026-10"]["16|조식|2"] = "계란찜";
plantPair.menus!["2026-10"]["16|조식|7"] = "두부조림";
const anchored = planInstitutionalRefresh(plantPair, bank, ownership, options);
assert(
  anchored.after.menus!["2026-10"]["16|조식|2"] === "계란찜" &&
    anchored.after.menus!["2026-10"]["16|조식|7"] !== "두부조림" &&
    Boolean(anchored.after.menus!["2026-10"]["16|조식|11"]),
  "A plant/egg-only primary pair repairs one owned main to an animal anchor and still adds a third substantive dish",
);
const limitedProof = structuredClone(ownership);
limitedProof.runAdded.prior = limitedProof.runAdded.prior.filter((key) =>
  !["2026-10-16|조식|2", "2026-10-16|조식|7"].includes(key)
);
let protectedAnchorFailure = false;
try {
  planInstitutionalRefresh(plantPair, bank, limitedProof, options);
} catch (error) {
  protectedAnchorFailure = /Manual anchors prevent/.test(String(error));
}
assert(
  protectedAnchorFailure &&
    plantPair.menus!["2026-10"]["16|조식|7"] === "두부조림",
  "Lack of verified ownership never authorizes changing a preserved manual primary main",
);
const asked = structuredClone(state);
asked.recipeAsk = { 소불고기: { ask: "확인 필요" } };
const resolvedOnly = planInstitutionalRefresh(asked, bank, ownership, options);
assert(
  resolvedOnly.changedCells.every((key) => {
    const [date, meal, slot] = key.split("|");
    return resolvedOnly.after
      .menus!["2026-10"][`${Number(date.split("-")[2])}|${meal}|${slot}`] !==
      "소불고기";
  }),
  "An unresolved recipe is never newly selected as the premium upgrade",
);
// A complete saved AI recipe is not a reviewed composition source. A one-option
// bank makes this distinction observable even if ordinary sorting changes.
const legacyAI = structuredClone(state);
const invented = "새우튀김듬뿍우동국물";
(legacyAI.recipes as Array<Record<string, unknown>>).push({
  menu: invented,
  item: "새우",
  qty: 180,
  unit: "g",
  comp: "주찬",
});
(legacyAI.methods as Record<string, string>)[invented] = method;
let unreviewedRejected = false;
try {
  planInstitutionalRefresh(legacyAI, [], ownership, options);
} catch (error) {
  unreviewedRejected = /No valid manual-policy repair/.test(String(error));
}
assert(
  unreviewedRejected,
  "Even a complete, protein-rich legacy AI recipe cannot become an automatic main without reviewed catalog or confirmed human-menu provenance",
);
const reviewedOnly = planInstitutionalRefresh(
  legacyAI,
  bank,
  ownership,
  options,
);
assert(
  reviewedOnly.changedCells.every((key) => {
    const [date, meal, slot] = key.split("|");
    return reviewedOnly.after
      .menus!["2026-10"][`${Number(date.split("-")[2])}|${meal}|${slot}`] !==
      invented;
  }),
  "All repaired primary and upgrade choices remain within the approved source bank",
);
assert(
  result.generatedOwnership.runAdded[options.runId].includes(
    "2026-10-08|조식|2",
  ),
  "Retained AI food ownership survives new provenance",
);
// A concurrent user edit during save removes a meal's AI marker. A fresh CAS
// attempt must not rewrite that newly manual meal or its edited headcount.
const password = "synthetic-premium-repair-password";
let currentState = structuredClone(state), writes = 0;
let row: CloudRow = {
  id: "namofood",
  data: await encryptText(password, JSON.stringify(currentState)),
  updated_at: "2026-10-08T04:00:00.000Z",
};
const backups: CloudRow[] = [];
const storage: RefreshStorage = {
  readCurrent: async () => structuredClone(row),
  readBackup: async () => undefined,
  readRunAdded: async () => {
    throw new Error(
      "Explicit audited proof must bypass unneeded provenance reads",
    );
  },
  createBackup: async (backup) => {
    backups.push(structuredClone(backup));
    return structuredClone(backup);
  },
  compareAndSwap: async (old, next) => {
    assert(
      old.data === row.data && old.updated_at === row.updated_at,
      "CAS always starts from fresh cloud data",
    );
    writes++;
    if (writes === 1) {
      delete currentState.menuPlanMeta!["2026-10-16|조식"];
      currentState.menus!["2026-10"]["16|조식|n"] = "444";
      row = {
        ...row,
        data: await encryptText(password, JSON.stringify(currentState)),
        updated_at: "2026-10-08T04:30:00.000Z",
      };
      return undefined;
    }
    row = structuredClone(next);
    currentState = JSON.parse(await decryptText(password, row.data));
    return structuredClone(row);
  },
};
const saved = await applyInstitutionalRefresh({
  password,
  today: options.today,
  bank,
  ownership,
  manualPolicy: true,
  apply: true,
  storage,
  now: () => options.updated,
  uuid: () => options.runId,
});
assert(
  saved.saved && saved.readBackVerified && saved.attempt === 2 &&
    backups.length === 2,
  "Manual policy preserves encrypted backup, CAS retry and full readback",
);
assert(
  saved.refreshedMeals.join() === "2026-10-08|조식",
  "Fresh CAS rechecks compliance and new manual provenance",
);
assert(
  currentState.menus!["2026-10"]["16|조식|n"] === "444" &&
    !currentState.menus!["2026-10"]["16|조식|11"],
  "Concurrent manual meal and headcount remain untouched",
);
console.log(
  "MANUAL_POLICY_REFRESH_OK minimum repair, today inclusion, compliance idempotency, manual/past protections",
);
