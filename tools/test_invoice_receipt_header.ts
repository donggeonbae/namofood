// Source-bound receipt dates and merchants; no provider or database writes.
import {
  INVOICE_PROMPT,
  validateDocument,
} from "../supabase/functions/nmf-invoice-ocr/lib.ts";
const base = {
  date: "2025-10-12",
  vendor: "식자재마트 강서점",
  supplierName: "식자재마트 강서점",
  supplierEvidence: "식자재마트 강서점",
  buyerName: "",
  items: [{ name: "식자재", qty: 3, price: 12000, amt: 36000 }],
  total: 99500,
  warnings: [],
};
function eq(a: unknown, b: unknown, message: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error(message + ": " + JSON.stringify(a));
  }
}
for (
  const rule of [
    "판매일:26-10-12",
    "식자재마트 강서점",
    "다른 영수증에 그 업체명을 일괄 적용하지",
    "과세 물품액만을 전체 공급가 합계",
    "할인 안내액을 다시 빼지",
  ]
) {
  if (!INVOICE_PROMPT.includes(rule)) {
    throw Error("missing corrected receipt instruction: " + rule);
  }
}
const receipt = validateDocument({
  ...base,
  rawText:
    "식자재마트 강서점\n000-00-00000 테스트대표\n테스트시 테스트로\n판매일:26-10-12 03:57\n품목 단가 수량 금액\n식자재 12000 3 36000\n합계 99500\n거래NO:251012709929\n2510127099293",
});
eq(
  receipt.date,
  "2026-10-12",
  "explicit sale date outranks conflicting barcode digits and model year",
);
eq(
  receipt.vendor,
  "식자재마트 강서점",
  "retail heading with adjacent business identity is supplier evidence without a recipient block",
);
eq(
  receipt.total,
  99500,
  "date and vendor corrections never change financial values",
);
for (
  const [raw, date] of [
    ["판매일:26-10-12\n거래일:2026-10-13", "2025-10-12"],
    ["판매일:26-02-30", "2025-10-12"],
    ["거래NO:261012709929\n바코드:2610127099293", "2025-10-12"],
    ["판매일:25-10-12\n거래NO:261012709929", "2025-10-12"],
    ["발급일:2026-10-15\n판매일:2026년 10월 12일", "2026-10-12"],
    ["공급받는자\n식자재마트 강서점\n000-00-00000", "2025-10-12"],
  ] as const
) {
  const doc = validateDocument({ ...base, rawText: raw });
  eq(
    doc.date,
    date,
    "ambiguous/invalid dates and unlabelled identifiers never invent a sale date",
  );
  if (raw.startsWith("공급받는자")) {
    eq(doc.vendor, "", "recipient cannot become a receipt supplier");
  }
}
eq(
  validateDocument({ ...base, rawText: "식자재마트 강서점\n매출 합계 99500" })
    .vendor,
  "",
  "a retail word without identity is not sufficient evidence",
);
console.log(
  "RECEIPT_LABELED_DATE_BARCODE_CONFLICT_AMBIGUITY_INVALID_CALENDAR_RETAIL_HEADER_RECIPIENT_AND_AMOUNTS_OK",
);
