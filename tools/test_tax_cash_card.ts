import {
  buildTaxReport,
  type TaxState,
} from "../supabase/functions/nmf-tax-nightly/lib.ts";
import {
  financeHash,
  inspectFinance,
} from "../supabase/functions/nmf-tax-auto/debounce.ts";
const eq = (a: unknown, b: unknown, label: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error(label + ": " + JSON.stringify(a));
  }
};
const state: TaxState = {
  settings: { tickets: { 중식: 10000 }, opdays: 31 },
  sales: {
    "2026-10": {
      "15|중식": 10,
      "15|other": 1000,
      "15|cash": 25000.5,
      "15|card": 50000,
      "14|cash": 0,
      "16|card": 900000,
    },
  },
  staff: [],
  staffArchive: [],
  orders: {},
  fixedMonthly: { "2026-10": [] },
};
const before = JSON.stringify(state),
  report = buildTaxReport(state, "2026-10-15"),
  month = report.months["2026-10"];
eq(
  month.revenue,
  176000.5,
  "server tax includes tickets plus distinct cash/card/other revenue, not future receipts",
);
eq(month.salesDays, 2, "explicit cash zero is a recorded day");
eq(month.outputVat, 16000, "VAT arithmetic uses the complete gross revenue");
eq(JSON.stringify(state), before, "tax calculation never changes sales source");
for (const key of ["cash", "card"]) {
  const changed = structuredClone(state);
  changed.sales!["2026-10"]["15|" + key] = 123;
  const hash = await financeHash(state), updated = await financeHash(changed);
  eq(hash === updated, false, key + " changes trigger tax debounce");
  eq(
    inspectFinance(hash, updated, "2026-10-15T00:00:00Z", null).dueAt,
    "2026-10-15T00:01:00.000Z",
    "one-minute quiet window unchanged",
  );
}
console.log(
  "SERVER_CASH_CARD_REVENUE_VAT_DAYS_FUTURE_CUTOFF_NO_LEDGER_MUTATION_DEBOUNCE_OK",
);
const mealState = structuredClone(state);
for (const me of ["조식", "중식", "석식", "야식"]) {
  mealState.sales!["2026-10"]["15|cash|" + me] = 1000;
  mealState.sales!["2026-10"]["15|card|" + me] = 2000;
}
mealState.sales!["2026-10"]["16|card|야식"] = 999999;
const mealBefore = JSON.stringify(mealState),
  mealReport = buildTaxReport(mealState, "2026-10-15").months["2026-10"];
eq(
  mealReport.revenue,
  188000.5,
  "all meal channels plus legacy unassigned revenue exactly once, excluding future meal receipts",
);
eq(mealReport.salesDays, 2, "meal channels do not multiply recorded days");
eq(mealReport.outputVat, 17091, "meal-channel VAT arithmetic");
eq(
  JSON.stringify(mealState),
  mealBefore,
  "do not allocate legacy values or mutate meals",
);
const cashOnly = structuredClone(state);
cashOnly.sales = { "2026-10": { "15|cash|조식": 0, "14|card|야식": 2000 } };
eq(
  buildTaxReport(cashOnly, "2026-10-15").months["2026-10"].salesDays,
  2,
  "cash-only meals including explicit zero are entered days",
);
console.log(
  "SERVER_MEAL_CHANNELS_LEGACY_TOTAL_VAT_ZERO_FUTURE_CUTOFF_SOURCE_IMMUTABLE_OK",
);
