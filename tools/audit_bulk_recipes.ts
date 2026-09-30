// Read-only live recipe audit. --capture saves an encrypted verification baseline.
// NMF_PW=... deno run -A tools/audit_bulk_recipes.ts [--capture path | --compare path]
import {
  decryptText,
  institutionalUpgradeList,
  missingList,
  recipeNames,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";

const pw = Deno.env.get("NMF_PW");
if (!pw) throw new Error("NMF_PW required");
const source = await Deno.readTextFile(
  new URL("../nmf_cloud.mjs", import.meta.url),
);
const key = source.match(/const KEY =\s*"([^"]+)"/)![1];
const url =
  "https://rycibsczsgbkgtwfxyim.supabase.co/rest/v1/namofood_state?id=eq.namofood&select=data,updated_at";
const response = await fetch(url, {
  headers: { apikey: key, Authorization: "Bearer " + key },
});
if (!response.ok) throw new Error("read " + response.status);
const [row] = await response.json();
const state = JSON.parse(await decryptText(pw, row.data));
if (Deno.args[0] === "--capture") {
  await Deno.writeTextFile(Deno.args[1], JSON.stringify(row));
}
const names = [...recipeNames(state)];
const homeTerms =
  /(프라이팬|후라이팬|팬에\s*기름|한\s*장씩|한\s*개씩|한\s*줌|[1234]\s*인분|큰술|작은술)/;
const legacyAi = names.filter((name) =>
  state.recipeMeta?.[name]?.by === "ai" &&
  state.recipeMeta?.[name]?.cookingProfile !== "institutional-v1"
);
const homeAi = legacyAi.filter((name) =>
  homeTerms.test(state.methods?.[name] || "")
);
const report: Record<string, unknown> = {
  updatedAt: row.updated_at,
  total: names.length,
  missing: missingList(state).map((x) => x.menu),
  institutional:
    names.filter((name) =>
      state.recipeMeta?.[name]?.cookingProfile === "institutional-v1"
    ).length,
  legacyAi: legacyAi.length,
  householdAi: homeAi.length,
  upgradePending: institutionalUpgradeList(state).length,
  examples: homeAi.slice(0, 8).map((menu) => ({
    menu,
    method: state.methods[menu],
  })),
};
if (Deno.args[0] === "--compare") {
  const oldRow = JSON.parse(await Deno.readTextFile(Deno.args[1]));
  const before = JSON.parse(await decryptText(pw, oldRow.data));
  const changed = names.filter((name) =>
    before.methods?.[name] !== state.methods?.[name]
  );
  const protectedKeys = [
    ...new Set([...Object.keys(before), ...Object.keys(state)]),
  ].filter((k) => !["methods", "recipeMeta", "updatedAt"].includes(k));
  report.verification = {
    changedMethods: changed,
    changedManualMethods: changed.filter((name) =>
      before.recipeMeta?.[name]?.by !== "ai"
    ),
    protectedChanged: protectedKeys.filter((k) =>
      JSON.stringify(before[k]) !== JSON.stringify(state[k])
    ),
    ingredientsUnchanged:
      JSON.stringify(before.recipes) === JSON.stringify(state.recipes),
  };
}
console.log(JSON.stringify(report, null, 2));
