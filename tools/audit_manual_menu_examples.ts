// Read-only evidence: compare preserved meals with earlier AI-marked snapshots.
import {
  decryptText,
  type State,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
const password = Deno.env.get("NMF_PW");
if (!password) throw new Error("NMF_PW required");
const source = await Deno.readTextFile(
  new URL("../nmf_cloud.mjs", import.meta.url),
);
const key = source.match(/const KEY =\s*"([^"]+)"/)?.[1];
const origin = source.match(/const URL_ =\s*"([^"]+)"/)?.[1];
if (!key || !origin) throw new Error("Cloud configuration unavailable");
const ids = [
  "namofood",
  "namofood@2026-10-07",
  "namofood@2026-10-04",
  "namofood@2026-10-01",
  "namofood@2026-09-28",
  "namofood@before-week-rebuild-2026-09-29T08:33:42.184Z",
];
const snapshots: Array<{ id: string; updated: string; state: State }> = [];
for (const id of ids) {
  const r = await fetch(
    `${origin}/rest/v1/namofood_state?id=eq.${
      encodeURIComponent(id)
    }&select=id,data,updated_at`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    },
  );
  if (!r.ok) throw new Error(`Read-only snapshot fetch failed ${r.status}`);
  const [row] = await r.json();
  if (row) {
    snapshots.push({
      id,
      updated: row.updated_at,
      state: JSON.parse(await decryptText(password, row.data)),
    });
  }
}
const current = snapshots[0];
const examples = [], ai = [];
function foods(state: State, date: string, meal: string) {
  const ym = date.slice(0, 7), d = String(Number(date.slice(8)));
  return Object.entries(state.menus?.[ym] || {}).filter(([k, v]) =>
    k.startsWith(`${d}|${meal}|`) && /\|[1-9][0-9]*$/.test(k) &&
    String(v ?? "").trim()
  ).sort(([a], [b]) => Number(a.split("|")[2]) - Number(b.split("|")[2])).map((
    [k, v],
  ) => ({ slot: k.split("|")[2], dish: v }));
}
for (const [ym, cells] of Object.entries(current.state.menus || {})) {
  const pairs = new Set(
    Object.keys(cells).map((k) => k.split("|").slice(0, 2).join("|")),
  );
  for (const pair of pairs) {
    const [d, meal] = pair.split("|"),
      date = `${ym}-${d.padStart(2, "0")}`,
      currentFoods = foods(current.state, date, meal);
    if (!currentFoods.length || date < "2026-09-24") continue;
    const meta = current.state.menuPlanMeta?.[`${date}|${meal}`];
    if (meta?.by === "ai") {
      if (date >= "2026-10-08") {
        ai.push({
          date,
          meal,
          foods: currentFoods,
          runId: meta.runId,
          model: meta.model,
          updated: meta.updated,
        });
      }
      continue;
    }
    const earlier = snapshots.slice(1).find((s) =>
      s.state.menuPlanMeta?.[`${date}|${meal}`]?.by === "ai" &&
      JSON.stringify(foods(s.state, date, meal)) !==
        JSON.stringify(currentFoods)
    );
    if (earlier || date <= "2026-10-12") {
      examples.push({
        date,
        meal,
        foods: currentFoods,
        confirmedEditedFromAI: !!earlier,
        earlierSnapshot: earlier?.id,
        previous: earlier ? foods(earlier.state, date, meal) : undefined,
      });
    }
  }
}
examples.sort((a, b) => a.date.localeCompare(b.date));
ai.sort((a, b) => a.date.localeCompare(b.date));
if (Deno.args.includes("--reviewed-today-ownership")) {
  const expected = {
    "석식": [
      "차돌된장찌개",
      "차돌박이구이",
      "쭈꾸미볶음",
      "양파초절임",
      "숙주나물",
      "배추김치",
      "청포묵무침",
    ],
    "야식": [
      "유부장국",
      "치킨마요덮밥토핑",
      "모둠소시지구이",
      "코울슬로",
      "오이피클",
      "깍두기",
      "고구마튀김",
    ],
  };
  const backup = snapshots.find((s) =>
    s.id.startsWith("namofood@before-week-rebuild-")
  );
  if (!backup) throw new Error("Retained reviewed rebuild backup unavailable");
  const owned: string[] = [], runIds = new Set<string>();
  for (const [meal, dishes] of Object.entries(expected)) {
    const mk = `2026-10-08|${meal}`, meta = current.state.menuPlanMeta?.[mk];
    if (
      meta?.by !== "ai" || meta.model !== "codex-reviewed-weekly-rebuild" ||
      Date.parse(meta.updated) !== Date.parse(backup.updated)
    ) throw new Error(`Reviewed provenance mismatch ${mk}`);
    const oldMeta = backup.state.menuPlanMeta?.[mk];
    if (oldMeta?.by !== "ai" || oldMeta.runId === meta.runId) {
      throw new Error(`Reviewed before-snapshot mismatch ${mk}`);
    }
    const slots = ["1", "2", "7", "3", "4", "8", "10"];
    for (let i = 0; i < slots.length; i++) {
      const actual = current.state.menus?.["2026-10"]
        ?.[`8|${meal}|${slots[i]}`];
      if (actual !== dishes[i]) {
        throw new Error(`Reviewed source/value mismatch ${mk}|${slots[i]}`);
      }
      owned.push(`${mk}|${slots[i]}`);
    }
    runIds.add(meta.runId);
  }
  if (runIds.size !== 1) throw new Error("Reviewed run mismatch");
  console.log(
    JSON.stringify({
      runAdded: { [[...runIds][0]]: owned },
      evidence: {
        source: "tools/rebuild_week_20261005.ts",
        before: backup.id,
        updated: backup.updated,
        cells: owned.length,
      },
    }),
  );
} else {
  console.log(
    JSON.stringify({
      updated: current.updated,
      snapshots: snapshots.map((s) => ({ id: s.id, updated: s.updated })),
      manualExamples: examples,
      upcomingAI: ai,
    }),
  );
}
