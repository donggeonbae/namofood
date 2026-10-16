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
const counts = structuredClone(state);
counts.settings = {
  tickets: Object.fromEntries(
    ["조식", "중식", "석식", "야식"].map((m, i) => [m, 10000 + i * 1000]),
  ),
  opdays: 31,
};
counts.sales = {
  "2026-10": {
    "15|중식": 10,
    "15|cash": 500,
    "15|cash|조식": 1234,
    "15|card": 7000,
    "15|card|석식": 2345,
    "15|other": 1000,
    "16|creditCount|야식": 0,
    "17|creditCount|중식": 999,
  },
};
for (const [i, m] of ["조식", "중식", "석식", "야식"].entries()) {
  for (
    const [k, n] of [["cashCount", 1], ["cardCount", 2], [
      "creditCount",
      3,
    ]] as const
  ) counts.sales["2026-10"][`15|${k}|${m}`] = (i + 1) * n;
}
const countsBefore = JSON.stringify(counts),
  countsReport = buildTaxReport(counts, "2026-10-16").months["2026-10"];
eq(
  countsReport.revenue,
  842079,
  "all meal count × correct price; same-day credit is accrued revenue; legacy money included once",
);
eq(
  countsReport.salesDays,
  2,
  "credit zero counts as entry, future credit excluded",
);
eq(countsReport.outputVat, 76553, "server VAT includes credit count revenue");
eq(
  JSON.stringify(counts),
  countsBefore,
  "never convert or rewrite legacy data",
);
for (const k of ["cashCount", "cardCount", "creditCount"]) {
  const other = structuredClone(counts);
  other.sales!["2026-10"][`15|${k}|중식`] = 77;
  eq(
    await financeHash(other) === await financeHash(counts),
    false,
    "count edits trigger tax quiet window " + k,
  );
}
console.log(
  "SERVER_MEAL_COUNT_PRICE_CREDIT_REVENUE_LEGACY_ZERO_CUTOFF_VAT_HASH_AND_SOURCE_IMMUTABILITY_OK",
);
