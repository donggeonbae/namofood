import {
  buildPrompt,
  recipeCandidateDishes,
} from "../supabase/functions/nmf-menu-plan/lib.ts";

const state = {
  recipes: [
    { menu: "새로운도미구이", comp: "주찬", item: "도미", qty: 150 },
    { menu: "새로운도미구이", comp: "주찬", item: "소금", qty: 1 },
    { menu: "제육볶음", comp: "주찬", item: "돈육", qty: 150 },
    { menu: "아욱국", comp: "국", item: "아욱", qty: 50 },
    { menu: "콩나물무침", comp: "부찬", item: "콩나물", qty: 60 },
    { menu: "배추김치", comp: "김치", item: "김치", qty: 60 },
    { menu: "미완성찬", comp: "주찬", item: "", qty: 0 },
    { menu: "조리법없는찬", comp: "주찬", item: "닭고기", qty: 100 },
    { menu: "쌀밥", comp: "밥", item: "쌀", qty: 100 },
    { menu: "맥주", comp: "주찬", item: "맥주", qty: 300 },
    { menu: "확인필요한메뉴", comp: "주찬", item: "돼지고기", qty: 120 },
    { menu: "콜라", comp: "주찬", item: "돼지고기", qty: 120 },
    { menu: "오징어젓", comp: "주찬", item: "오징어", qty: 120 },
    { menu: "불닭볶음면", comp: "주찬", item: "닭고기", qty: 120 },
    { menu: "새우튀김듬뿍우동국물", comp: "주찬", item: "새우", qty: 120 },
    { menu: "돈까스정식", comp: "주찬", item: "돼지고기", qty: 120 },
  ],
  methods: {
    새로운도미구이: "100명 기준 분할 조리 작업서",
    제육볶음: "기존 수동 조리법",
    아욱국: "국 조리법",
    콩나물무침: "부찬 조리법",
    배추김치: "배식 절차",
    미완성찬: "이름만 존재",
    쌀밥: "쌀밥 조리법",
    맥주: "주류",
    확인필요한메뉴: "자동으로 작성된 임시 조리법",
    콜라: "잘못 등록된 조리법",
    오징어젓: "곁들이 양념",
    불닭볶음면: "인스턴트 면",
    새우튀김듬뿍우동국물: "잘못된 음식명",
    돈까스정식: "단품 아닌 식사 전체",
  },
  recipeMeta: { 새로운도미구이: { cookingProfile: "institutional-v1" } },
  recipeAsk: { 확인필요한메뉴: { reason: "음식명 확인이 필요함" } },
};
const before = JSON.stringify(state);
const candidates = recipeCandidateDishes(state);
function eq(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error("candidate mismatch");
  }
}
eq(candidates.mains, ["새로운도미구이", "제육볶음"]);
eq(candidates.soups, ["아욱국"]);
eq(candidates.sides, ["배추김치", "콩나물무침"]);
eq(JSON.stringify(state), before);
const prompt = buildPrompt(
  ["2026-10-23"],
  ["조식", "중식", "석식", "야식"],
  {},
  {},
  "",
  "",
  candidates,
);
if (!prompt.includes("새로운도미구이") || !prompt.includes("등록된 레시피")) {
  throw Error("catalog not given to model");
}
eq(recipeCandidateDishes({}), { mains: [], soups: [], sides: [] });
console.log(
  "RECIPE_MENU_CANDIDATES_OK / COMPLETE_FOOD_ONLY / INSTITUTIONAL_FIRST / NO_MUTATION / PROMPT_BANK",
);
