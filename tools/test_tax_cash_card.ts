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
