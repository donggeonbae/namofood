import { buildTaxReport } from "../supabase/functions/nmf-tax-nightly/lib.ts";
const base = {
  settings: { meals: { "중식": { price: 1000 } } },
  sales: { "2026-10": { "1|중식": 1 } },
  orders: {
    "2026-10": [{
      id: "regular",
      date: "2026-10-01",
      total: 100,
      tax: 10,
      items: [],
    }, {
      id: "ref",
      date: "2026-10-01",
      total: 999,
      tax: 99,
      items: [],
      ocrMeta: { referenceOnly: true },
    }],
  },
};
const actual = buildTaxReport(base, "2026-10-19"),
  expected = buildTaxReport({
    ...base,
    orders: { "2026-10": base.orders["2026-10"].slice(0, 1) },
  }, "2026-10-19");
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw Error("Reference ledger must not change tax inputs or estimates");
}
console.log("TAX_REFERENCE_LEDGER_EXCLUDED_OK");
