import {
  INVOICE_PROMPT,
  validateDocument,
} from "../supabase/functions/nmf-invoice-ocr/lib.ts";
const check = (ok: boolean, msg: string) => {
  if (!ok) throw Error(msg);
};
const base = {
  date: "2026-10-12",
  vendor: "가상유통",
  supplierName: "가상유통",
  supplierEvidence: "가상유통",
  rawText:
    "거래처별판매일보\n가상유통\n26.10.01~26.10.17\n거래처 출일 품목 합계\nnam 26.10.12 가상상품 100",
  total: 100,
  items: [{ name: "판매상품", qty: 1, price: 100, amt: 100, confidence: 1 }, {
    name: "인쇄가격표",
    qty: null,
    price: 900,
    amt: null,
    confidence: 1,
    hasEntry: false,
  }],
};
const doc = validateDocument(base);
check(
  doc.vendor === "가상유통",
  "sales ledger seller heading with no business-number box remains supported",
);
check(doc.items.length === 2, "catalog source rows must remain");
check(
  !doc.warnings.some((s) => s.includes("품목 합계가")),
  "catalog blanks do not hide or invent transaction amounts",
);
const bad = validateDocument({ ...base, total: 90 });
check(
  bad.warnings.some((s) => s.includes("품목 합계가")),
  "arithmetic must check active rows even when preprinted blank rows exist",
);
check(
  INVOICE_PROMPT.includes("일계") && INVOICE_PROMPT.includes("누계") &&
    INVOICE_PROMPT.includes("거래처별판매일보"),
  "summary-row and seller prompt rules",
);
console.log("INVOICE_LEDGER_SELLER_ACTIVE_ROW_SUM_BLANK_CATALOG_OK");
