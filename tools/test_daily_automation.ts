import {
  selectRollingDates,
  SLOT_INDICES,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
function assert(ok: unknown, message: string) {
  if (!ok) throw new Error(message);
}
const state = {
  menus: {
    "2026-09": {} as Record<string, string>,
    "2026-10": {} as Record<string, string>,
  },
};
for (let i = 0; i < 14; i++) {
  const date = new Date(Date.UTC(2026, 8, 28 + i));
  const ym = date.toISOString().slice(0, 7) as keyof typeof state.menus;
  for (const meal of ["조식", "중식", "석식", "야식"]) {
    for (const slot of SLOT_INDICES) {
      state.menus[ym][`${date.getUTCDate()}|${meal}|${slot}`] = "기존 메뉴";
    }
  }
}
assert(
  JSON.stringify(selectRollingDates(state, "2026-09-28")) === '["2026-10-12"]',
  "generate exactly same weekday +14 across month boundary",
);
assert(
  selectRollingDates({ menus: {} }, "2026-09-28").includes("2026-10-12"),
  "prioritize +14 when catching up",
);
assert(
  selectRollingDates({ menus: {} }, "2026-12-25").includes("2027-01-08"),
  "year boundary",
);
for (const meal of ["조식", "중식", "석식", "야식"]) {
  for (const slot of SLOT_INDICES) {
    state.menus["2026-10"][`12|${meal}|${slot}`] = "수동 메뉴";
  }
}
assert(
  selectRollingDates(state, "2026-09-28").length === 0,
  "complete manual menus untouched",
);
console.log("DAILY_AUTOMATION_OK");
