// Synthetic transcription contracts only. No provider calls or ledger writes.
import {
  applyLabelReview,
  INVOICE_PROMPT,
  labelReviewInput,
  validateDocument,
} from "../supabase/functions/nmf-invoice-ocr/lib.ts";

const source = {
  date: "2026-10-03",
  vendor: "테스트음료",
  total: 419400,
  rawText: "테스트음료",
  warnings: [],
  items: [
    {
      name: "인쇄된 미거래 품목",
      qty: null,
      price: null,
      amt: null,
      hasEntry: false,
    },
    { name: "인쇄된 보증금", qty: null, price: 3500, amt: null },
    { name: "", qty: null, price: null, amt: null },
    { name: "환타오렌지", qty: "파워에이드×3", amt: 54000 },
    { name: "", qty: "생수×3", amt: 11400 },
    { name: "", qty: 3, amt: 60000 },
    { name: "콜라", qty: 3, price: 22000, amt: 66000 },
    { name: "스프라이트", qty: "1,234.5", amt: 228000 },
  ],
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(label + ": " + JSON.stringify(actual));
  }
};
const before = JSON.stringify(source), result = validateDocument(source);
eq(
  result.items.length,
  7,
  "retain named rows even without amounts, omitting only wholly empty rows",
);
eq(
  result.items.map((r) => r.qty),
  [null, null, "파워에이드×3", "생수×3", 3, 3, 1234.5],
  "retain quantity-cell words, never extract their embedded number",
);
eq(result.items.map((r) => r.name), [
  "인쇄된 미거래 품목",
  "인쇄된 보증금",
  "환타오렌지",
  "",
  "",
  "콜라",
  "스프라이트",
], "uncertain product names may stay blank");
eq(
  result.items.reduce((s, r) => s + (r.amt || 0), 0),
  419400,
  "never fill or change a transaction amount",
);
eq(result.total, 419400, "printed total retained");
eq(JSON.stringify(source), before, "no source mutation");
const review = applyLabelReview(result, {
  items: result.items.map((r, rowIndex) => ({
    rowIndex,
    name: r.name || "멋대로 추정한 음료",
    spec: r.spec,
    unit: r.unit,
    uncertain: false,
  })),
}, "fixture");
eq(
  result.items[3].name,
  "",
  "label review must not invent missing handwritten names",
);
eq(result.items[4].name, "", "a second blank name stays blank");
eq(
  review.status,
  "partial",
  "invented labels are rejected without rejecting the valid invoice",
);
eq(
  result.items[2].qty,
  "파워에이드×3",
  "label review cannot interpret quantity notes",
);
eq(
  labelReviewInput(result).includes("파워에이드×3"),
  true,
  "the second text-only pass receives literal handwritten notes as context",
);
eq(
  JSON.parse(labelReviewInput(result)).outputFormat,
  "JSON",
  "the text-only pass explicitly requests JSON to satisfy provider JSON-mode validation",
);
const marked = validateDocument({
  ...source,
  items: [{ name: "", qty: null, price: null, amt: null, hasEntry: true }],
});
eq(
  marked.items.length,
  1,
  "an explicitly marked but illegible handwritten row stays editable",
);
eq(marked.items[0].name, "", "no placeholder name is invented");
if (
  !INVOICE_PROMPT.includes("손글씨") || !INVOICE_PROMPT.includes("hasEntry")
) {
  throw Error(
    "prompt must describe marked rows and literal handwritten transcription",
  );
}
if (
  !INVOICE_PROMPT.includes("품목명과 단가만 미리 인쇄") ||
  !INVOICE_PROMPT.includes("가장자리의 잘린 다른 영수증")
) {
  throw Error(
    "prompt must describe price-only catalogue rows and neighboring receipts",
  );
}
console.log(
  "HANDWRITTEN_QUANTITY_TEXT_BLANK_NAMES_TEMPLATE_FILTER_LABEL_PROTECTION_AMOUNTS_UNCHANGED_OK",
);
