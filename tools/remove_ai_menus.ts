// Explicit user-requested retirement. Dry by default; never deletes recipes or counts.
import {
  decryptText,
  encryptText,
  type State,
} from "../supabase/functions/nmf-menu-plan/lib.ts";

type Row = { id: string; data: string; updated_at: string };
type Retirement = {
  enabled: false;
  disabledAt: string;
  policy: string;
  removedCells: Record<string, Record<string, unknown>>;
  removedMealKeys: string[];
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function planAIRetirement(before: State, disabledAt: string) {
  if (!Number.isFinite(Date.parse(disabledAt))) {
    throw new Error("A valid retirement timestamp is required");
  }
  const after = structuredClone(before);
  const prior = before.menuAutomation as Retirement | undefined;
  const retired: Retirement = {
    enabled: false,
    disabledAt: prior?.enabled === false ? prior.disabledAt : disabledAt,
    policy: "manual-menu-v1",
    removedCells: structuredClone(prior?.removedCells || {}),
    removedMealKeys: [...(prior?.removedMealKeys || [])],
  };
  const removedMeals: string[] = [], removedCells: string[] = [];
  for (const [mealKey, meta] of Object.entries(before.menuPlanMeta || {})) {
    if (meta.by !== "ai") continue;
    const match = /^(\d{4}-\d{2})-(\d{2})\|([^|]+)$/.exec(mealKey);
    if (!match || !["조식", "중식", "석식", "야식"].includes(match[3])) {
      throw new Error(`Unexpected AI meal key: ${mealKey}`);
    }
    const [, month, dayText, meal] = match, day = Number(dayText);
    const date = new Date(`${month}-${dayText}T00:00:00.000Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== `${month}-${dayText}`
    ) throw new Error(`Invalid AI date: ${mealKey}`);
    for (const [key, value] of Object.entries(before.menus?.[month] || {})) {
      const [d, m, slot] = key.split("|");
      if (
        Number(d) !== day || m !== meal || !/^\d+$/.test(slot) ||
        Number(slot) === 0
      ) continue;
      if (
        value === undefined || value === null || String(value).trim() === ""
      ) continue;
      retired.removedCells[month] ||= {};
      retired.removedCells[month][key] = structuredClone(value);
      delete after.menus![month][key];
      removedCells.push(`${month}|${key}`);
    }
    delete after.menuPlanMeta![mealKey];
    removedMeals.push(mealKey);
    if (!retired.removedMealKeys.includes(mealKey)) {
      retired.removedMealKeys.push(mealKey);
    }
  }
  // Metadata chooses the explicitly authorized meal unit; a manual edit clears its
  // AI metadata in menuSet. Non-AI meals and all n/0 cells remain byte-identical.
  const allowed = new Set(removedCells);
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
      if (
        !same(before.menus?.[month]?.[key], after.menus?.[month]?.[key]) &&
        !allowed.has(`${month}|${key}`)
      ) throw new Error(`Protected menu changed: ${month}|${key}`);
    }
  }
  after.menuAutomation = retired;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (
      !["menus", "menuPlanMeta", "menuAutomation"].includes(key) &&
      !same(before[key], after[key])
    ) throw new Error(`Protected field changed: ${key}`);
  }
  if (
    Object.values(after.menuPlanMeta || {}).some((meta) => meta.by === "ai")
  ) throw new Error("AI menu metadata survived retirement");
  return {
    after,
    removedMeals,
    removedCells,
    changed: !same(before, after),
    protectedChanged: [],
  };
}

async function main() {
  if (Deno.args.some((arg) => arg !== "--apply")) {
    throw new Error("Only --apply is accepted; dry run is the default");
  }
  const password = Deno.env.get("NMF_PW");
  if (!password) throw new Error("NMF_PW required");
  const source = await Deno.readTextFile(
    new URL("../nmf_cloud.mjs", import.meta.url),
  );
  const key = source.match(/const KEY =\s*"([^"]+)"/)?.[1],
    origin = source.match(/const URL_ =\s*"([^"]+)"/)?.[1];
  if (!key || !origin) throw new Error("Cloud configuration unavailable");
  const api = `${origin}/rest/v1/namofood_state`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const load = async (id: string): Promise<Row> => {
    const response = await fetch(
      `${api}?id=eq.${encodeURIComponent(id)}&select=id,data,updated_at`,
      { headers },
    );
    if (!response.ok) throw new Error(`Cloud read failed ${response.status}`);
    const [row] = await response.json();
    if (!row) throw new Error(`Cloud row unavailable: ${id}`);
    return row;
  };
  const backups: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const beforeRow = await load("namofood");
    const before = JSON.parse(
      await decryptText(password, beforeRow.data),
    ) as State;
    const at = new Date().toISOString(), plan = planAIRetirement(before, at);
    const summary = {
      dry: !Deno.args.includes("--apply"),
      saved: false,
      readBackVerified: false,
      attempt,
      backups,
      removedAIMeals: plan.removedMeals.length,
      removedFoodCells: plan.removedCells.length,
      removedMealKeys: plan.removedMeals,
      protectedChanged: plan.protectedChanged,
      recipesUnchanged: same(before.recipes, plan.after.recipes),
    };
    if (summary.dry || !plan.changed) {
      console.log(JSON.stringify(summary));
      return;
    }
    const id = `namofood@before-ai-menu-retirement-${
      at.replace(/[:.]/g, "-")
    }-${crypto.randomUUID()}`;
    const backup = await fetch(api, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({
        id,
        data: beforeRow.data,
        updated_at: beforeRow.updated_at,
      }),
    });
    if (!backup.ok) {
      throw new Error(`Retirement backup failed ${backup.status}`);
    }
    const confirmed = await load(id);
    if (confirmed.data !== beforeRow.data) {
      throw new Error("Retirement backup content verification failed");
    }
    backups.push(id);
    plan.after.updatedAt = at;
    const encrypted = await encryptText(password, JSON.stringify(plan.after));
    const saved = await fetch(
      `${api}?id=eq.namofood&updated_at=eq.${
        encodeURIComponent(beforeRow.updated_at)
      }`,
      {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ data: encrypted, updated_at: at }),
      },
    );
    if (!saved.ok) throw new Error(`Retirement CAS failed ${saved.status}`);
    if (!(await saved.json()).length) continue;
    const current = await load("namofood");
    const verified = JSON.parse(await decryptText(password, current.data));
    if (!same(verified, plan.after)) {
      throw new Error(
        "Retirement read-back differs; inspect the saved snapshot before retrying",
      );
    }
    console.log(
      JSON.stringify({ ...summary, saved: true, readBackVerified: true }),
    );
    return;
  }
  throw new Error(
    "Retirement CAS conflict after 3 fresh attempts; no stale state overwritten",
  );
}
if (import.meta.main) await main();
