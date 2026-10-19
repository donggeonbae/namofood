import {
  buildTaxReport,
  type TaxState,
} from "../supabase/functions/nmf-tax-nightly/lib.ts";
import { financeHash } from "../supabase/functions/nmf-tax-auto/debounce.ts";
const base: TaxState = {
  settings: {
    tickets: { 조식: 10000, 중식: 10000 },
    ticketLedger: { unitPrice: 10000 },
  },
  sales: {
    "2026-10": {
      "18|조식": 10,
      "18|중식": 20,
      "18|ticketIssued": 100,
      "18|ticketIssuePrice": 10000,
      "19|조식": 15,
      "19|중식": 25,
      "19|ticketIssued": 80,
      "19|cardCount|중식": 7,
      "19|creditCount|중식": 5,
      "19|other": 90000,
    },
  },
  staff: [],
  staffArchive: [],
  orders: {},
  fixedMonthly: { "2026-10": [] },
};
const before = JSON.stringify(base),
  report = buildTaxReport(base, "2026-10-19");
if (report.months["2026-10"].revenue !== 2010000) {
  throw Error(
    "Company sales replace recovered ticket revenue, other channels counted once",
  );
}
const zero = structuredClone(base);
zero.sales!["2026-10"]["19|ticketIssued"] = 0;
if (buildTaxReport(zero, "2026-10-19").months["2026-10"].revenue !== 1210000) {
  throw Error("Explicit zero must not fall back to recovered tickets");
}
delete zero.sales!["2026-10"]["19|ticketIssued"];
if (buildTaxReport(zero, "2026-10-19").months["2026-10"].revenue !== 1610000) {
  throw Error("Only missing company sales use meal recoveries");
}
const future = structuredClone(base);
future.sales!["2026-10"]["20|ticketIssued"] = 9999;
if (
  buildTaxReport(future, "2026-10-19").months["2026-10"].revenue !== 2010000
) throw Error("Future company sales excluded");
const only: TaxState = {
  ...base,
  sales: { "2026-10": { "1|ticketIssued": 0, "2|ticketIssued": 2 } },
};
if (buildTaxReport(only, "2026-10-19").months["2026-10"].salesDays !== 2) {
  throw Error("Company-sales-only and explicit-zero days count");
}
const changed = structuredClone(base);
(changed.settings!.ticketLedger as Record<string, unknown>).unitPrice = 12000;
if (await financeHash(base) === await financeHash(changed)) {
  throw Error("Price edits must invalidate automatic tax report");
}
if (JSON.stringify(base) !== before) {
  throw Error("Tax must not mutate ticket ledger");
}
console.log(
  "TAX_COMPANY_TICKETS_SALES_ZERO_FALLBACK_CHANNELS_FUTURE_PRICE_DEBOUNCE_READONLY_OK",
);
