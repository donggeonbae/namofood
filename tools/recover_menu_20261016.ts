// One-time, reviewed recovery for the approved missing date; dry unless --apply.
import {
  decryptText,
  encryptText,
  existingMenuCells,
  mergeMenuPlan,
  parseMenuPlanJson,
  type State,
  validateMenuVariety,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
const date = "2026-10-16", meals = ["조식", "중식", "석식", "야식"];
const rows = [
  [
    "소고기미역국",
    "육전",
    "돈육메추리알조림",
    "청포묵무침",
    "시래기나물",
    "배추김치",
    "김구이",
  ],
  [
    "꽃게탕",
    "돼지갈비찜",
    "오징어볶음",
    "잡채",
    "상추겉절이",
    "깍두기",
    "양파초절임",
  ],
  [
    "차돌된장찌개",
    "훈제오리볶음",
    "삼치구이",
    "부추무침",
    "햄감자볶음",
    "배추김치",
    "양배추쌈",
  ],
  [
    "순댓국",
    "매운마늘삼겹살볶음",
    "닭살카레볶음",
    "콘버터",
    "양상추샐러드",
    "깍두기",
    "야채튀김",
  ],
];
const password = Deno.env.get("NMF_PW");
if (!password) throw new Error("NMF_PW required");
const src = await Deno.readTextFile(
  new URL("../nmf_cloud.mjs", import.meta.url),
);
const key = src.match(/const KEY =\s*"([^"]+)"/)![1];
const url = "https://rycibsczsgbkgtwfxyim.supabase.co/rest/v1/namofood_state";
const headers = {
  apikey: key,
  Authorization: "Bearer " + key,
  "Content-Type": "application/json",
};
const runId = crypto.randomUUID();
for (let attempt = 0; attempt < 3; attempt++) {
  const read = await fetch(url + "?id=eq.namofood&select=data,updated_at", {
    headers,
  });
  if (!read.ok) throw new Error("Read failed " + read.status);
  const [row] = await read.json();
  const before: State = JSON.parse(await decryptText(password, row.data));
  const fixed = existingMenuCells(before, [date], meals);
  const plan = {
    days: [{
      date,
      meals: meals.map((meal, i) => ({
        meal,
        slots: Object.fromEntries(
          ["1", "2", "7", "3", "4", "8"].map((
            slot,
            j,
          ) => [slot, fixed[`${date}|${meal}|${slot}`] ?? rows[i][j]]),
        ),
        extras: [rows[i][6]],
      })),
    }],
  };
  parseMenuPlanJson(JSON.stringify(plan), [date], meals, fixed);
  validateMenuVariety(before, plan);
  const state = structuredClone(before), at = new Date().toISOString();
  const changes = mergeMenuPlan(state, plan, {
    updated: at,
    model: "codex-curated-recovery",
    runId,
    meals,
    headcountDates: [],
  });
  if (changes.prices.length || Object.keys(changes.headcounts).length) {
    throw new Error("Unexpected price/headcount change");
  }
  for (const [month, cells] of Object.entries(before.menus || {})) {
    for (const [cell, value] of Object.entries(cells)) {
      if (state.menus?.[month]?.[cell] !== value) {
        throw new Error("Existing cell changed " + month + "/" + cell);
      }
    }
  }
  for (
    const field of Object.keys(before).filter((k) =>
      !["menus", "menuPlanMeta", "updatedAt"].includes(k)
    )
  ) {
    if (
      JSON.stringify(before[field]) !== JSON.stringify(state[field])
    ) throw new Error("Protected field changed " + field);
  }
  if (!Deno.args.includes("--apply")) {
    console.log(
      JSON.stringify({
        dry: true,
        plan,
        added: changes.added.length,
        protectedUnchanged: true,
      }),
    );
    break;
  }
  if (!changes.added.length && !changes.rice.length) {
    console.log(JSON.stringify({ alreadyComplete: true }));
    break;
  }
  const backupId = "namofood@before-menu-recovery-" + date + "-" + runId;
  const backup = await fetch(url, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify([{ id: backupId, data: row.data, updated_at: at }]),
  });
  if (!backup.ok && !(attempt > 0 && backup.status === 409)) {
    throw new Error("Backup failed " + backup.status);
  }
  state.updatedAt = at;
  const blob = await encryptText(password, JSON.stringify(state));
  const save = await fetch(
    url + "?id=eq.namofood&updated_at=eq." +
      encodeURIComponent(row.updated_at) + "&select=id",
    {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ data: blob, updated_at: at }),
    },
  );
  if (!save.ok) throw new Error("Save failed " + save.status);
  if ((await save.json()).length) {
    console.log(
      JSON.stringify({
        date,
        saved: true,
        added: changes.added.length,
        backupId,
        protectedUnchanged: true,
      }),
    );
    break;
  }
  if (attempt === 2) {
    throw new Error("CAS conflict after 3 attempts; no state overwritten");
  }
}
