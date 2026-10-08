// Dish identity is deliberately narrower than ingredient similarity. Pork soy
// stir-fry and pork gochujang stir-fry must remain different actual dishes.
export const INSTITUTIONAL_MENU_RULES = {
  mainRepeatDays: 7,
  soupSideWindowDays: 3,
  maxSoupSideOccurrences: 2,
  maxMainProfilePerDay: 2,
} as const;

export type DishProfile = {
  kind: "main" | "soup" | "side" | "kimchi" | "rice" | "unknown";
  protein?: string;
  method?: string;
  seasoning?: string;
};

export function normalizedDishName(value: string): string {
  // Korean uses default Unicode casing; avoid repeated ICU locale setup while
  // checking thousands of stored food cells against the surrounding week.
  return value.normalize("NFKC").toLowerCase()
    .replace(/[\s·ㆍ,()（）]/g, "");
}

type MainGroup = [string, string, string, string, ...string[]];
// Canonical dish, protein, cooking method, seasoning, then actual-dish aliases.
// Do not infer aliases just because two dishes use the same meat or equipment.
const MAIN_GROUPS: MainGroup[] = [
  [
    "제육볶음",
    "pork",
    "stir-fry",
    "gochujang",
    "제육",
    "돼지고기고추장볶음",
    "돈육고추장볶음",
    "고추장제육볶음",
    "매콤제육볶음",
    "매운제육볶음",
    "고추장불고기",
    "돼지고추장불고기",
    "돈육고추장불고기",
  ],
  [
    "돼지간장불고기",
    "pork",
    "stir-fry",
    "soy",
    "돼지고기간장불고기",
    "돈육간장불고기",
    "간장돼지불고기",
    "돼지불고기",
    "돈육불고기",
    "돼지고기불고기",
    "돈육간장볶음",
    "돼지고기간장볶음",
  ],
  ["돼지고기굴소스볶음", "pork", "stir-fry", "oyster", "돈육굴소스볶음"],
  [
    "돼지고기고추잡채",
    "pork",
    "stir-fry",
    "oyster",
    "돈육고추잡채",
    "고추잡채",
  ],
  [
    "돼지고기김치볶음",
    "pork",
    "stir-fry",
    "kimchi",
    "돈육김치볶음",
    "제육김치볶음",
  ],
  [
    "돼지두루치기",
    "pork",
    "stir-fry",
    "gochujang",
    "돈육두루치기",
    "돼지고기두루치기",
  ],
  [
    "오삼불고기",
    "pork-seafood",
    "stir-fry",
    "gochujang",
    "오징어삼겹살볶음",
    "오삼볶음",
  ],
  [
    "돈까스",
    "pork",
    "fry",
    "cutlet",
    "돈가스",
    "돼지고기커틀릿",
    "수제돈까스",
    "수제돈가스",
    "등심돈까스",
    "등심돈가스",
    "수제등심돈까스",
    "돼지등심수제돈까스",
    "돼지등심돈까스",
    "돼지안심돈까스",
    "안심돈까스",
  ],
  ["탕수육", "pork", "fry", "sweet-sour", "돈육탕수육", "돼지고기탕수육"],
  ["돼지갈비찜", "pork", "braise", "soy", "돈육갈비찜", "간장돼지갈비찜"],
  [
    "매운돼지갈비찜",
    "pork",
    "braise",
    "gochujang",
    "매콤돼지갈비찜",
    "돼지갈비고추장찜",
  ],
  ["돼지고기장조림", "pork", "braise", "soy", "돈육장조림", "돼지장조림"],
  [
    "보쌈",
    "pork",
    "boil",
    "plain",
    "돼지고기수육",
    "돈육수육",
    "돼지수육",
    "보쌈수육",
  ],
  ["삼겹살구이", "pork", "roast", "plain", "통삼겹오븐구이", "삼겹오븐구이"],
  [
    "고추장삼겹살구이",
    "pork",
    "roast",
    "gochujang",
    "고추장삼겹",
    "고추장삼겹구이",
    "고추장삼겹살",
  ],
  ["돼지고기고추장구이", "pork", "roast", "gochujang", "돈육고추장구이"],
  [
    "소불고기",
    "beef",
    "stir-fry",
    "soy",
    "소고기불고기",
    "우불고기",
    "소고기간장불고기",
    "우육불고기",
  ],
  ["소고기버섯볶음", "beef", "stir-fry", "soy", "우육버섯볶음"],
  ["소고기고추장볶음", "beef", "stir-fry", "gochujang", "우육고추장볶음"],
  ["소고기장조림", "beef", "braise", "soy", "우육장조림"],
  ["육전", "beef", "pan-fry", "plain", "소고기육전"],
  [
    "함박스테이크",
    "mixed-meat",
    "roast",
    "demiglace",
    "함박스테이크데미글라스소스",
  ],
  [
    "닭갈비",
    "chicken",
    "stir-fry",
    "gochujang",
    "닭고추장볶음",
    "닭고기고추장볶음",
    "매콤닭갈비",
    "매콤닭갈비볶음",
    "닭갈비볶음",
    "춘천닭갈비",
  ],
  [
    "닭간장볶음",
    "chicken",
    "stir-fry",
    "soy",
    "닭고기간장볶음",
    "간장닭갈비",
    "닭간장불고기",
  ],
  ["닭데리야끼볶음", "chicken", "stir-fry", "teriyaki", "닭고기데리야끼볶음"],
  [
    "닭볶음탕",
    "chicken",
    "braise",
    "gochujang",
    "닭도리탕",
    "매운닭찜",
    "닭고추장찜",
  ],
  ["안동찜닭", "chicken", "braise", "soy", "간장찜닭", "닭간장찜"],
  ["닭강정", "chicken", "fry", "sweet-spicy", "매콤닭강정", "양념닭강정"],
  [
    "닭튀김",
    "chicken",
    "fry",
    "plain",
    "후라이드치킨",
    "프라이드치킨",
    "닭순살튀김",
    "순살치킨",
  ],
  ["간장치킨", "chicken", "fry", "soy", "간장닭강정"],
  ["닭오븐구이", "chicken", "roast", "plain", "오븐닭구이", "닭다리오븐구이"],
  [
    "닭데리야끼구이",
    "chicken",
    "roast",
    "teriyaki",
    "데리야끼닭구이",
    "닭다리데리야끼구이",
  ],
  [
    "오리불고기",
    "duck",
    "stir-fry",
    "gochujang",
    "오리고추장불고기",
    "오리고추장볶음",
  ],
  ["훈제오리볶음", "duck", "stir-fry", "smoked", "훈제오리채소볶음"],
  ["훈제오리구이", "duck", "roast", "smoked", "훈제오리오븐구이"],
  ["고등어구이", "fish", "roast", "plain", "고등어소금구이"],
  ["삼치구이", "fish", "roast", "plain", "삼치소금구이"],
  ["갈치구이", "fish", "roast", "plain", "갈치소금구이"],
  ["가자미구이", "fish", "roast", "plain", "가자미소금구이"],
  ["임연수구이", "fish", "roast", "plain", "임연수소금구이", "임연수어구이"],
  ["고등어무조림", "fish", "braise", "chili", "고등어조림"],
  ["삼치무조림", "fish", "braise", "chili", "삼치조림"],
  ["갈치무조림", "fish", "braise", "chili", "갈치조림"],
  ["가자미조림", "fish", "braise", "soy", "가자미간장조림"],
  [
    "코다리조림",
    "fish",
    "braise",
    "chili",
    "코다리무조림",
    "코다리찜",
    "매콤코다리조림",
  ],
  [
    "생선까스",
    "fish",
    "fry",
    "cutlet",
    "생선가스",
    "생선커틀릿",
    "흰살생선까스",
    "수제생선까스",
    "수제생선가스",
  ],
  [
    "오징어볶음",
    "squid",
    "stir-fry",
    "gochujang",
    "오징어고추장볶음",
    "매콤오징어볶음",
  ],
  ["오징어초무침", "squid", "mix", "chogochujang", "오징어채소초무침"],
  ["꼬막무침", "shellfish", "mix", "soy"],
  ["오징어튀김", "squid", "fry", "plain"],
  ["낙지볶음", "octopus", "stir-fry", "gochujang", "낙지고추장볶음"],
  [
    "쭈꾸미볶음",
    "octopus",
    "stir-fry",
    "gochujang",
    "주꾸미볶음",
    "주꾸미고추장볶음",
  ],
  ["새우튀김", "shrimp", "fry", "plain", "왕새우튀김"],
  ["깐풍새우", "shrimp", "fry", "sweet-spicy"],
  ["칠리새우", "shrimp", "fry", "chili"],
  ["마파두부", "tofu-pork", "braise", "chili"],
  ["두부김치", "tofu-pork", "stir-fry", "kimchi"],
  ["두부조림", "tofu", "braise", "soy", "두부간장조림"],
  ["두부고추장조림", "tofu", "braise", "gochujang", "매콤두부조림"],
  [
    "계란말이",
    "egg",
    "pan-fry",
    "plain",
    "달걀말이",
    "채소계란말이",
    "야채계란말이",
  ],
  ["계란찜", "egg", "steam", "plain", "달걀찜", "채소계란찜"],
  ["계란장조림", "egg", "braise", "soy", "달걀장조림"],
  [
    "소시지채소볶음",
    "processed-meat",
    "stir-fry",
    "ketchup",
    "소세지야채볶음",
    "소시지야채볶음",
    "소세지채소볶음",
    "쏘야볶음",
    "비엔나소시지볶음",
  ],
  ["떡갈비구이", "mixed-meat", "roast", "soy", "떡갈비"],
  ["너비아니구이", "mixed-meat", "roast", "soy", "너비아니"],
];

const aliases = new Map<string, string>();
const profiles = new Map<string, DishProfile>();
for (const [dish, protein, method, seasoning, ...otherNames] of MAIN_GROUPS) {
  const canonical = normalizedDishName(dish);
  profiles.set(canonical, { kind: "main", protein, method, seasoning });
  for (const name of [dish, ...otherNames]) {
    aliases.set(normalizedDishName(name), canonical);
  }
}
for (
  const group of [
    ["소고기무국", "쇠고기무국", "소고기뭇국", "쇠고기뭇국"],
    ["미역국", "맑은미역국"],
    ["콩나물국", "맑은콩나물국"],
    ["계란국", "달걀국"],
    ["배추김치", "포기김치"],
    ["위샹로우스", "위샹로우쓰"],
  ]
) {
  for (const name of group) {
    aliases.set(normalizedDishName(name), normalizedDishName(group[0]));
  }
}

export function canonicalDish(value: string): string {
  const normalized = normalizedDishName(value);
  return aliases.get(normalized) ?? normalized;
}

/** A copy for read-only recommendation clients, including unsaved local menus. */
export function dishAliases(): Record<string, string> {
  return Object.fromEntries(aliases);
}

export function dishProfile(value: string): DishProfile {
  const name = canonicalDish(value);
  const known = profiles.get(name);
  if (known) return known;
  if (/^(쌀밥|흰밥|백미밥|밥)$/.test(name)) return { kind: "rice" };
  if (
    /^(배추김치|김치|깍두기|석박지|섞박지|총각김치|알타리김치|열무김치|갓김치|백김치|동치미|나박김치|오이소박이|배추겉절이|얼갈이겉절이)$/
      .test(name)
  ) return { kind: "kimchi" };
  if (/(국|탕|찌개|전골|스프|수프|육수|개장)$/.test(name)) {
    return { kind: "soup" };
  }
  // Recognize ordinary accompaniments without treating unfamiliar menu names as
  // invalid. Protein-centered cold dishes above are explicitly substantial mains.
  if (
    /(나물|무침|겉절이|샐러드|장아찌|피클|쌈|숙회)$/.test(name) ||
    /^(감자|연근|우엉|무|곤약|메추리알|검은콩|콩|땅콩|어묵|멸치|진미채|건새우|마늘종|애호박|가지|버섯|시래기|고사리|미역줄기).*(조림|볶음|찜)$/
      .test(name)
  ) {
    return { kind: "side" };
  }
  return { kind: "unknown" };
}

/** Undefined for unfamiliar dishes, so synthetic/legacy names are not guessed. */
export function mainProfileKey(value: string): string | undefined {
  const p = dishProfile(value);
  return p.kind === "main"
    ? `${p.protein}|${p.method}|${p.seasoning}`
    : undefined;
}

export function assertSubstantialMain(value: string, location: string): void {
  const kind = dishProfile(value).kind;
  if (
    kind === "side" || kind === "kimchi" || kind === "rice" || kind === "soup"
  ) {
    throw new Error(
      `${location}: 메인 슬롯에는 실속 있는 주찬이 필요합니다. ${value}는 국·밥·부찬을 대신 넣은 메뉴입니다`,
    );
  }
}

// Examples are inspiration for bulk-kitchen planning, never a finite allowlist.
export const INSTITUTIONAL_DISH_EXAMPLES = {
  mains: [
    "제육볶음",
    "돼지간장불고기",
    "돼지갈비찜",
    "안동찜닭",
    "닭오븐구이",
    "생선까스",
    "고등어무조림",
    "오징어볶음",
    "육전",
    "마파두부",
    "계란말이",
  ],
  soups: [
    "소고기무국",
    "시래기된장국",
    "콩나물국",
    "미역국",
    "북엇국",
    "아욱국",
    "닭곰탕",
    "어묵국",
    "순두부찌개",
    "오징어무국",
    "감자수제비국",
    "육개장",
  ],
  sides: [
    "도라지오이무침",
    "시금치나물",
    "숙주나물",
    "참나물무침",
    "미역초무침",
    "연근조림",
    "우엉조림",
    "어묵채볶음",
    "마늘종볶음",
    "가지볶음",
    "감자채볶음",
    "무생채",
    "배추김치",
  ],
} as const;
