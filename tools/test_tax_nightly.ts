import {
  buildTaxReport,
  kstDay,
  nationalTax,
  nextNight,
  nightlyWindow,
  reviewTax,
  type TaxState,
} from "../supabase/functions/nmf-tax-nightly/lib.ts";
function eq(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error(label + ": " + JSON.stringify(a));
  }
}
const state: TaxState = {
  settings: {
    tickets: { 중식: 10000 },
    opdays: 31,
    roleWages: { 조리: 15000 },
    night: .5,
    burden: 0,
    vacancy: 0,
  },
  sales: {
    "2026-10": { "1|중식": 10, "2|중식": 0, "13|중식": 20, "14|중식": 999 },
  },
  orders: {
    "2026-10": [
      {
        date: "2026-10-02",
        total: 110000,
        tax: 10000,
        previousBalance: 900000,
      },
      { date: "2026-10-14", total: 500000, tax: 50000 },
      {
        date: "2026-10-03",
        total: 800000,
        ocrMeta: { duplicateReviewPending: true },
      },
    ],
  },
  staff: [],
  staffArchive: [],
  fixedMonthly: { "2026-10": [["임대", 310000]] },
};
const before = JSON.stringify(state),
  report = buildTaxReport(state, "2026-10-13"),
  m = report.months["2026-10"];
eq(m.revenue, 300000, "future sales excluded");
eq(m.salesDays, 3, "explicit zero day");
eq(m.purchases, 110000, "exclude future duplicate and carried debt");
eq(m.inputVatObserved, 10000, "observed not confirmed");
eq(m.inputVatConfirmed, null, "AI must not fabricate confirmed input VAT");
eq(m.vatRange, [17273, 27273], "uncertain VAT range");
eq(before, JSON.stringify(state), "no ledger mutation");
const correction = structuredClone(state);
correction.orders!["2026-10"] = [{
  date: "2026-10-02",
  total: -110000,
  tax: -10000,
}];
eq(buildTaxReport(correction, "2026-10-13").months["2026-10"].vatRange, [
  27273,
  37273,
], "negative adjustment preserves uncertain VAT reversal");
eq(nationalTax(50000000), 6240000, "rate boundary");
const now = Date.parse("2026-10-13T14:30:00Z");
eq(kstDay(now), "2026-10-13", "KST");
eq(nightlyWindow(now), true, "23:30 allowed");
eq(nightlyWindow(now - 1), false, "before schedule blocked");
eq(nightlyWindow(now + 30 * 60000), false, "next day blocked");
eq(nextNight(now), "2026-10-14T14:30:00.000Z", "next nightly run");
let calls = 0;
const fake = ((_url: unknown, options: RequestInit) => {
  const request = JSON.parse(String(options.body));
  eq(
    /json/i.test(request.messages[0].content[0].text),
    true,
    "JSON mode instruction in input, not only system instructions",
  );
  const headers = new Headers(options.headers);
  eq(headers.get("User-Agent"), "namofood-tax/1.0", "provider agent metadata");
  eq(
    headers.get("x-opencode-session")?.startsWith("nmf-tax-"),
    true,
    "Go session metadata",
  );
  calls++;
  return Promise.resolve(
    new Response(
      JSON.stringify({
        status: "completed",
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              summary: "증빙 공제 확인",
              checks: ["공제 여부 확인"],
              amount: 999999999,
            }),
          }],
        }],
      }),
    ),
  );
}) as typeof fetch;
const review = await reviewTax(report, {
  apiKey: "fixture",
  baseUrl: "https://opencode.ai/zen/go/v1",
  model: "claude-haiku-5-5",
  fetcher: fake,
});
eq(calls, 1, "single AI call");
eq(review.summary, "증빙 공제 확인", "validated review");
eq(
  report.months["2026-10"].vatRange,
  [17273, 27273],
  "model amounts never applied",
);
let blocked = false;
try {
  await reviewTax(report, {
    apiKey: "fixture",
    baseUrl: "https://evil.test",
    model: "claude-haiku-5-5",
    fetcher: fake,
  });
} catch {
  blocked = true;
}
eq(blocked, true, "SSRF guard");
eq(calls, 1, "invalid provider never contacted");
console.log(
  "TAX_NIGHTLY_MATH_NULLS_SOURCE_PROTECTION_KST_SINGLE_MODEL_CALL_OK",
);
