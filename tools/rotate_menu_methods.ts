// Explicit operator maintenance, dry-run by default. No autonomous menu generation.
import {
  decryptText,
  encryptText,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
import { recipeFoodProfile } from "../supabase/functions/nmf-menu-recommend/lib.ts";
import {
  referenceDishes,
  rotateExistingMains,
  type RotationState,
} from "../supabase/functions/_shared/menu-rotation.ts";
const pw = Deno.env.get("NMF_PW");
if (!pw) throw Error("Secure app credential required");
async function query(sql: string) {
  const r = await new Deno.Command("/Users/donggeonbae/.local/bin/supabase", {
    args: ["db", "query", "--linked", sql],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success) throw Error("Database query failed");
  return JSON.parse(new TextDecoder().decode(r.stdout)).rows;
}
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const [row] = await query(
  "select id,data,updated_at::text from public.namofood_state where id='namofood'",
);
const before = JSON.parse(await decryptText(pw, row.data)),
  rmap = new Map<string, Array<Record<string, unknown>>>();
for (const r of before.recipes || []) {
  const rows = rmap.get(r.menu) || [];
  rows.push(r);
  rmap.set(r.menu, rows);
}
const profile = (name: string) => recipeFoodProfile(name, rmap.get(name) || []);
const result = rotateExistingMains(before, profile, "2026-10-24", "2027-06-30");
for (const key of Object.keys(before)) {
  if (
    key !== "menus" && key !== "menuRotationReference" &&
    JSON.stringify(before[key]) !== JSON.stringify(result.after[key])
  ) throw Error("Protected state changed: " + key);
}
const allowed = new Set(
  result.changes.map((c) =>
    c.date.slice(0, 7) + "|" + Number(c.date.slice(8)) + "|" + c.meal + "|" +
    c.slot
  ),
);
for (
  const [month, cells] of Object.entries(before.menus || {}) as [
    string,
    Record<string, unknown>,
  ][]
) {
  for (const [key, value] of Object.entries(cells)) {
    if (
      !allowed.has(month + "|" + key) &&
      JSON.stringify(value) !==
        JSON.stringify(result.after.menus?.[month]?.[key])
    ) throw Error("Protected menu cell changed");
  }
}
for (const c of result.changes) {
  if (!referenceDishes(before).has(c.after)) {
    throw Error("Dish outside approved reference");
  }
}
if (
  rotateExistingMains(result.after, profile, "2026-10-24", "2027-06-30").changes
    .length
) throw Error("Residual method conflict");
const summary = {
  months: Object.keys(before.menus || {}).sort(),
  referenceCount: referenceDishes(before).size,
  changed: result.changes.length,
  blocked: result.blocked.slice(0, 5),
  blockedCount: result.blocked.length,
  examples: result.changes.slice(0, 5),
};
console.log(JSON.stringify(summary));
if (Deno.args.includes("--apply")) {
  if (result.blocked.length) {
    throw Error("Unresolved days: no partial bulk write");
  }
  const at = new Date().toISOString(),
    id = "namofood@before-method-rotation-" + crypto.randomUUID();
  const ciphertext = await encryptText(pw, JSON.stringify(result.after));
  const rows = await query(
    `with target as (select data,updated_at from public.namofood_state where id='namofood' and updated_at=${
      quote(row.updated_at)
    }::timestamptz for update), backup as (insert into public.namofood_state(id,data,updated_at) select ${
      quote(id)
    },data,updated_at from target returning id) update public.namofood_state set data=${
      quote(ciphertext)
    },updated_at=${quote(at)}::timestamptz where id='namofood' and updated_at=${
      quote(row.updated_at)
    }::timestamptz and exists(select 1 from backup) returning id`,
  );
  if (rows.length !== 1) throw Error("Concurrent edit: no update applied");
  const [saved] = await query(
    "select data from public.namofood_state where id='namofood'",
  );
  if (await decryptText(pw, saved.data) !== JSON.stringify(result.after)) {
    throw Error("Read-back mismatch");
  }
  console.log(
    JSON.stringify({
      applied: result.changes.length,
      backup: id,
      verified: true,
    }),
  );
}
