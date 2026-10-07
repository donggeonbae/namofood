// Authoritative composition policy distilled from confirmed human-edited menus.
// See docs/menu-composition-manual.md. This is not a closed AI dish catalog.
import { assertMealMenuAllowed } from "./menu-eligibility.ts";
import {
  canonicalDish,
  type DishProfile,
  dishProfile,
  normalizedDishName,
} from "./institutional-menu.ts";

export const MENU_MANUAL_VERSION = "2026-10-08-human-edited-premium-v1";
export const MANUAL_FAMILIAR_DISHES = [
  "고등어구이",
  "위샹로우스",
  "닭강정",
  "대패삼겹콩나물볶음",
  "동그랑땡",
  "왕교자튀김",
  "고추장삼겹",
  "만두튀김초고추장무침",
  "탕수육",
  "새우튀김",
  "훈제오리무우쌈",
  "깐풍새우",
] as const;

export type ManualRecipeState = {
  recipes?: unknown;
  methods?: unknown;
  recipeAsk?: unknown;
};
export type PremiumDishProfile = DishProfile & {
  canonical: string;
  substantial: boolean;
  anchor: boolean;
  evidence: "recipe" | "known-dish" | "none";
};
export type PremiumDishProfiler = (name: string) => PremiumDishProfile;
type RecipeEvidenceIndex = {
  rows: Map<string, Record<string, unknown>[]>;
  methods: Set<string>;
  unresolved: Set<string>;
};

function manualCanonical(name: string): string {
  const normalized = normalizedDishName(name);
  return /^(위샹로우쓰|위샹로우스)$/.test(normalized)
    ? "위샹로우스"
    : canonicalDish(name);
}

/** Indexed, snapshot-local profiler; no global cache can outlive a manual edit. */
export function createPremiumDishProfiler(
  state?: ManualRecipeState,
): PremiumDishProfiler {
  const index: RecipeEvidenceIndex = {
    rows: new Map(),
    methods: new Set(),
    unresolved: new Set(),
  };
  for (const row of Array.isArray(state?.recipes) ? state.recipes : []) {
    if (!row || typeof row !== "object") continue;
    const key = manualCanonical(String(row.menu || ""));
    if (!key) continue;
    const group = index.rows.get(key) || [];
    group.push(row as Record<string, unknown>);
    index.rows.set(key, group);
  }
  for (const [dish, text] of Object.entries(objectMap(state?.methods))) {
    if (String(text || "").trim()) index.methods.add(manualCanonical(dish));
  }
  for (const dish of Object.keys(objectMap(state?.recipeAsk))) {
    index.unresolved.add(manualCanonical(dish));
  }
  const profiles = new Map<string, PremiumDishProfile>();
  return (name) => {
    const key = String(name || "").trim();
    let profile = profiles.get(key);
    if (!profile) {
      profile = profileFromEvidence(key, index);
      profiles.set(key, profile);
    }
    return profile;
  };
}

const FRESH_ANIMAL =
  /(돼지|돈육|소고기|쇠고기|우육|차돌|양지|사태|홍두깨|채끝|우둔|설도|삼겹|목살|앞다리|뒷다리|갈비|등심|안심|닭|치킨|오리|돈까스|돈가스|탕수육|생선|고등어|삼치|가자미|갈치|임연수|이면수|도미|열기|메기|황태|북어|명태|코다리|동태|대구|조기|굴비|아귀|우럭|연어|오징어|낙지|쭈꾸미|주꾸미|새우|꼬막|바지락|홍합|조갯살|굴(?!소스)|꽃게|게살)/;
const SUPPORT_PROTEIN =
  /(두부|계란|달걀|난액|만두|교자|동그랑땡|완자|소시지|소세지|햄|베이컨|떡갈비|너비아니|함박)/;
const GARNISH =
  /(육수|소스|액젓|분말|가루|엑기스|다시다|건새우|멸치|진미채|북어채|어묵|맛살|젓$|젓갈$)/;
const SEASONING =
  /^(물|정제수)$|소금|설탕|식초|후추|간장|고추장|된장|전분|가루|기름|깨|마요네즈|케첩|소스|육수|액젓/;
const COOKING =
  /(볶음|구이|조림|찜|수육|보쌈|튀김|강정|불고기|갈비|가스|까스|커틀릿|스테이크|전$|부침|말이|무침|숙회|쌈$|초무침|토핑$)/;
const SPECIAL_MAINS =
  /(위샹로우스|위샹로우쓰|동그랑땡|왕교자|군만두|만두튀김|고추장삼겹|유린기|깐풍기|깐풍육|깐쇼새우|깐풍새우|칠리새우|탕수육|마파두부|양장피|팔보채|유산슬|난자완스|라조기|양념치킨|경장육슬|동파육|꿔바로우)/;
const NON_MAIN_OFFERING =
  /콜라|사이다|주스|쥬스|커피|라떼|아이스티|에이드|보리차|생수|^우유$|^두유$|젓$|젓갈$|국물$|육수$|정식$|^(쌈장|양념장|초고추장)$|불닭볶음면|짜파게티|신라면|진라면|너구리라면/;

function objectMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function inferProtein(name: string): string | undefined {
  if (
    /돼지|돈육|삼겹|목살|제육|위샹로우|탕수육|깐풍육|경장육슬|동파육|꿔바로우|난자완스/
      .test(name)
  ) {
    return "pork";
  }
  if (
    /소고기|쇠고기|우육|소불고기|육전|차돌|양지|사태|홍두깨|채끝|우둔|설도/
      .test(name)
  ) {
    return "beef";
  }
  if (/닭|치킨|유린기|깐풍기/.test(name)) return "chicken";
  if (/오리/.test(name)) return "duck";
  if (
    /고등어|삼치|가자미|갈치|임연수|이면수|도미|열기|메기|황태|북어|명태|코다리|동태|대구|조기|굴비|아귀|우럭|연어|생선/
      .test(name)
  ) return "fish";
  if (/오징어/.test(name)) return "squid";
  if (/낙지|쭈꾸미|주꾸미/.test(name)) return "octopus";
  if (/새우/.test(name)) return "shrimp";
  if (/꼬막|바지락|홍합|조갯살|굴(?!소스)/.test(name)) return "shellfish";
  if (/두부/.test(name)) return "tofu";
  if (/계란|달걀|난액/.test(name)) return "egg";
  if (/만두|교자/.test(name)) return "dumpling";
  if (/동그랑땡|완자|소시지|소세지|햄|베이컨|떡갈비|너비아니|함박/.test(name)) {
    return "processed-meat";
  }
  if (/스테이크/.test(name)) return "beef";
  return undefined;
}
function inferMethod(name: string): string | undefined {
  if (
    /강정|튀김|가스|까스|커틀릿|유린기|깐풍|깐쇼|탕수|꿔바로우|라조기/.test(
      name,
    )
  ) {
    return "fry";
  }
  if (/수육|보쌈/.test(name)) return "boil";
  if (/볶음|불고기|위샹|경장육슬|팔보채|유산슬/.test(name)) return "stir-fry";
  if (/조림|갈비찜|동파육|난자완스/.test(name)) return "braise";
  if (/찜/.test(name)) return "steam";
  if (/구이|스테이크|고추장삼겹/.test(name)) return "roast";
  if (/말이|동그랑땡|전$|부침/.test(name)) return "pan-fry";
  if (/무침|숙회|쌈$/.test(name)) return "mix";
  return undefined;
}
function inferSeasoning(name: string): string {
  if (/고추장|매콤|매운|제육|두루치기/.test(name)) return "gochujang";
  if (/간장/.test(name)) return "soy";
  if (/굴소스/.test(name)) return "oyster";
  if (/김치/.test(name)) return "kimchi";
  if (/칠리/.test(name)) return "chili";
  if (/강정|깐풍/.test(name)) return "sweet-spicy";
  if (/탕수/.test(name)) return "sweet-sour";
  if (/훈제/.test(name)) return "smoked";
  return "plain";
}
function gramQuantity(row: Record<string, unknown>): number {
  const quantity = Number(row.qty);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  const unit = String(row.unit || "g").trim().toLowerCase();
  if (unit === "kg" || unit === "킬로그램") return quantity * 1000;
  if (unit === "g" || unit === "그램") return quantity;
  if (/^(ea|개|알)$/.test(unit)) {
    const item = String(row.item || "");
    if (/계란|달걀/.test(item)) return quantity * 50;
    if (/왕교자|만두|교자/.test(item)) return quantity * 35;
  }
  return 0;
}

/** Actual ingredients override an attractive name; a teaspoon of meat is not a main. */
export function premiumDishProfile(
  value: string,
  state?: ManualRecipeState,
): PremiumDishProfile {
  return createPremiumDishProfiler(state)(value);
}

function profileFromEvidence(
  value: string,
  index: RecipeEvidenceIndex,
): PremiumDishProfile {
  const name = String(value || "").trim();
  const normalized = normalizedDishName(name);
  const original = dishProfile(name);
  const canonical = manualCanonical(name);
  const empty: PremiumDishProfile = {
    ...original,
    canonical,
    substantial: false,
    anchor: false,
    evidence: "none",
  };
  if (!name) return empty;
  try {
    assertMealMenuAllowed(name);
  } catch {
    return empty;
  }
  if (index.unresolved.has(canonical)) return empty;
  if (NON_MAIN_OFFERING.test(normalized)) return empty;
  if (["soup", "kimchi", "rice"].includes(original.kind)) return empty;
  if (
    /덮밥|볶음밥|비빔밥|라이스/.test(normalized) && !/토핑/.test(normalized)
  ) return empty;
  // Stock noodles, starch, salad and garnish-only dried seafood cannot be
  // promoted just by calling them a main or placing them in an extra column.
  if (
    /^(감자튀김|야채튀김|채소튀김|고구마튀김|과일|요구르트|요거트)$|(?:나물|장아찌|피클|샐러드)$|멸치|진미채|건새우/
      .test(normalized)
  ) return empty;

  const rows = index.rows.get(canonical) || [];
  const protein = original.protein ?? inferProtein(normalized);
  const method = original.method ?? inferMethod(normalized);
  const seasoning = original.seasoning ?? inferSeasoning(normalized);
  const clearlyNamedMain = original.kind === "main" ||
    SPECIAL_MAINS.test(normalized);
  const recognizableMain = clearlyNamedMain ||
    ((Boolean(protein) || FRESH_ANIMAL.test(normalized) ||
      SUPPORT_PROTEIN.test(normalized)) && COOKING.test(normalized)) ||
    // Generic 고기 is only a recognizable title with an actual registered
    // recipe. Its animal anchor is established below from ingredient amounts,
    // never guessed from an unregistered "고기" label.
    (rows.length > 0 && /고기/.test(normalized) && COOKING.test(normalized));
  if (rows.length) {
    if (!index.methods.has(canonical)) return { ...empty, evidence: "recipe" };
    let freshMass = 0, proteinMass = 0, foodMass = 0;
    const ingredients: string[] = [];
    for (const row of rows) {
      const item = String(row.item || "").trim();
      const mass = gramQuantity(row);
      if (!item || !mass || GARNISH.test(item)) continue;
      const fresh = FRESH_ANIMAL.test(item),
        support = SUPPORT_PROTEIN.test(item);
      // 홍두깨살 contains the syllable 깨 but is beef, not sesame seasoning.
      if (!fresh && !support && SEASONING.test(item)) continue;
      foodMass += mass;
      if (fresh) {
        freshMass += mass;
        proteinMass += mass;
        ingredients.push(item);
      } else if (support) {
        proteinMass += mass;
        ingredients.push(item);
      }
    }
    // Minimal anti-garnish safeguards, not nutritional targets or serving claims.
    // A vegetable side with some tofu/meat remains a side. An unfamiliar recipe
    // must visibly center protein, rather than gain main status from its comp
    // label or a handful of protein folded into a larger vegetable/starch dish.
    const substantial = recognizableMain && proteinMass >= 40 &&
      (clearlyNamedMain || freshMass >= 80 || proteinMass >= foodMass * 0.5);
    const anchor = substantial && freshMass >= 30 &&
      !/^(dumpling|processed-meat|tofu|egg)$/.test(protein || "");
    return {
      ...empty,
      kind: substantial ? "main" : original.kind,
      protein: protein ?? inferProtein(ingredients.join(" ")),
      method,
      seasoning,
      substantial,
      anchor,
      evidence: "recipe",
    };
  }
  const substantial = recognizableMain;
  const anchor = substantial && (FRESH_ANIMAL.test(normalized) ||
    /^(pork|beef|chicken|duck|fish|squid|octopus|shrimp|shellfish|pork-seafood|mixed-meat|tofu-pork)$/
      .test(protein || "")) &&
    !/^(dumpling|processed-meat|tofu|egg)$/.test(protein || "");
  return {
    ...empty,
    kind: substantial ? "main" : original.kind,
    protein,
    method,
    seasoning,
    substantial,
    anchor,
    evidence: substantial ? "known-dish" : "none",
  };
}

/** Audit a completed meal only. Incremental variety checks must remain separate. */
export function menuManualViolations(
  slots: Record<string, string>,
  extras: string[] = [],
  state?: ManualRecipeState,
  profile: PremiumDishProfiler = createPremiumDishProfiler(state),
): string[] {
  const violations: string[] = [];
  const mains = ["2", "7"].map((slot) => profile(slots[slot]));
  for (const [index, profile] of mains.entries()) {
    if (!profile.substantial) {
      violations.push(
        `메인${index + 1}에는 실제 단백질 중심 주찬이 필요합니다 (${
          slots[index === 0 ? "2" : "7"] || "비어 있음"
        })`,
      );
    }
  }
  if (mains[0].canonical && mains[0].canonical === mains[1].canonical) {
    violations.push("메인1·메인2는 서로 다른 음식이어야 합니다");
  }
  if (!mains.some((profile) => profile.anchor)) {
    violations.push(
      "메인1·메인2 중 적어도 하나는 고기·생선·해물 중심의 확실한 주찬이어야 합니다",
    );
  }
  const dishes = [
    ...["2", "7", "3", "4", "8"].map((slot) => slots[slot]),
    ...extras,
  ];
  const substantial = new Set(
    dishes.map((dish) => profile(dish)).filter((profile) => profile.substantial)
      .map((profile) => profile.canonical),
  );
  if (substantial.size < 3) {
    violations.push(
      "만원 식단은 서로 다른 메인급 음식 3개가 필요합니다. 부찬 또는 추가 메뉴에 고기·생선·해물·달걀·두부·고기만두 중심의 추가 주찬을 넣으세요 (채소·감자튀김·후식으로 대체 불가)",
    );
  }
  return violations;
}

export function assertManualMeal(
  slots: Record<string, string>,
  extras: string[] = [],
  state?: ManualRecipeState,
  location = "식단",
  profile?: PremiumDishProfiler,
): void {
  const violations = menuManualViolations(slots, extras, state, profile);
  if (violations.length) {
    throw new Error(
      `${location}: 식단 작성 매뉴얼 검증 실패 — ${violations.join("; ")}`,
    );
  }
}
