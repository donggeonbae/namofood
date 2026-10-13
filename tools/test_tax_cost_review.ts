import {
  buildCostReview,
  buildTaxReport,
  reviewTax,
  TAX_AI_PROMPT,
} from "../supabase/functions/nmf-tax-nightly/lib.ts";
function assert(ok: boolean, message: string) {
  if (!ok) throw Error(message);
}
const state = {
  settings: {
    tickets: { 중식: 10000 },
    opdays: 31,
    night: 0,
    burden: 0,
    vacancy: 0,
  },
  sales: { "2026-10": { "13|중식": 100 } },
  orders: { "2026-10": [{ date: "2026-10-12", total: 700000 }] },
  staff: [{ id: "a", wage: 30000, bonus: 0 }],
  roster: { "2026-10": { "a|13": { s: "08:00", e: "18:00", b: 0 } } },
  fixedMonthly: { "2026-10": [] },
};
const report = buildTaxReport(state, "2026-10-13"),
  before = JSON.stringify(report),
  review = buildCostReview(report),
  m = review.months["2026-10"];
assert(
  m.foodRatio === .7 && m.laborRatio === .3,
  "actual registered purchase and roster costs divided by actual revenue",
);
assert(
  Math.abs(m.foodGapPp! - 28.6) < 1e-8 && Math.abs(m.laborGapPp! - 12.5) < 1e-8,
  "percentage-point differences against sourced benchmarks",
);
assert(
  review.benchmark.foodRatio === .414 &&
    review.benchmark.hiredLaborRatio === .175,
  "verified 2025 survey/2024 actual institutional cafeteria benchmark",
);
assert(
  review.benchmark.sample === 78 &&
    review.benchmark.source.includes("mafra.go.kr"),
  "explicit cohort and primary source",
);
assert(
  m.partialSales && m.cautions.length > 0,
  "partial sales and non-identical cost basis prohibit certainty",
);
assert(
  JSON.stringify(report) === before,
  "analysis never alters report amounts",
);
const blank =
  buildCostReview(buildTaxReport({ ...state, sales: {} }, "2026-10-13"))
    .months["2026-10"];
assert(
  blank.foodRatio === null && blank.laborRatio === null,
  "zero/absent revenue never becomes infinite ratios",
);
const noPurchases =
  buildCostReview(buildTaxReport({ ...state, orders: {} }, "2026-10-13"))
    .months["2026-10"];
assert(noPurchases.foodRatio === null, "no invoice is not zero food cost");
let calls = 0;
const fetcher = ((_url: unknown, opts: RequestInit) => {
  calls++;
  const req = JSON.parse(String(opts.body)),
    input = JSON.parse(req.input[0].content[0].text.split("\n").at(-1));
  assert(
    input.costReview.benchmark.sample === 78 &&
      input.costReview.months["2026-10"].foodRatio === .7,
    "same tax request includes cost evidence",
  );
  assert(
    TAX_AI_PROMPT.includes("과다") && TAX_AI_PROMPT.includes("개별 업체") &&
      TAX_AI_PROMPT.includes("costChecks"),
    "cost review and no fictional peer data required",
  );
  return Promise.resolve(
    new Response(JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            summary: "증빙 확인",
            checks: ["매출 입력 확인"],
            costChecks: [
              "식재비 비율 높음: 선매입·재고 확인",
              "인건비 비율 높음: 야간 및 부분 매출 확인",
            ],
          }),
        }],
      }],
    })),
  );
}) as typeof fetch;
const ai = await reviewTax(report, {
  apiKey: "fixture",
  baseUrl: "https://opencode.ai/zen/go/v1",
  model: "gpt-6-luna",
  fetcher,
});
assert(
  calls === 1 && ai.costChecks.length === 2,
  "one shared AI call for tax and cost review",
);
assert(
  JSON.stringify(report) === before,
  "model review cannot rewrite taxes or costs",
);
console.log(
  "SOURCED_INSTITUTIONAL_CAFETERIA_COST_RATIOS_GAPS_UNKNOWNS_PARTIAL_SALES_SINGLE_AI_CALL_NO_AMOUNT_WRITES_OK",
);
