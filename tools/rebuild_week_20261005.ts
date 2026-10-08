// Historical one-off AI menu refresh. Production writes are permanently retired.
// Only Oct 5–11 meals still marked AI are changed; encrypted backup + CAS required.
import {
  decryptText,
  encryptText,
  type MenuPlan,
  type State,
  validateMenuVariety,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
import { missingList } from "../supabase/functions/nmf-recipe-fill/lib.ts";
if (Deno.args.includes("--apply")) {
  throw new Error(
    "AI 식단 작성은 종료되었습니다. 과거 식단 재생성 도구는 저장할 수 없습니다.",
  );
}
const meals = ["조식", "중식", "석식", "야식"];
// 국 | 메인1 | 메인2 | 부찬1 | 부찬2 | 김치 | 추가찬
const rows = [
  "북엇국|닭살카레볶음|베이컨감자오믈렛|연근조림|오이무침|배추김치|김구이",
  "시래기된장국|돼지고기수육|코다리조림|상추쌈|무말랭이|겉절이|양파장아찌",
  "소고기무국|육전|닭봉데리야끼구이|잡채|부추겉절이|깍두기|도토리묵무침",
  "짬뽕국|향라육슬|갈릭버터새우튀김|중국식감자채볶음|양배추피클|배추김치|콘샐러드",
  "감자국|차슈슬라이스|참치야채볶음|시금치나물|진미채무침|깍두기|연두부",
  "콩나물국|돼지갈비찜|오징어튀김|쫄면무침|브로콜리초장|배추김치|우엉조림",
  "순두부찌개|대파닭다리살볶음|열기구이|감자조림|미역초무침|열무김치|꽈리고추멸치볶음",
  "크림스프|함박스테이크|치즈계란말이|마카로니샐러드|양배추샐러드|배추김치|어니언링",
  "소고기미역국|닭간장조림|두부스테이크|버섯볶음|콩나물무침|깍두기|김자반",
  "어묵국|소불고기|생선까스|감자채볶음|오이무침|배추김치|잡채",
  "꽃게된장국|LA갈비구이|꼬막무침|상추겉절이|콩자반|배추김치|부추전",
  "계란파국|위샹로우스|새우완자전|청경채나물|단무지무침|깍두기|궁중떡볶이",
  "시금치된장국|돈민찌두부조림|메추리꽈리고추장조림|무나물|어묵볶음|배추김치|김구이",
  "들깨무채국|훈제오리무우쌈|깐풍새우|부추무침|감자샐러드|겉절이|도라지오이무침",
  "차돌된장찌개|차돌박이구이|쭈꾸미볶음|양파초절임|숙주나물|배추김치|청포묵무침",
  "유부장국|치킨마요덮밥토핑|모둠소시지구이|코울슬로|오이피클|깍두기|고구마튀김",
  "콩비지찌개|돈육김치볶음|햄치즈프리타타|미역줄기무침|연근조림|깍두기|브로콜리초장",
  "오징어무국|소고기고추잡채|생선튀김|짜장소스|양배추샐러드|배추김치|꽃빵",
  "닭곰탕|오리주물럭|두부맛살부침|무쌈|참나물무침|겉절이|베이컨감자볶음",
  "미소된장국|치즈불닭|감자베이컨그라탕|콘샐러드|양배추피클|깍두기|떡볶이",
  "청국장|청경채소고기볶음|명란계란찜|우엉조림|오이생채|배추김치|김자반",
  "뼈다귀해장국|매콤족발|오징어순대전|막국수무침|상추쌈|겉절이|마늘쫑멸치볶음",
  "김치콩나물국|돈육버섯불고기|가자미구이|감자채볶음|도토리묵무침|깍두기|호박전",
  "부대찌개|닭다리오븐구이|미트볼|마카로니샐러드|치커리양파무침|배추김치|옥수수튀김",
  "황태미역국|닭살양배추볶음|참치두부전|콩나물무침|진미채무침|열무김치|연두부",
  "순대국|동파육|해물볶음우동|부추겉절이|무생채|깍두기|버섯볶음",
  "육개장|우삼겹숙주볶음|아귀콩나물찜|양파장아찌|시금치나물|배추김치|단호박샐러드",
  "감자수제비국|매콤돈육강정|콘치즈부침|쫄면무침|오이크래미냉채|깍두기|김말이튀김",
];
const pw = Deno.env.get("NMF_PW");
if (!pw) throw Error("NMF_PW required");
const src = await Deno.readTextFile(
  new URL("../nmf_cloud.mjs", import.meta.url),
);
const key = src.match(/const KEY =\s*"([^"]+)"/)![1];
const api = "https://rycibsczsgbkgtwfxyim.supabase.co/rest/v1/namofood_state";
const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};
async function load() {
  const r = await fetch(api + "?id=eq.namofood&select=data,updated_at", {
    headers,
  });
  if (!r.ok) throw Error("read " + r.status);
  return (await r.json())[0];
}
const originalRow = await load(),
  original = JSON.parse(await decryptText(pw, originalRow.data)) as State;
const base = structuredClone(original),
  targets = new Set<string>(),
  preserved: string[] = [];
for (let d = 5; d <= 11; d++) {
  for (const meal of meals) {
    const mk = `2026-10-${String(d).padStart(2, "0")}|${meal}`;
    if (original.menuPlanMeta?.[mk]?.by !== "ai") {
      preserved.push(mk);
      continue;
    }
    targets.add(mk);
    for (const k of Object.keys(base.menus!["2026-10"])) {
      if (k.startsWith(`${d}|${meal}|`) && !k.endsWith("|n")) {
        delete base.menus!["2026-10"][k];
      }
    }
  }
}
const plan: MenuPlan = { days: [] };
for (let d = 5; d <= 11; d++) {
  const date = `2026-10-${String(d).padStart(2, "0")}`;
  const day = { date, meals: [] as MenuPlan["days"][number]["meals"] };
  for (let m = 0; m < 4; m++) {
    if (!targets.has(`${date}|${meals[m]}`)) continue;
    const [soup, main1, main2, side1, side2, kimchi, extra] =
      rows[(d - 5) * 4 + m].split("|");
    day.meals.push({
      meal: meals[m],
      slots: {
        "1": soup,
        "2": main1,
        "7": main2,
        "3": side1,
        "4": side2,
        "8": kimchi,
      },
      extras: [extra],
    });
  }
  plan.days.push(day);
}
validateMenuVariety(base, plan);
const result = structuredClone(base),
  at = new Date().toISOString(),
  runId = crypto.randomUUID();
for (const day of plan.days) {
  for (const meal of day.meals) {
    const d = Number(day.date.slice(-2)), month = result.menus!["2026-10"];
    for (
      const [slot, dish] of Object.entries(meal.slots)
    ) month[`${d}|${meal.meal}|${slot}`] = dish;
    month[`${d}|${meal.meal}|0`] = "쌀밥";
    month[`${d}|${meal.meal}|10`] = meal.extras![0];
    result.menuPlanMeta![`${day.date}|${meal.meal}`] = {
      by: "ai",
      updated: at,
      model: "codex-reviewed-weekly-rebuild",
      runId,
    };
  }
}
// No headcounts, non-target meals, or unrelated state may change.
for (const [ym, month] of Object.entries(original.menus || {})) {
  for (const [k, v] of Object.entries(month)) {
    const [d, meal, slot] = k.split("|"),
      mk = `${ym}-${d.padStart(2, "0")}|${meal}`;
    if (
      (!targets.has(mk) || slot === "n") &&
      JSON.stringify(result.menus?.[ym]?.[k]) !== JSON.stringify(v)
    ) {
      throw Error("Protected cell changed: " + mk + "|" + slot);
    }
  }
}
for (const k of Object.keys(original)) {
  if (
    !["menus", "menuPlanMeta", "updatedAt"].includes(k) &&
    JSON.stringify(original[k]) !== JSON.stringify(result[k])
  ) throw Error("Unrelated state changed: " + k);
}
console.log(
  JSON.stringify(
    {
      range: "2026-10-05..2026-10-11",
      meals: targets.size,
      preserved,
      missing: missingList(result).map((x) => x.menu),
      plan,
    },
    null,
    2,
  ),
);
if (Deno.args.includes("--apply")) {
  const backupId = "namofood@before-week-rebuild-" + at;
  const backup = await fetch(api, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: backupId,
      data: originalRow.data,
      updated_at: at,
    }),
  });
  if (!backup.ok) throw Error("Backup failed " + backup.status);
  result.updatedAt = at;
  const data = await encryptText(pw, JSON.stringify(result));
  const saved = await fetch(
    api + "?id=eq.namofood&updated_at=eq." +
      encodeURIComponent(originalRow.updated_at),
    {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ data, updated_at: at }),
    },
  );
  if (!saved.ok || (await saved.json()).length !== 1) {
    throw Error("Save conflict; nothing overwritten. Retry from fresh state.");
  }
  const verified = JSON.parse(await decryptText(pw, (await load()).data));
  for (const mk of targets) {
    const [date, meal] = mk.split("|"), d = Number(date.slice(-2));
    for (const [k, v] of Object.entries(result.menus!["2026-10"])) {
      if (k.startsWith(`${d}|${meal}|`) && verified.menus["2026-10"][k] !== v) {
        throw Error("Readback mismatch: " + mk);
      }
    }
  }
  console.log(
    "SAVED_AND_VERIFIED " + JSON.stringify({ meals: targets.size, backupId }),
  );
}
