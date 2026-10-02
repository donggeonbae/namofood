// Read-only production recovery evidence. Baseline remains encrypted.
// NMF_PW=... deno run -A tools/audit_daily_menu_recovery.ts --compare /tmp/baseline.json
import {
  decryptText,
  type MenuPlan,
  SLOT_INDICES,
  type State,
  validateMenuVariety,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
import { missingList } from "../supabase/functions/nmf-recipe-fill/lib.ts";
const password = Deno.env.get("NMF_PW");
if (!password) throw new Error("NMF_PW required");
const source = await Deno.readTextFile(
  new URL("../nmf_cloud.mjs", import.meta.url),
);
const key = source.match(/const KEY =\s*"([^"]+)"/)![1];
const response = await fetch(
  "https://rycibsczsgbkgtwfxyim.supabase.co/rest/v1/namofood_state?id=eq.namofood&select=data,updated_at",
  { headers: { apikey: key, Authorization: "Bearer " + key } },
);
if (!response.ok) throw new Error("read " + response.status);
const [row] = await response.json();
const state: State = JSON.parse(await decryptText(password, row.data));
const dates = ["2026-10-15", "2026-10-16"],
  meals = ["조식", "중식", "석식", "야식"];
const coverage = dates.map((date) => ({
  date,
  meals: meals.map((meal) => ({
    meal,
    complete: SLOT_INDICES.every((slot) =>
      String(
        state.menus?.[date.slice(0, 7)]
          ?.[`${Number(date.slice(8))}|${meal}|${slot}`] || "",
      ).trim()
    ),
    ai: state.menuPlanMeta?.[`${date}|${meal}`]?.by === "ai",
  })),
}));
const report: Record<string, unknown> = {
  updatedAt: row.updated_at,
  coverage,
  missingRecipes: missingList(state).map((x) => x.menu),
};
if (Deno.args[0] === "--compare") {
  const baseline = JSON.parse(await Deno.readTextFile(Deno.args[1]));
  const before: State = JSON.parse(await decryptText(password, baseline.data));
  const changedCells: string[] = [],
    overwrittenCells: string[] = [],
    changedCounts: string[] = [];
  for (
    const month of new Set([
      ...Object.keys(before.menus || {}),
      ...Object.keys(state.menus || {}),
    ])
  ) {
    const old = before.menus?.[month] || {},
      current = state.menus?.[month] || {};
    for (
      const cell of new Set([...Object.keys(old), ...Object.keys(current)])
    ) {
      if (old[cell] === current[cell]) continue;
      const [day, meal, slot] = cell.split("|"),
        date = `${month}-${String(Number(day)).padStart(2, "0")}`,
        full = `${date}|${meal}|${slot}`;
      changedCells.push(full);
      if (slot === "n") changedCounts.push(full);
      if (old[cell] !== undefined || !dates.includes(date)) {
        overwrittenCells.push(full);
      }
    }
  }
  const plan: MenuPlan = {
    days: dates.map((date) => ({
      date,
      meals: meals.map((meal) => ({
        meal,
        slots: Object.fromEntries(
          SLOT_INDICES.map(
            (slot) => [
              slot,
              String(
                state.menus?.[date.slice(0, 7)]
                  ?.[`${Number(date.slice(8))}|${meal}|${slot}`] || "",
              ),
            ],
          ),
        ),
        extras: Object.entries(state.menus?.[date.slice(0, 7)] || {}).filter((
          [cell],
        ) =>
          cell.startsWith(`${Number(date.slice(8))}|${meal}|`) &&
          Number(cell.split("|")[2]) >= 10
        ).map(([, value]) => String(value)),
      })),
    })),
  };
  validateMenuVariety(before, plan);
  const stableKeys = [
    "settings",
    "staff",
    "headcountMeta",
    "prices",
    "fixed",
    "consum",
    "roster",
  ];
  const protectedChanged = stableKeys.filter((k) =>
    JSON.stringify(before[k]) !== JSON.stringify(state[k])
  );
  report.verification = {
    addedCells: changedCells.length,
    overwrittenCells,
    changedCounts,
    protectedChanged,
    adjacentWeekVariety: true,
  };
  if (
    overwrittenCells.length || changedCounts.length || protectedChanged.length
  ) {
    throw new Error(
      "Protected data changed: " + JSON.stringify(report.verification),
    );
  }
}
console.log(JSON.stringify(report, null, 2));
