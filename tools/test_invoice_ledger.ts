import { materializeLedger } from "../supabase/functions/nmf-invoice-ocr/ledger.ts";
import { createHandler } from "../supabase/functions/nmf-invoice-ocr/index.ts";
import {
  type SheetCell,
  validateSheet,
} from "../supabase/functions/nmf-invoice-ocr/sheet.ts";
import { validateDocument } from "../supabase/functions/nmf-invoice-ocr/lib.ts";
import {
  GO_BASE,
  GO_MODEL,
  goEndpoint,
  goHeaders,
  goMessages,
  responsesEnvelope,
} from "../supabase/functions/_shared/opencode-go.ts";
const assert = (v: unknown, text: string) => {
  if (!v) throw Error(text);
};
const cells: SheetCell[] = [{
  a: "A1",
  v: "회사명 : 검증식품 / 2026/10/01 ~ 2026/10/17 ",
}];
const put = (r: number, values: unknown[]) =>
  values.forEach((v, c) => {
    if (v !== null) {
      cells.push({
        a: String.fromCharCode(65 + c) + r,
        v: v as string | number,
      });
    }
  });
put(2, [
  "일자-No.",
  "품목명(규격)",
  "수량",
  "단가",
  "공급가액",
  "부가세",
  "합계",
  "거래처명",
  "적요",
]);
for (let i = 0; i < 228; i++) {
  put(i + 3, [
    i < 100 ? "2026/10/01 -49" : "2026/10/01 -93",
    `품목${i} [4kg]`,
    i === 0 ? -1 : 1,
    1000,
    i === 0 ? -1000 : 1000,
    null,
    i === 0 ? -1000 : 1000,
    "나모푸드",
    "",
  ]);
}
put(231, ["2026/10/01  계", null, 226, null, 226000, null, 226000]);
put(232, ["총합계", null, 226, null, 226000, null, 226000]);
put(233, ["2026/10/17 (토) 오후 3:42:21"]);
const sheet = validateSheet({
  name: "판매현황내역",
  fileName: "원장.xlsx",
  cells,
});
const documents = (await materializeLedger(sheet))!;
assert(
  documents.length === 2,
  "same day different invoice numbers stay separate",
);
assert(
  documents.reduce((n, d) => n + d.document.items.length, 0) === 228,
  "all 228 rows survive past old 200 limit",
);
assert(
  documents[0].document.total === 98000 &&
    documents[1].document.total === 128000,
  "daily aggregate never assigned to one invoice",
);
assert(
  documents.every((d) =>
    d.document.vendor === "검증식품" && d.document.date === "2026-10-01"
  ),
  "seller title beats buyer column; footer timestamp ignored",
);
assert(
  documents.every((d) =>
    d.document.tax === null && d.document.items.every((i) => i.tax === null)
  ),
  "blank VAT remains blank, not zero",
);
assert(
  documents.every((d) =>
    d.sourceAudit?.totalMatches &&
    d.sourceAudit.sourceType === "period-ledger" &&
    d.sourceAudit.sheetItemCount === 228
  ),
  "period source and exact total audit for double-count exclusion",
);
assert(
  documents[0].document.items[0].amt === -1000 &&
    documents[0].document.items[0].spec === "4kg",
  "return sign and source spec preserved",
);
assert(
  documents.every((d) =>
    d.sourceRefs.includes("A1") && d.sourceRefs.includes("G232") &&
    /^[a-f0-9]{64}$/.test(d.sourceKey)
  ),
  "source evidence and deterministic identities",
);
const again = await materializeLedger(sheet);
assert(
  again![0].sourceKey === documents[0].sourceKey,
  "reupload dedup identity stable",
);
const unpriced = structuredClone(sheet);
unpriced.cells = unpriced.cells.filter((c) => !["E230", "G230"].includes(c.a));
// All source rows are kept, including missing amounts; a multi-invoice day's
// printed total must not be used to invent an individual invoice amount.
const withBlank = (await materializeLedger(unpriced))!;
assert(
  withBlank[1].document.items.at(-1)!.amt === null &&
    withBlank[1].document.total === null,
  "amountless named rows never silently become zero or borrow another invoice total",
);
const mismatched = structuredClone(sheet);
mismatched.cells.find((c) => c.a === "G232")!.v = 1;
assert(
  (await materializeLedger(mismatched))!.every((d) =>
    !d.sourceAudit!.totalMatches && d.document.warnings.length
  ),
  "mismatch is visible, never fixed by inventing money",
);
const malformed = structuredClone(sheet);
malformed.cells.find((c) => c.a === "A3")!.v = "2026/02/30 -1";
let failed = false;
try {
  await materializeLedger(malformed);
} catch {
  failed = true;
}
assert(failed, "invalid row date rejects whole source, no partial import");
const unknown = structuredClone(sheet);
unknown.cells.find((c) => c.a === "A1")!.v = "unfamiliar title";
assert(
  await materializeLedger(unknown) === null,
  "unrecognized layouts retain AI mapping fallback",
);
const long = "긴품목명".repeat(90);
const big = validateDocument({
  items: Array.from(
    { length: 1000 },
    () => ({ name: long, spec: long, qty: 1, amt: 10 }),
  ),
  vendor: "검증유통",
  date: "2026-10-01",
});
assert(
  big.items.length === 1000 && big.items[0].name === long &&
    big.items[0].spec === long,
  "1000 items and 450-character labels survive validation",
);
failed = false;
try {
  validateDocument({
    items: Array.from({ length: 1001 }, () => ({ name: "품목" })),
  });
} catch {
  failed = true;
}
assert(failed, "over-limit requests still fail atomically");
const native = goMessages({
  instructions: "JSON only",
  max_output_tokens: 8192,
  input: [{
    role: "user",
    content: [{ type: "input_text", text: "source" }, {
      type: "input_image",
      image_url: "data:image/png;base64,YQ==",
    }],
  }],
});
assert(
  native.model === GO_MODEL && native.messages[0].content[1].type === "image" &&
    !("reasoning" in native) && !("store" in native),
  "native Anthropic image transport, no incompatible OpenAI options",
);
assert(
  goEndpoint("https://opencode.ai/zen/go/v1", GO_MODEL, "responses") ===
    GO_BASE + "/messages",
  "legacy Go base safely maps to Go Anthropic, never paid Zen",
);
assert(
  goHeaders({ "x-opencode-session": "session" }).get("anthropic-version") ===
    "2023-06-01",
  "version and session headers preserved",
);
for (const reason of ["max_tokens", "tool_use", "refusal", null]) {
  assert(
    responsesEnvelope({
      type: "message",
      role: "assistant",
      stop_reason: reason,
      content: [{ type: "text", text: "{}" }],
    }).status !== "completed",
    "non-final native responses are rejected: " + reason,
  );
}
const valid = responsesEnvelope({
  type: "message",
  role: "assistant",
  model: GO_MODEL,
  stop_reason: "end_turn",
  content: [{ type: "text", text: "{}" }],
});
assert(
  valid.status === "completed" && valid.output[0].content[0].text === "{}",
  "completed native response normalizes without financial rewriting",
);
let nativeCalls = 0;
const password = "offline-ledger-http",
  stamp = String(Date.now()),
  encoder = new TextEncoder();
const handler = createHandler({
  env: (
    key,
  ) => ({ NMF_PW: password, OPENCODE_GO_API_KEY: "offline-test" }[key] ||
    ""),
  fetchImpl: (async (_url, init) => {
    nativeCalls++;
    const req = JSON.parse(String(init?.body)),
      labels = JSON.parse(req.messages[0].content[0].text);
    return new Response(JSON.stringify({
      type: "message",
      role: "assistant",
      model: GO_MODEL,
      stop_reason: "end_turn",
      content: [{
        type: "text",
        text: JSON.stringify({
          items: labels.items.map((row: Record<string, unknown>) => ({
            ...row,
            uncertain: false,
          })),
        }),
      }],
    }));
  }) as typeof fetch,
});
const hex = (v: ArrayBuffer) =>
  [...new Uint8Array(v)].map((x) => x.toString(16).padStart(2, "0")).join("");
const keyBytes = await crypto.subtle.importKey(
  "raw",
  encoder.encode(password),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
async function http(aware: boolean) {
  const raw = JSON.stringify({
    action: "extract",
    app: "food",
    documentType: "spreadsheet",
    nonce: crypto.randomUUID(),
    spreadsheet: sheet,
    supportsLedgerReview: aware,
  });
  const hash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(raw)));
  const sig = hex(
    await crypto.subtle.sign(
      "HMAC",
      keyBytes,
      encoder.encode(`nmf-invoice:${hash}:${stamp}`),
    ),
  );
  return handler(
    new Request("https://offline/functions/v1/nmf-invoice-ocr", {
      method: "POST",
      headers: {
        origin: "https://d-bae.com",
        "content-type": "application/json",
        "x-nmf-time": stamp,
        "x-nmf-signature": sig,
      },
      body: raw,
    }),
  );
}
const stale = await http(false);
assert(
  stale.status === 409 &&
    (await stale.json()).code === "client_update_required" && nativeCalls === 0,
  "old open clients cannot accidentally count the ledger as new financial purchases",
);
const fresh = await http(true), freshData = await fresh.json();
assert(
  fresh.status === 200 && freshData.documents.length === 2 &&
    nativeCalls === 1 &&
    freshData.documents.every((d: { sourceAudit?: { sourceType: string } }) =>
      d.sourceAudit?.sourceType === "period-ledger"
    ),
  "updated HTTP client receives all source-linked invoices with one native Haiku label review",
);
const thinking = responsesEnvelope({
  type: "message",
  role: "assistant",
  model: GO_MODEL,
  stop_reason: "end_turn",
  content: [
    { type: "thinking", thinking: '{"wrong":"reasoning is not data"}' },
    { type: "redacted_thinking", data: "hidden" },
    { type: "text", text: '{"items":[]}' },
  ],
});
assert(
  thinking.status === "completed" && thinking.output[0].content.length === 1 &&
    thinking.output[0].content[0].text === '{"items":[]}',
  "Haiku reasoning blocks never become invoice data and do not discard its final text",
);
console.log(
  "LEDGER_228_ROWS_DATES_SELLER_INVOICE_TOTALS_RETURNS_BLANK_VAT_SOURCE_DEDUP_1000_ITEMS_LONG_LABELS_HAIKU_NATIVE_OK",
);
