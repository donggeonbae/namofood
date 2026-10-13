import {
  buildCostReview,
  buildTaxReport,
} from "../supabase/functions/nmf-tax-nightly/lib.ts";
const day = { s: "09:00", e: "18:00", b: 60 },
  state = {
    settings: { burden: .1, vacancy: 0, night: 0, opdays: 31 },
    staff: [{ id: "fixed", wage: 0, bonus: 310000 }, {
      id: "future-fixed",
      wage: 0,
      bonus: 620000,
    }, { id: "hourly", wage: 10000, bonus: 0 }],
    roster: {
      "2026-10": {
        "fixed|1": day,
        "fixed|adj": 5000,
        "future-fixed|14": day,
        "hourly|1": day,
        "hourly|14": day,
      },
    },
    sales: {
      "2026-10": { "1|other": 1000000, "13|other": 0, "14|other": 9000000 },
    },
    orders: {
      "2026-10": [{ date: "2026-10-01", total: 130000 }, {
        date: "2026-10-14",
        total: 9999999,
      }],
    },
    fixedMonthly: { "2026-10": [] },
  };
const before = JSON.stringify(state),
  report = buildTaxReport(state, "2026-10-13"),
  full = buildTaxReport(state, "2026-11-01"),
  ratios = buildCostReview(report).months["2026-10"];
const close = (a: number, b: number, label: string) => {
  if (Math.abs(a - b) > 1e-6) throw Error(`${label}: ${a} != ${b}`);
};
close(
  report.months["2026-10"].labor,
  522500,
  "calendar accrued fixed salaries + worked hourly cost",
);
close(full.months["2026-10"].labor, 1204500, "completed month unchanged");
close(
  ratios.laborRatio!,
  .5225,
  "labor ratio includes fixed salary accrued by cutoff",
);
close(ratios.foodRatio!, .13, "future purchases excluded");
if (JSON.stringify(state) !== before) {
  throw Error("report never rewrites wages or shifts");
}
console.log(
  "SERVER_FIXED_SALARY_CALENDAR_ACCRUAL_CURRENT_COST_RATIOS_FULL_MONTH_NO_SOURCE_WRITES_OK",
);
