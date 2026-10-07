// Synthetic refresh/planner/storage checks. No catalog import or network.
import {
  decryptText,
  encryptText,
  type State,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
import {
  applyInstitutionalRefresh,
  assertRefreshProtected,
  type CatalogEntry,
  type CloudRow,
  deriveRecoveryOwnedCells,
  type OwnershipProofs,
  planInstitutionalRefresh,
  RECOVERY_RUN_ID,
  REFRESH_MODEL,
  type RefreshStorage,
  validateOwnershipProofs,
} from "./refresh_institutional_menus.ts";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function throws(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
  } catch (error) {
    assert(pattern.test(String(error)), `Unexpected error: ${error}`);
    return;
  }
  throw new Error("Expected failure did not happen");
}
async function rejects(fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
  } catch (error) {
    assert(pattern.test(String(error)), `Unexpected error: ${error}`);
    return;
  }
  throw new Error("Expected async failure did not happen");
}
const method = [
  "1. 식재료를 검수하고 계량한다.",
  "2. 세척하고 교차오염을 예방한다.",
  "3. 대형 회전솥 용량에 맞춰 배치로 나누어 준비한다.",
  "4. 나누어 가열하고 양념을 섞는다. 육류 중심온도 75℃ 1분 이상, 어패류 중심온도 85℃ 1분 이상을 확인한다.",
  "5. 배식 직전 맛을 확인하고 60℃ 이상 보온 유지한다.",
  "6. 배식용기에 나누어 배식하고 배식 후 남은 음식은 폐기한다.",
].join("\n");
function entry(menu: string, role: CatalogEntry["role"], i = 0): CatalogEntry {
  return {
    role,
    method: `조리${i % 5}`,
    protein: `단백질${i % 7}`,
    seasoning: `양념${i % 4}`,
    recipe: {
      menu,
      comp: role === "main" ? "주찬" : role === "soup" ? "국" : "부찬",
      source: "일반 급식 레시피",
      method,
      items: [{
        item: role !== "main"
          ? "양배추"
          : /두부/.test(menu)
          ? "두부"
          : /계란|달걀/.test(menu)
          ? "달걀"
          : /닭/.test(menu)
          ? "닭고기"
          : "돼지고기",
        qty: 80,
        unit: "g",
      }],
    },
  };
}
const bank = [
  ...Array.from({ length: 50 }, (_, i) => entry(`검증주찬-${i}`, "main", i)),
  ...Array.from({ length: 20 }, (_, i) => entry(`검증국-${i}국`, "soup", i)),
  ...Array.from({ length: 45 }, (_, i) => entry(`검증부찬-${i}`, "side", i)),
  entry("배추김치", "kimchi"),
  entry("깍두기", "kimchi"),
];
const options = {
  today: "2026-10-08",
  updated: "2026-10-08T05:00:00.000Z",
  runId: "new-synthetic-run",
};
function fixture() {
  const before: State = {
    menus: {
      "2026-10": {
        "7|조식|2": "과거보존",
        "8|조식|2": "오늘보존",
        "15|조식|0": "잡곡밥",
        "15|조식|n": "777",
        "15|조식|1": "이전국",
        "15|조식|2": "이전AI주찬",
        "15|조식|7": "수동고정주찬",
        "15|조식|3": "이전부찬1",
        "15|조식|4": "이전부찬2",
        "15|조식|8": "이전김치",
        "15|조식|10": "이전AI추가찬",
        "15|조식|11": "수동추가찬",
        "15|중식|2": "수동끼니",
        "16|조식|2": "부분수동주찬",
        "16|조식|n": "888",
      },
    },
    menuPlanMeta: {
      "2026-10-07|조식": {
        by: "ai",
        updated: "keep",
        model: "old",
        runId: "old",
      },
      "2026-10-08|조식": {
        by: "ai",
        updated: "keep",
        model: "old",
        runId: "old",
      },
      "2026-10-15|조식": {
        by: "ai",
        updated: "keep",
        model: "old",
        runId: "old",
      },
      "2026-10-16|조식": {
        by: "ai",
        updated: "keep",
        model: "old",
        runId: "partial",
      },
    },
    recipes: [{
      menu: "보존레시피",
      item: "양배추",
      qty: 12,
      unit: "g",
      custom: "keep",
    }],
    methods: { "보존레시피": "수동 조리법" },
    sources: { "보존레시피": "수동 출처" },
    recipeMeta: { "보존레시피": { by: "user", custom: "keep" } },
    recipeAsk: { "보존레시피": { ask: "기존 안내" } },
    headcountMeta: { "2026-10-15|조식": { by: "manual", updated: "keep" } },
    settings: { meals: { 조식: { price: 12345 } }, other: "keep" },
    staff: [{ id: "synthetic", wage: 123 }],
    updatedAt: "keep",
  };
  const ownership: OwnershipProofs = {
    runAdded: {
      old: [
        "2026-10-07|조식|2",
        "2026-10-08|조식|2",
        ...["1", "2", "3", "4", "8", "10", "0", "n"].map((slot) =>
          `2026-10-15|조식|${slot}`
        ),
      ],
      partial: ["1", "7", "3", "4", "8", "10"].map((slot) =>
        `2026-10-16|조식|${slot}`
      ),
    },
  };
  // The second run added these cells, but not its preserved original main.
  for (const slot of ["1", "7", "3", "4", "8", "10"]) {
    before.menus!["2026-10"][`16|조식|${slot}`] = `이전부분AI-${slot}`;
  }
  return { before, ownership };
}
let checks = 0;
const { before, ownership } = fixture(), snapshot = structuredClone(before);
const planned = planInstitutionalRefresh(before, bank, ownership, options);
assert(equal(before, snapshot), "Pure planner must not mutate input");
checks++;
assert(
  planned.refreshedMeals.join() === "2026-10-15|조식,2026-10-16|조식",
  "Only future AI meals refresh",
);
checks++;
for (
  const key of [
    "7|조식|2",
    "8|조식|2",
    "15|조식|0",
    "15|조식|n",
    "15|조식|7",
    "15|조식|11",
    "15|중식|2",
    "16|조식|2",
    "16|조식|n",
  ]
) {
  assert(
    planned.after.menus!["2026-10"][key] === before.menus!["2026-10"][key],
    `Protected cell ${key}`,
  );
}
checks++;
for (const field of ["headcountMeta", "settings", "staff"]) {
  assert(equal(planned.after[field], before[field]), `Unrelated ${field}`);
}
checks++;
assert(
  equal((planned.after.recipes as unknown[]).slice(0, 1), before.recipes),
  "Original recipe row exact and first",
);
checks++;
for (const field of ["methods", "sources", "recipeMeta", "recipeAsk"]) {
  assert(
    equal(
      (planned.after[field] as Record<string, unknown>)["보존레시피"],
      (before[field] as Record<string, unknown>)["보존레시피"],
    ),
    `Recipe map preserved ${field}`,
  );
}
checks++;
assert(
  planned.catalogAdded.length === bank.length,
  "Whole catalog appends even while menus use subset",
);
checks++;
assert(
  planned.plan.days.every((day) =>
    day.meals.every((meal) =>
      Object.keys(meal.slots).length === 6 && meal.extras!.length <= 1
    )
  ),
  "Full six slots with optional one bonus",
);
checks++;
assert(planned.protectedChanged.length === 0, "Protection proof clean");
checks++;
assert(
  planned.missingNewRecipes.length === 0,
  "Every newlyselected dish has positive ingredient rows and a saved cooking method",
);
checks++;
const methodsOnlyFixture = fixture();
(methodsOnlyFixture.before.methods as Record<string, unknown>)["검증주찬-0"] =
  "methods-only original";
(methodsOnlyFixture.before.sources as Record<string, unknown>)["검증주찬-0"] =
  "sources-only original";
const methodsOnlyPlan = planInstitutionalRefresh(
  methodsOnlyFixture.before,
  bank,
  methodsOnlyFixture.ownership,
  options,
);
assert(
  !methodsOnlyPlan.plan.days.some((day) =>
    day.meals.some((meal) =>
      Object.values(meal.slots).includes("검증주찬-0") ||
      meal.extras?.includes("검증주찬-0")
    )
  ),
  "Methods/source-only collision cannot be selected as a new dish without ingredient rows",
);
assert(
  (methodsOnlyPlan.after.methods as Record<string, unknown>)["검증주찬-0"] ===
      "methods-only original" &&
    (methodsOnlyPlan.after.sources as Record<string, unknown>)["검증주찬-0"] ===
      "sources-only original",
  "Methods/source-only original metadata remains exact",
);
checks++;
const rerun = planInstitutionalRefresh(planned.after, bank, { runAdded: {} }, {
  ...options,
  runId: "rerun",
});
assert(
  rerun.changedCells.length === 0 && rerun.catalogAdded.length === 0 &&
    rerun.refreshedMeals.length === 0 && equal(rerun.after, planned.after),
  "Idempotent rerun exact",
);
checks++;
assert(
  planned.generatedOwnership.runAdded[options.runId].every((key) =>
    !/\|(0|n)$/.test(key) &&
    !["2026-10-15|조식|7", "2026-10-15|조식|11", "2026-10-16|조식|2"].includes(
      key,
    )
  ),
  "Generated ownership excludes original manual cells, rice and counts",
);
checks++;
const forced = planInstitutionalRefresh(
  planned.after,
  bank,
  planned.generatedOwnership,
  { ...options, force: true, runId: "forced-synthetic-run" },
);
assert(
  forced.refreshedMeals.length === 2 &&
    forced.after.menus!["2026-10"]["15|조식|7"] === "수동고정주찬" &&
    forced.after.menus!["2026-10"]["16|조식|2"] === "부분수동주찬",
  "Force with returned proof refreshes AI cells and retains original manual cells",
);
checks++;
throws(
  () => planInstitutionalRefresh(before, bank, { runAdded: {} }, options),
  /ownership/,
);
checks++;
throws(
  () => validateOwnershipProofs({ runAdded: { bad: ["not-a-cell"] } }),
  /Invalid ownership/,
);
checks++;
const onlyCatalog = planInstitutionalRefresh(
  { recipes: [] },
  bank.slice(0, 3),
  { runAdded: {} },
  options,
);
assert(
  onlyCatalog.catalogAdded.length === 3 &&
    onlyCatalog.refreshedMeals.length === 0,
  "Append catalog without refreshable menus",
);
checks++;
const allNewMains = fixture();
allNewMains.before.menus!["2026-10"]["15|조식|7"] = "이전AI둘째주찬";
allNewMains.ownership.runAdded.old.push("2026-10-15|조식|7");
delete allNewMains.before.menuPlanMeta!["2026-10-16|조식"];
const tofu = { ...entry("두부조림", "main", 1), protein: "tofu" };
const egg = { ...entry("계란찜", "main", 2), protein: "egg" };
const plantOnly = [tofu, egg, ...bank.filter((item) => item.role !== "main")];
throws(
  () =>
    planInstitutionalRefresh(
      allNewMains.before,
      plantOnly,
      allNewMains.ownership,
      options,
    ),
  /No valid/,
);
checks++;
const meat = { ...entry("닭간장볶음", "main", 3), protein: "chicken" };
const animalResult = planInstitutionalRefresh(
  allNewMains.before,
  [...plantOnly, meat],
  allNewMains.ownership,
  options,
);
assert(
  [
    animalResult.plan.days[0].meals[0].slots["2"],
    animalResult.plan.days[0].meals[0].slots["7"],
  ].includes("닭간장볶음"),
  "Two newlyfilled mains include at least one meat/fish/seafood main when protein kinds are known",
);
checks++;
const aliases = planInstitutionalRefresh(
  {
    recipes: [{ menu: "돈가스", item: "existing", qty: 1 }],
    methods: { 돈가스: "keep" },
  },
  [entry("돈까스", "main")],
  { runAdded: {} },
  options,
);
assert(
  aliases.catalogAdded.length === 0 && aliases.catalogSkipped.length === 1 &&
    (aliases.after.methods as Record<string, unknown>).돈가스 === "keep",
  "Canonical existing recipe prevents alias append",
);
checks++;
const orphan = planInstitutionalRefresh(
  {
    recipes: [],
    methods: { "검증주찬-0": "orphan keep" },
    recipeAsk: { "검증주찬-0": { ask: "keep" } },
  },
  bank.slice(0, 1),
  { runAdded: {} },
  options,
);
assert(
  orphan.catalogAdded.length === 0 &&
    equal(orphan.after, {
      recipes: [],
      methods: { "검증주찬-0": "orphan keep" },
      recipeAsk: { "검증주찬-0": { ask: "keep" } },
    }),
  "Existing recipe-related orphan values preserved",
);
checks++;
throws(
  () => planInstitutionalRefresh(before, [], ownership, options),
  /No valid/,
);
checks++;
const invalidBank = [entry("검증잘못된레시피", "side")];
invalidBank[0].recipe.method = "프라이팬 한 줌";
throws(
  () =>
    planInstitutionalRefresh(
      { recipes: [] },
      invalidBank,
      { runAdded: {} },
      options,
    ),
  /recipe validation failed/,
);
checks++;
const beforeRecovery: State = {
  menus: {
    "2026-10": {
      "16|조식|2": "원본수동",
      "16|조식|n": "10",
      "16|조식|0": "잡곡밥",
    },
  },
};
const afterRecovery: State = {
  menus: {
    "2026-10": {
      "16|조식|2": "원본수동",
      "16|조식|n": "10",
      "16|조식|0": "쌀밥",
      "16|조식|7": "AI추가",
      "16|조식|10": "AI추가찬",
    },
  },
  menuPlanMeta: {
    "2026-10-16|조식": {
      by: "ai",
      model: "codex-curated-recovery",
      updated: "keep",
      runId: RECOVERY_RUN_ID,
    },
  },
};
assert(
  deriveRecoveryOwnedCells(beforeRecovery, afterRecovery).join() ===
    "2026-10-16|조식|10,2026-10-16|조식|7",
  "Recovery diff owns only inserted food cells",
);
checks++;
const tampered = structuredClone(planned.after);
tampered.menus!["2026-10"]["15|조식|n"] = "999";
throws(
  () =>
    assertRefreshProtected(
      before,
      tampered,
      new Set(planned.changedCells),
      new Set(planned.refreshedMeals),
      new Set(planned.catalogAdded),
    ),
  /Protected data changed/,
);
checks++;

const password = "synthetic-refresh-test-password";
async function storageFixture(
  config: {
    conflict?: boolean;
    backupFail?: boolean;
    concurrentReadback?: boolean;
    normalizedBackupTime?: boolean;
  } = {},
) {
  let state = structuredClone(before),
    row: CloudRow = {
      id: "namofood",
      data: await encryptText(password, JSON.stringify(state)),
      updated_at: "2026-10-08T04:00:00.000Z",
    };
  const backups: CloudRow[] = [];
  let writes = 0, provenanceReads = 0, reads = 0;
  const storage: RefreshStorage = {
    readCurrent: async () => {
      reads++;
      if (config.concurrentReadback && writes > 0) {
        state.settings = { changedConcurrently: true };
        row = {
          ...row,
          data: await encryptText(password, JSON.stringify(state)),
          updated_at: "2026-10-08T06:00:00.000Z",
        };
      }
      return structuredClone(row);
    },
    readBackup: async () => undefined,
    readRunAdded: async () => {
      provenanceReads++;
      throw new Error("No public provenance access");
    },
    createBackup: async (value) => {
      if (config.backupFail) throw new Error("backup failure");
      backups.push(structuredClone(value));
      return {
        ...structuredClone(value),
        updated_at: config.normalizedBackupTime
          ? value.updated_at.replace(/Z$/, "+00:00")
          : value.updated_at,
      };
    },
    compareAndSwap: async (_old, next) => {
      writes++;
      if (config.conflict && writes === 1) {
        state.menus!["2026-10"]["15|조식|7"] = "동시수동주찬";
        state.menus!["2026-10"]["15|조식|n"] = "444";
        row = {
          ...row,
          data: await encryptText(password, JSON.stringify(state)),
          updated_at: "2026-10-08T04:30:00.000Z",
        };
        return undefined;
      }
      row = structuredClone(next);
      state = JSON.parse(await decryptText(password, row.data));
      return structuredClone(row);
    },
  };
  return {
    storage,
    backups,
    state: () => state,
    writes: () => writes,
    provenanceReads: () => provenanceReads,
    reads: () => reads,
  };
}
const dry = await storageFixture();
const dryResult = await applyInstitutionalRefresh({
  password,
  today: options.today,
  bank,
  ownership,
  storage: dry.storage,
  now: () => options.updated,
  uuid: () => options.runId,
});
assert(
  dryResult.dry && !dryResult.saved && dry.writes() === 0 &&
    dry.backups.length === 0 && dry.provenanceReads() === 0,
  "Default dry; provided proof bypasses public provenance; no writes/backups",
);
checks++;
const failing = await storageFixture({ backupFail: true });
await rejects(
  () =>
    applyInstitutionalRefresh({
      password,
      today: options.today,
      bank,
      ownership,
      apply: true,
      storage: failing.storage,
    }),
  /backup failure/,
);
assert(failing.writes() === 0, "Backup failure prevents CAS");
checks++;
const cas = await storageFixture({ conflict: true });
const casResult = await applyInstitutionalRefresh({
  password,
  today: options.today,
  bank,
  ownership,
  apply: true,
  storage: cas.storage,
  now: () => options.updated,
  uuid: () => options.runId,
});
assert(
  casResult.saved && casResult.readBackVerified && casResult.attempt === 2 &&
    cas.backups.length === 2,
  "CAS conflict re-reads and re-plans with separate encrypted backups",
);
checks++;
const normalized = await storageFixture({ normalizedBackupTime: true });
const normalizedResult = await applyInstitutionalRefresh({
  password,
  today: options.today,
  bank,
  ownership,
  apply: true,
  storage: normalized.storage,
  now: () => options.updated,
  uuid: () => options.runId,
});
assert(
  normalizedResult.saved && normalizedResult.readBackVerified,
  "REST-normalized equivalent backup timestamp confirms successfully",
);
checks++;
assert(
  cas.state().menus!["2026-10"]["15|조식|7"] === "동시수동주찬" &&
    cas.state().menus!["2026-10"]["15|조식|n"] === "444",
  "Concurrent manual cells survive replanning",
);
checks++;
const readback = await storageFixture({ concurrentReadback: true });
await rejects(
  () =>
    applyInstitutionalRefresh({
      password,
      today: options.today,
      bank,
      ownership,
      apply: true,
      storage: readback.storage,
    }),
  /changed concurrently during read-back/,
);
checks++;
const absentProof = await storageFixture();
await rejects(
  () =>
    applyInstitutionalRefresh({
      password,
      today: options.today,
      bank,
      storage: absentProof.storage,
    }),
  /audited --ownership-file/,
);
assert(
  absentProof.writes() === 0,
  "Unavailable provenance fails closed before writes",
);
checks++;
await rejects(
  () =>
    applyInstitutionalRefresh({
      password: "",
      today: options.today,
      bank,
      ownership,
      storage: dry.storage,
    }),
  /NMF_PW required/,
);
checks++;
console.log(`INSTITUTIONAL_REFRESH_OK (${checks} behavior checks)`);
