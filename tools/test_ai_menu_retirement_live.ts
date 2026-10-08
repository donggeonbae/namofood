// Read-only production audit against the verified encrypted retirement backup.
// Credentials and meal contents are never printed; no provider or write requests.
import {
  decryptText,
  type State,
} from "../supabase/functions/nmf-menu-plan/lib.ts";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const assert = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};
const password = Deno.env.get("NMF_PW");
const backupId = Deno.env.get("NMF_RETIREMENT_BACKUP");
assert(!!password && !!backupId, "NMF_PW and NMF_RETIREMENT_BACKUP required");
assert(
  backupId!.startsWith("namofood@before-ai-menu-retirement-"),
  "Unexpected backup scope",
);
const source = await Deno.readTextFile(
  new URL("../nmf_cloud.mjs", import.meta.url),
);
const key = source.match(/const KEY =\s*"([^"]+)"/)?.[1];
const origin = source.match(/const URL_ =\s*"([^"]+)"/)?.[1];
assert(!!key && !!origin, "Cloud configuration unavailable");
const load = async (id: string): Promise<State> => {
  const response = await fetch(
    `${origin}/rest/v1/namofood_state?id=eq.${
      encodeURIComponent(id)
    }&select=data`,
    {
      headers: { apikey: key!, Authorization: `Bearer ${key}` },
    },
  );
  assert(response.ok, `Read failed: ${response.status}`);
  const [row] = await response.json();
  assert(!!row?.data, "Encrypted row unavailable");
  return JSON.parse(await decryptText(password!, row.data));
};
const [before, after] = await Promise.all([load(backupId!), load("namofood")]);
const retirement = after.menuAutomation as {
  enabled?: boolean;
  removedCells?: Record<string, Record<string, unknown>>;
  removedMealKeys?: string[];
} | undefined;
const aiMeals = new Set(
  Object.entries(before.menuPlanMeta || {}).filter(([, meta]) =>
    meta.by === "ai"
  ).map(([key]) => key),
);
const changedCells: string[] = [];
let protectedMenuCells = 0, countCells = 0, riceCells = 0;
for (
  const month of new Set([
    ...Object.keys(before.menus || {}),
    ...Object.keys(after.menus || {}),
  ])
) {
  for (
    const key of new Set([
      ...Object.keys(before.menus?.[month] || {}),
      ...Object.keys(after.menus?.[month] || {}),
    ])
  ) {
    const [day, meal, slot] = key.split("|");
    const previous = before.menus?.[month]?.[key],
      current = after.menus?.[month]?.[key];
    if (slot === "n") countCells++;
    if (slot === "0") riceCells++;
    if (same(previous, current)) {
      protectedMenuCells++;
      continue;
    }
    assert(
      aiMeals.has(`${month}-${day.padStart(2, "0")}|${meal}`),
      "A non-AI meal changed",
    );
    assert(/^\d+$/.test(slot) && Number(slot) > 0, "Rice or headcount changed");
    assert(
      current === undefined && previous != null &&
        String(previous).trim() !== "",
      "Change is not an AI food deletion",
    );
    assert(
      same(retirement?.removedCells?.[month]?.[key], previous),
      "Exact removed-cell marker missing",
    );
    changedCells.push(`${month}|${key}`);
  }
}
const protectedFields = [];
for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (["menus", "menuPlanMeta", "menuAutomation", "updatedAt"].includes(key)) {
    continue;
  }
  assert(same(before[key], after[key]), `Protected field changed: ${key}`);
  protectedFields.push(key);
}
const expectedMeta = Object.fromEntries(
  Object.entries(before.menuPlanMeta || {}).filter(([, meta]) =>
    meta.by !== "ai"
  ),
);
assert(same(expectedMeta, after.menuPlanMeta), "Manual menu metadata changed");
assert(retirement?.enabled === false, "AI automation is not retired");
assert(
  Object.values(after.menuPlanMeta || {}).every((meta) => meta.by !== "ai"),
  "AI meal metadata remains",
);
assert(
  [...aiMeals].every((key) => retirement?.removedMealKeys?.includes(key)),
  "Retired meal marker missing",
);
console.log(JSON.stringify({
  readOnly: true,
  backupId,
  removedAIMeals: aiMeals.size,
  removedFoodCells: changedCells.length,
  protectedMenuCells,
  countCells,
  riceCells,
  protectedFields,
  recipesUnchanged: same(before.recipes, after.recipes),
  recipeMetadataUnchanged: same(before.recipeMeta, after.recipeMeta),
  remainingAIMeals: 0,
}));
