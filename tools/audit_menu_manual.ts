// Operational read-only audit. Never generates, saves, or changes live state.
import {
  decryptText,
  type State,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
import {
  createPremiumDishProfiler,
  MENU_MANUAL_VERSION,
  menuManualViolations,
} from "../supabase/functions/_shared/menu-manual.ts";
const password = Deno.env.get("NMF_PW");
if (!password) throw new Error("NMF_PW required");
const todayIndex = Deno.args.indexOf("--today");
const today = Deno.args[todayIndex + 1];
if (todayIndex < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  throw new Error("--today YYYY-MM-DD required");
}
const source = await Deno.readTextFile(
  new URL("../nmf_cloud.mjs", import.meta.url),
);
const key = source.match(/const KEY =\s*"([^"]+)"/)?.[1],
  origin = source.match(/const URL_ =\s*"([^"]+)"/)?.[1];
if (!key || !origin) throw new Error("Cloud configuration unavailable");
async function load(id: string) {
  const response = await fetch(
    `${origin}/rest/v1/namofood_state?id=eq.${
      encodeURIComponent(id)
    }&select=id,data,updated_at`,
    { headers: { apikey: key!, Authorization: `Bearer ${key}` } },
  );
  if (!response.ok) {
    throw new Error(`Read-only cloud query failed ${response.status}`);
  }
  const [row] = await response.json();
  if (!row) throw new Error(`Snapshot unavailable ${id}`);
  return {
    updated: row.updated_at,
    state: JSON.parse(await decryptText(password!, row.data)) as State,
  };
}
const current = await load("namofood"), violations = [], examples = [];
const profile = createPremiumDishProfiler(current.state);
let aiMeals = 0;
for (const [mk, meta] of Object.entries(current.state.menuPlanMeta || {})) {
  const [date, meal] = mk.split("|");
  if (date < today || meta.by !== "ai") continue;
  aiMeals++;
  const ym = date.slice(0, 7),
    day = String(Number(date.slice(8))),
    slots: Record<string, string> = {},
    extras: string[] = [];
  for (const [key, value] of Object.entries(current.state.menus?.[ym] || {})) {
    if (
      !key.startsWith(`${day}|${meal}|`) || typeof value !== "string" ||
      !value.trim()
    ) continue;
    const slot = key.split("|")[2];
    if (["1", "2", "7", "3", "4", "8"].includes(slot)) slots[slot] = value;
    else if (/^\d+$/.test(slot) && Number(slot) > 0) extras.push(value);
  }
  const reasons = menuManualViolations(slots, extras, current.state, profile);
  if (reasons.length) violations.push({ meal: mk, reasons });
  if (examples.length < 8) {
    examples.push({
      meal: mk,
      main1: slots["2"],
      main2: slots["7"],
      upgrade: [slots["3"], slots["4"], ...extras].filter((name) =>
        name && profile(name).substantial
      ),
    });
  }
}
const baselineIndex = Deno.args.indexOf("--baseline"),
  verification: Record<string, unknown> = {};
if (baselineIndex >= 0) {
  const baseline = await load(Deno.args[baselineIndex + 1]);
  const old = baseline.state, now = current.state;
  const changedFood = [],
    changedProtected = [],
    changedManual = [],
    changedPast = [];
  for (
    const ym of new Set([
      ...Object.keys(old.menus || {}),
      ...Object.keys(now.menus || {}),
    ])
  ) {
    for (
      const key of new Set([
        ...Object.keys(old.menus?.[ym] || {}),
        ...Object.keys(now.menus?.[ym] || {}),
      ])
    ) {
      if (
        JSON.stringify(old.menus?.[ym]?.[key]) ===
          JSON.stringify(now.menus?.[ym]?.[key])
      ) continue;
      const [d, meal, slot] = key.split("|"),
        date = `${ym}-${d.padStart(2, "0")}`,
        full = `${date}|${meal}|${slot}`;
      changedFood.push(full);
      if (["n", "0"].includes(slot)) changedProtected.push(full);
      if (date < today) changedPast.push(full);
      if (old.menuPlanMeta?.[`${date}|${meal}`]?.by !== "ai") {
        changedManual.push(full);
      }
    }
  }
  const unchangedFields = [
    ...new Set([...Object.keys(old), ...Object.keys(now)]),
  ].filter((field) => !["menus", "menuPlanMeta", "updatedAt"].includes(field));
  const changedOtherFields = unchangedFields.filter((field) =>
    JSON.stringify(old[field]) !== JSON.stringify(now[field])
  );
  verification.changedFood = changedFood.length;
  verification.changedCountsOrRice = changedProtected;
  verification.changedManual = changedManual;
  verification.changedPast = changedPast;
  verification.changedOtherFields = changedOtherFields;
  verification.recipesUnchanged =
    JSON.stringify(old.recipes) === JSON.stringify(now.recipes);
  if (
    changedProtected.length || changedManual.length || changedPast.length ||
    changedOtherFields.length
  ) throw new Error(`Protected data changed: ${JSON.stringify(verification)}`);
}
console.log(
  JSON.stringify({
    policy: MENU_MANUAL_VERSION,
    updated: current.updated,
    aiMeals,
    violations,
    examples,
    verification,
    productionWrites: 0,
  }),
);
if (violations.length) Deno.exitCode = 1;
