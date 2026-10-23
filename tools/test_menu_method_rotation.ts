import {
  methodConflict,
  referenceDishes,
  rotateExistingMains,
} from "../supabase/functions/_shared/menu-rotation.ts";
const assert = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
const profiles: Record<string, { slotGroup: string; method: string }> = {};
for (
  const [g, m, n] of [
    ["고기", "볶음", "제육"],
    ["고기", "삶음", "수육"],
    ["생선", "구이", "생선구이"],
    ["생선", "조림", "생선조림"],
    ["기타 주찬", "튀김", "만두튀김"],
    ["기타 주찬", "찜", "계란찜"],
  ]
) profiles[n] = { slotGroup: g, method: m };
const reference = {
  "12|중식|2": "제육",
  "12|중식|7": "생선구이",
  "12|중식|8": "만두튀김",
  "13|중식|2": "수육",
  "13|중식|7": "생선조림",
  "13|중식|8": "계란찜",
};
const before = {
  menus: {
    "2026-10": {
      ...reference,
      "26|중식|n": 123,
      "26|중식|0": "쌀밥",
      "26|중식|1": "국",
      "26|중식|3": "무침",
      "26|석식|3": "무침",
      "26|중식|2": "제육",
      "26|중식|7": "생선구이",
      "26|중식|8": "만두튀김",
      "26|석식|2": "제육",
      "26|석식|7": "생선구이",
      "26|석식|8": "만두튀김",
    },
  },
  sales: { preserve: 99 },
};
const r = rotateExistingMains(
  before,
  (n) => profiles[n],
  "2026-10-26",
  "2027-06-30",
);
assert(r.blocked.length === 0, "feasible reference rotation");
assert(r.changes.length === 3, "minimum three repeated main methods change");
for (const c of r.changes) {
  assert(referenceDishes(before).has(c.after), "no invented dish");
}
assert(
  JSON.stringify(r.after.sales) === JSON.stringify(before.sales),
  "financial state unchanged",
);
for (const [k, v] of Object.entries(before.menus["2026-10"])) {
  if (!/^26\|(?:중식|석식)\|(?:2|7|8)$/.test(k)) {
    assert(
      r.after.menus!["2026-10"][k] === v,
      "reference/rice/soup/sides/headcounts unchanged",
    );
  }
}
assert(
  !methodConflict({ slotGroup: "고기", method: "구이" }, {
    slotGroup: "생선",
    method: "구이",
  }, false),
  "different ingredients may cross methods between meals",
);
assert(
  methodConflict({ slotGroup: "고기", method: "구이" }, {
    slotGroup: "생선",
    method: "구이",
  }, true),
  "same meal mains must differ",
);
assert(
  rotateExistingMains(r.after, (n) => profiles[n], "2026-10-26", "2027-06-30")
    .changes.length === 0,
  "repeat operation is idempotent",
);
console.log(
  "MENU_METHOD_ROTATION_MINIMAL_THREE_REFERENCE_ONLY_PROTECTED_FIELDS_CROSS_METHOD_IDEMPOTENT_OK",
);
