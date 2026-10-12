// Synthetic supplier/recipient regressions. No source photos, secrets or live requests.
import {
  applyLabelReview,
  INVOICE_PROMPT,
  labelReviewInput,
  sha256,
  validateDocument,
} from "../supabase/functions/nmf-invoice-ocr/lib.ts";
import { createHandler } from "../supabase/functions/nmf-invoice-ocr/index.ts";

const invoice = {
  date: "2026-10-09",
  vendor: "",
  invoiceNo: "SYNTHETIC-1",
  subtotal: 100,
  tax: 10,
  total: 110,
  previousBalance: 20,
  balanceTotal: 130,
  rawText: "",
  warnings: ["기존 원문 확인 안내"],
  items: [{
    name: "테스트 식자재",
    spec: "1kg",
    qty: 1,
    unit: "개",
    price: 110,
    supplyAmount: 100,
    amt: 110,
    tax: 10,
    confidence: 0.99,
    warnings: [],
  }],
};
type Case = {
  name: string;
  vendor: string;
  rawText: string;
  expected: string;
  fields?: Record<string, unknown>;
};
const cases: Case[] = [
  ...[
    "나모푸드 貴 中",
    "나모푸드 귀중",
    "나모카페",
    "namo(2차)",
    "공급자:namo(2차)",
  ]
    .map((vendor, i) => ({
      name: `known recipient spelling ${i + 1}`,
      vendor,
      rawText: `거래명세표\n${vendor}\n테스트 식자재 1개 110`,
      expected: "",
    })),
  {
    name: "buyer error recovers only a clear supplier header",
    vendor: "나모푸드 貴 中",
    rawText:
      "거래명세표\n나모푸드 貴 中\n공급자 상호: 친친\n사업자등록번호: 000-00-00000",
    expected: "친친",
  },
  {
    name: "corrupted supplier label cannot override buyer honorific",
    vendor: "나모푸드 貴 中",
    rawText: "공급자: 나모푸드 貴 中 | 상호 친친",
    expected: "친친",
  },
  {
    name: "separate company header survives recipient-only title",
    vendor: "나모푸드 貴 中",
    rawText: "나모푸드 貴 中 | 상호 친친",
    expected: "친친",
  },
  {
    name: "same-line recipient and supplier columns stay distinct",
    vendor: "나모푸드 貴 中",
    rawText: "공급받는자: 나모푸드 貴 中 | 공급자 상호: 친친",
    expected: "친친",
  },
  {
    name: "missing supplier name is never filled from known candidates",
    vendor: "나모푸드 貴 中",
    rawText:
      "공급자: 나모푸드 貴 中 | 사업자등록번호: 000-00-00000 | 거래명세표",
    expected: "",
  },
  {
    name: "business block label itself is never an extra supplier",
    vendor: "나모푸드 귀중",
    rawText: "공급자\n사업자등록번호: 000-00-00000\n상호: 친친\n나모푸드 귀중",
    expected: "친친",
  },
  {
    name: "compact supplier label keeps the actual company only",
    vendor: "나모푸드",
    rawText: "공급자상호:친친\n나모푸드 귀중",
    expected: "친친",
  },
  {
    name: "business address is not another company candidate",
    vendor: "나모푸드",
    rawText:
      "공급자\n사업자등록번호: 000-00-00000\n주소: 테스트시 테스트로\n상호: 친친\n나모푸드 귀중",
    expected: "친친",
  },
  {
    name: "bank-like word inside a real company name is permitted",
    vendor: "은행나무유통",
    rawText: "공급자 상호: 은행나무유통\n나모푸드 귀중",
    expected: "은행나무유통",
  },
  {
    name: "corporate suffix cannot disguise a known buyer",
    vendor: "나모푸드(주)",
    rawText: "공급자 상호: 나모푸드(주)",
    expected: "",
  },
  {
    name: "unknown supplier remains possible",
    vendor: "namo(2차)",
    rawText:
      "공급자\n상호: 테스트새봄유통\n사업자등록번호: 000-00-00000\n공급받는자\n상호: 나모푸드",
    expected: "테스트새봄유통",
  },
  {
    name: "exact Hanmaeum supplier alias",
    vendor: "한마음",
    rawText: "공급자 상호: 한마음\n공급받는자: 나모푸드",
    expected: "한마음푸드",
  },
  {
    name: "exact Chinchin supplier alias",
    vendor: "친친푸드",
    rawText: "공급자 상호: 친친푸드\n나모푸드 귀중",
    expected: "친친",
  },
  {
    name: "recipient company is not a supplier allowlist",
    vendor: "친친",
    rawText: "공급받는자\n상호: 친친\n사업자등록번호: 000-00-00000",
    expected: "",
  },
  {
    name: "unknown recipient honorific is excluded",
    vendor: "테스트받는회사",
    rawText: "거래명세표\n테스트받는회사 귀중\n테스트 식자재 1개 110",
    expected: "",
  },
  ...["거래명세표", "2026-10-09", "농협은행", "000-00-00000", "예금주 테스트"]
    .map((vendor, i) => ({
      name: `non-company field ${i + 1}`,
      vendor,
      rawText: `${vendor}\n나모푸드 귀중\n테스트 식자재 1개 110`,
      expected: "",
    })),
  {
    name: "account holder occurrence alone does not confirm supplier",
    vendor: "친친",
    rawText:
      "나모푸드 귀중\n예금주: 친친\n은행: 테스트은행\n테스트 식자재 1개 110",
    expected: "",
  },
  {
    name: "memo occurrence alone does not confirm supplier",
    vendor: "한마음",
    rawText: "나모푸드 귀중\n메모: 한마음\n테스트 식자재 1개 110",
    expected: "",
  },
  {
    name: "explicit first-pass supplier requires literal evidence",
    vendor: "나모푸드",
    rawText: "공급자 상호: 친친\n나모푸드 귀중",
    fields: {
      supplierName: "친친",
      buyerName: "나모푸드",
      supplierEvidence: "공급자 상호: 친친",
    },
    expected: "친친",
  },
  {
    name: "invented supplier evidence fails closed",
    vendor: "친친",
    rawText: "나모푸드 귀중\n테스트 식자재 1개 110",
    fields: {
      supplierName: "친친",
      buyerName: "나모푸드",
      supplierEvidence: "상호: 친친",
    },
    expected: "",
  },
  {
    name: "bank-holder excerpt cannot be promoted to supplier evidence",
    vendor: "친친",
    rawText: "공급자 상호: 친친\n예금주: 친친\n나모푸드 귀중",
    fields: { supplierName: "친친", supplierEvidence: "예금주: 친친" },
    expected: "",
  },
  {
    name: "buyer-block business registration is not supplier evidence",
    vendor: "친친",
    rawText: "공급받는자\n상호: 친친\n사업자등록번호: 000-00-00000",
    fields: { supplierName: "친친", supplierEvidence: "상호: 친친" },
    expected: "",
  },
  {
    name: "supplier letterhead requires a nearby business identity",
    vendor: "테스트새봄유통",
    rawText:
      "테스트새봄유통 거래명세표\n사업자등록번호: 000-00-00000\n나모푸드 귀중",
    fields: {
      supplierName: "테스트새봄유통",
      supplierEvidence: "테스트새봄유통 거래명세표",
    },
    expected: "테스트새봄유통",
  },
  {
    name: "generic statement heading is not a company",
    vendor: "거래명세표",
    rawText: "거래명세표\n사업자등록번호: 000-00-00000\n나모푸드 귀중",
    fields: { supplierName: "거래명세표", supplierEvidence: "거래명세표" },
    expected: "",
  },
  {
    name: "unclear two-supplier source is not silently chosen",
    vendor: "나모푸드",
    rawText: "공급자 상호: 친친\n공급자 상호: 한마음푸드\n나모푸드 귀중",
    expected: "",
  },
  {
    name: "legacy synthetic nonbuyer remains compatible",
    vendor: "나모 식자재",
    rawText: "테스트 식자재 1개 110",
    expected: "나모 식자재",
  },
  {
    name: "similar Hanmaeum name is not rewritten to a known candidate",
    vendor: "테스트한마음유통",
    rawText: "공급자 상호: 테스트한마음유통\n나모푸드 귀중",
    expected: "테스트한마음유통",
  },
];
let checks = 0;
const failures: string[] = [];
function check(value: unknown, name: string) {
  checks++;
  if (!value) failures.push(name);
}
for (const test of cases) {
  const source = {
    ...invoice,
    ...test.fields,
    vendor: test.vendor,
    rawText: test.rawText,
  };
  const result = validateDocument(source);
  check(result.vendor === test.expected, test.name);
  check(
    JSON.stringify({
      date: result.date,
      invoiceNo: result.invoiceNo,
      subtotal: result.subtotal,
      tax: result.tax,
      total: result.total,
      previousBalance: result.previousBalance,
      balanceTotal: result.balanceTotal,
      items: result.items,
      rawText: result.rawText,
    }) === JSON.stringify({
      date: source.date,
      invoiceNo: source.invoiceNo,
      subtotal: source.subtotal,
      tax: source.tax,
      total: source.total,
      previousBalance: source.previousBalance,
      balanceTotal: source.balanceTotal,
      items: source.items,
      rawText: source.rawText,
    }),
    `${test.name}: supplier handling preserves every other original field`,
  );
  check(
    result.warnings.includes("기존 원문 확인 안내"),
    `${test.name}: keeps original warnings`,
  );
  if (!test.expected) {
    check(
      result.warnings.some((value) => /공급|거래처/.test(value)),
      `${test.name}: blank supplier needs review`,
    );
  }
  check(
    JSON.stringify(Object.keys(result).sort()) ===
      JSON.stringify(Object.keys(invoice).sort()),
    `${test.name}: output schema is unchanged`,
  );
}
const reviewed = validateDocument({
  ...invoice,
  vendor: "나모푸드 귀중",
  rawText: "공급자 상호: 친친\n나모푸드 귀중",
});
const protectedBefore = JSON.stringify({ ...reviewed, items: undefined });
applyLabelReview(reviewed, {
  items: [{
    rowIndex: 0,
    name: "테스트식자재",
    spec: "1kg",
    unit: "개",
    uncertain: false,
  }],
}, "offline-model");
check(
  JSON.stringify({ ...reviewed, items: undefined }) === protectedBefore,
  "second item-label pass cannot change original supplier/date/amounts/raw evidence",
);
check(
  !labelReviewInput(reviewed).includes("vendor"),
  "supplier is not exposed as an item-label edit target",
);
const beforeRejectedReview = JSON.stringify(reviewed);
try {
  applyLabelReview(
    reviewed,
    { vendor: "나모푸드", total: 999, items: [] },
    "offline-model",
  );
  check(false, "label review rejects supplier/numeric edits");
} catch {
  check(
    JSON.stringify(reviewed) === beforeRejectedReview,
    "rejected label response is atomic",
  );
}
check(
  /貴\s*中/.test(INVOICE_PROMPT) && /귀중/.test(INVOICE_PROMPT),
  "first extraction prompt explicitly separates honorific recipients",
);
check(
  /supplierEvidence/.test(INVOICE_PROMPT) && /사업자/.test(INVOICE_PROMPT),
  "first extraction requires supplier identity evidence",
);
const now = Date.UTC(2026, 9, 11, 1), password = "offline-supplier-test";
const bytes = new TextEncoder().encode(JSON.stringify({
  app: "food",
  nonce: "00000000-0000-4000-8000-000000000001",
  action: "extract",
  image: {
    mime: "image/png",
    data:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=",
  },
}));
const signingKey = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const signature = [
  ...new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      signingKey,
      new TextEncoder().encode(`nmf-invoice:${await sha256(bytes)}:${now}`),
    ),
  ),
].map((byte) => byte.toString(16).padStart(2, "0")).join("");
let providerCalls = 0;
const handler = createHandler({
  now: () => now,
  env: (
    key,
  ) => ({
    NMF_PW: password,
    OPENCODE_GO_API_KEY: "offline-provider-key",
  }[key] || ""),
  fetchImpl: (_url, options) => {
    providerCalls++;
    const input = JSON.parse(String(options?.body));
    check(
      input.store === false,
      `provider call ${providerCalls} requests no response storage`,
    );
    const output = providerCalls === 1
      ? {
        ...invoice,
        vendor: "나모푸드 貴 中",
        supplierName: "친친",
        buyerName: "나모푸드",
        supplierEvidence: "상호 친친",
        rawText: "공급자: 나모푸드 貴 中 | 상호 친친",
      }
      : { vendor: "나모푸드", total: 999, items: [] };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(output) }],
          }],
        }),
        { status: 200 },
      ),
    );
  },
});
const response = await handler(
  new Request("https://offline.invalid/invoice", {
    method: "POST",
    headers: {
      origin: "https://d-bae.com",
      "content-type": "application/json",
      "x-nmf-time": String(now),
      "x-nmf-signature": signature,
    },
    body: bytes,
  }),
);
const responseBody = await response.json();
check(
  response.status === 200 && responseBody.document.vendor === "친친",
  "signed real HTTP handler applies first-pass supplier evidence",
);
check(
  providerCalls === 2 && responseBody.labelReview.status === "failed",
  "invoice remains bounded to two calls and rejects non-label second-pass output",
);
check(
  responseBody.document.total === invoice.total &&
    responseBody.document.date === invoice.date &&
    responseBody.document.rawText === "공급자: 나모푸드 貴 中 | 상호 친친",
  "HTTP second-pass failure preserves supplier/raw evidence and original numeric/date fields",
);
if (failures.length) {
  throw new Error(`SUPPLIER_REGRESSION_FAILED: ${failures.join("; ")}`);
}
console.log(
  JSON.stringify({
    ok: true,
    checks,
    cases: cases.length,
    providerFixtureCalls: providerCalls,
    productionCalls: 0,
    databaseWrites: 0,
  }),
);
