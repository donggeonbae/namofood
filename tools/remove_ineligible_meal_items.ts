// Exact, user-approved beer cleanup. Dry-run by default; writes require --apply.
import {
  decryptText,
  encryptText,
  type State,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";
const dish = "맥주", room = "namofood";
const fields = ["methods", "recipeMeta", "sources", "recipeAsk"] as const;
type Cell = { month: string; key: string };
type Row = { data: string; updated_at: string };
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function planBeerRemoval(before: State) {
  if (
    !Array.isArray(before.recipes) || !before.menus ||
    typeof before.menus !== "object"
  ) throw Error("Invalid state shape");
  const state = structuredClone(before), targets: Cell[] = [];
  for (const [month, cells] of Object.entries(before.menus)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !cells || typeof cells !== "object") {
      continue;
    }
    for (const [key, value] of Object.entries(cells)) {
      const match = /^(\d{1,2})\|(조식|중식|석식|야식)\|(\d+)$/.exec(key);
      if (value !== dish || !match) continue;
      const [year, mon] = month.split("-").map(Number),
        day = +match[1],
        slot = +match[3];
      if (
        mon < 1 || mon > 12 || day < 1 ||
        day > new Date(Date.UTC(year, mon, 0)).getUTCDate()
      ) throw Error("Invalid target date: " + month + "|" + key);
      if (slot < 10) {
        throw Error(
          "Beer is not an optional extra; review required: " + month + "|" +
            key,
        );
      }
      targets.push({ month, key });
      delete state.menus[month][key];
    }
  }
  const recipeRows =
    before.recipes.filter((r: { menu?: string }) => r.menu === dish).length;
  const recipeFields = fields.filter((f) =>
    Object.hasOwn(before[f] || {}, dish)
  );
  if (
    (recipeRows || recipeFields.length) &&
    before.recipeMeta?.[dish]?.by !== "ai"
  ) throw Error("Beer recipe is manual or unverified; nothing may be deleted");
  state.recipes = state.recipes.filter((r: { menu?: string }) =>
    r.menu !== dish
  );
  for (const field of fields) if (state[field]) delete state[field][dish];
  return {
    state,
    targets,
    recipeRows,
    recipeFields,
    changed: !!(targets.length || recipeRows || recipeFields.length),
  };
}
export function verifyBeerRemoval(before: State, after: State) {
  const plan = planBeerRemoval(before);
  for (
    const key of new Set([...Object.keys(plan.state), ...Object.keys(after)])
  ) {
    if (key !== "updatedAt" && !same(plan.state[key], after[key])) {
      throw Error("Protected state changed: " + key);
    }
  }
  if (planBeerRemoval(after).changed) {
    throw Error("Beer targets remain after cleanup");
  }
  const cells = Object.values(before.menus).flatMap((m) =>
    Object.keys(m as object)
  );
  return {
    unrelatedStateUnchanged: true,
    ingredientRowsProtected: true,
    protectedMenuCells: cells.length - plan.targets.length,
    headcountsPreserved: cells.filter((k) => k.endsWith("|n")).length,
  };
}

async function main() {
  if (Deno.args.some((arg) => arg !== "--apply")) {
    throw Error(
      "Usage: NMF_PW=... deno run -A tools/remove_ineligible_meal_items.ts [--apply]",
    );
  }
  const apply = Deno.args.includes("--apply"), pw = Deno.env.get("NMF_PW");
  if (!pw) throw Error("NMF_PW required");
  const source = await Deno.readTextFile(
    new URL("../nmf_cloud.mjs", import.meta.url),
  );
  const key = source.match(/const KEY =\s*"([^"]+)"/)?.[1];
  if (!key) throw Error("Existing public API key not found");
  const api = "https://rycibsczsgbkgtwfxyim.supabase.co/rest/v1/namofood_state";
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  async function load(id = room): Promise<Row> {
    const r = await fetch(
      api + "?id=eq." + encodeURIComponent(id) + "&select=data,updated_at",
      { headers, signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) throw Error("Read failed " + r.status);
    const rows = await r.json();
    if (
      rows.length !== 1 || typeof rows[0].data !== "string" ||
      !rows[0].updated_at
    ) throw Error("Exact state row unavailable");
    return rows[0];
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const row = await load(),
      before = JSON.parse(await decryptText(pw, row.data)),
      plan = planBeerRemoval(before);
    const protectedChecks = verifyBeerRemoval(before, plan.state);
    const summary = {
      mode: apply ? "apply" : "dry-run",
      attempt,
      removedMenuCells: plan.targets.length,
      targets: plan.targets,
      removedRecipeRows: plan.recipeRows,
      removedRecipeFields: plan.recipeFields,
      protectedChecks,
    };
    if (!apply || !plan.changed) {
      console.log(JSON.stringify({ ...summary, applied: false }));
      return;
    }
    const at = new Date().toISOString(), uuid = crypto.randomUUID();
    const snapshotId = room + "@before-beer-removal-" + at + "-" + uuid;
    const localBackup = "/tmp/nmf-before-beer-removal-" + uuid + ".json";
    await Deno.writeTextFile(
      localBackup,
      JSON.stringify({ sourceId: room, snapshotId, ...row }),
      { createNew: true, mode: 0o600 },
    );
    const backup = await fetch(api, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ id: snapshotId, data: row.data, updated_at: at }),
      signal: AbortSignal.timeout(15000),
    });
    if (!backup.ok) {
      throw Error(
        "Cloud backup failed " + backup.status +
          "; current state untouched; local encrypted backup " + localBackup,
      );
    }
    const snapshots = await backup.json();
    if (
      snapshots.length !== 1 || snapshots[0].id !== snapshotId ||
      snapshots[0].data !== row.data
    ) throw Error("Cloud backup not confirmed; current state untouched");
    if ((await load(snapshotId)).data !== row.data) {
      throw Error("Backup read-back mismatch; current state untouched");
    }
    plan.state.updatedAt = at;
    const data = await encryptText(pw, JSON.stringify(plan.state));
    const saved = await fetch(
      api + "?id=eq." + room + "&updated_at=eq." +
        encodeURIComponent(row.updated_at),
      {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ data, updated_at: at }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!saved.ok) {
      throw Error(
        "CAS save failed " + saved.status + "; encrypted backup " + snapshotId,
      );
    }
    const savedRows = await saved.json();
    if (!savedRows.length) {
      console.log(
        JSON.stringify({ conflict: true, attempt, snapshotId, localBackup }),
      );
      continue;
    }
    if (savedRows.length !== 1 || savedRows[0].data !== data) {
      throw Error(
        "Unexpected save receipt; verify cloud state before retrying",
      );
    }
    const readback = await load(),
      after = JSON.parse(await decryptText(pw, readback.data));
    const verified = verifyBeerRemoval(before, after);
    console.log(
      JSON.stringify({
        ...summary,
        applied: true,
        snapshotId,
        localBackup,
        verified,
      }),
    );
    return;
  }
  throw Error(
    "Three CAS conflicts; no stale state overwritten. Rerun from fresh state.",
  );
}
if (import.meta.main) await main();
