// Offline HTTP contract: mapping comes from AI, financial values only from source cells.
import { createHandler } from "../supabase/functions/nmf-invoice-ocr/index.ts";
import {
  materializeSheet,
  validateSheet,
} from "../supabase/functions/nmf-invoice-ocr/sheet.ts";
const password = "sheet-offline-test", now = Date.UTC(2026, 9, 17);
const encoder = new TextEncoder();
let checks = 0;
function assert(v: unknown, label: string): asserts v {
  if (!v) throw Error(label);
  checks++;
}
const sheet = {
  name: "10월 납품",
  fileName: "새로운 업체.xlsx",
  cells: [
    { a: "A1", v: "공급업체" },
    { a: "B1", v: "검증유통" },
    { a: "A2", v: "2026-10-12", d: "2026-10-12" },
    { a: "A4", v: "양파" },
    { a: "B4", v: "10kg/망" },
    { a: "C4", v: 2 },
    { a: "D4", v: 15000 },
    { a: "E4", v: 30000 },
    { a: "F4", v: 0 },
    { a: "A5", v: "세제" },
    { a: "C5", v: "생수×3" },
    { a: "A6", v: "합계" },
    { a: "E6", v: 30000 },
    { a: "A10", v: "2026-10-13" },
    { a: "A11", v: "당근" },
    { a: "E11", v: 5000 },
  ],
};
const mapping = {
  documents: [
    {
      date: "A2",
      vendor: "B1",
      total: "E6",
      items: [
        {
          name: ["A4"],
          spec: ["B4"],
          qty: "C4",
          price: "D4",
          amt: "E4",
          tax: "F4",
        },
        { name: ["A5"], qty: "C5" },
      ],
    },
    { date: "A10", vendor: "B1", items: [{ name: ["A11"], amt: "E11" }] },
  ],
};
const wire = (value: unknown) =>
  new Response(
    JSON.stringify({
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(value) }],
    }),
  );
let calls: Record<string, unknown>[] = [], current: unknown = mapping;
const handler = createHandler({
  now: () => now,
  env: (
    key,
  ) => ({ NMF_PW: password, OPENCODE_GO_API_KEY: "offline-key" }[key] ||
    ""),
  fetchImpl: (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    assert(
      body.messages[0].content.some((c: { text?: string }) =>
        /JSON/.test(c.text || "")
      ),
      "JSON mode declares its format in user input as well as system instructions",
    );
    return calls.length % 2 === 1
      ? wire(current)
      : new Response("unavailable", { status: 503 });
  }) as typeof fetch,
});
async function request(value: unknown) {
  const body = encoder.encode(
    JSON.stringify({
      action: "extract",
      app: "food",
      nonce: crypto.randomUUID(),
      documentType: "spreadsheet",
      spreadsheet: value,
    }),
  );
  const hex = (v: ArrayBuffer) =>
    Array.from(new Uint8Array(v), (x) => x.toString(16).padStart(2, "0")).join(
      "",
    );
  const hash = hex(await crypto.subtle.digest("SHA-256", body));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`nmf-invoice:${hash}:${now}`),
    ),
  );
  return handler(
    new Request("https://offline/functions/v1/nmf-invoice-ocr", {
      method: "POST",
      headers: {
        origin: "https://d-bae.com",
        "content-type": "application/json",
        "x-nmf-time": String(now),
        "x-nmf-signature": sig,
      },
      body,
    }),
  );
}
let response = await request(sheet), result = await response.json();
assert(
  response.status === 200 && result.documents?.length === 2,
  "native spreadsheet creates both dated invoices without an example template: " +
    JSON.stringify(result),
);
assert(
  calls.length === 2,
  "one layout interpretation and one pooled label review per sheet",
);
assert(
  result.documents[0].document.vendor === "검증유통",
  "supplier comes from mapped source cell, not buyer",
);
assert(
  result.documents[0].document.date === "2026-10-12" &&
    result.documents[1].document.date === "2026-10-13",
  "dates remain transaction specific",
);
const rows = result.documents[0].document.items;
assert(
  rows[0].qty === 2 && rows[0].amt === 30000 && rows[0].price === 15000 &&
    rows[0].tax === 0,
  "typed zero and financial values are preserved exactly",
);
assert(
  rows[1].name === "세제" && rows[1].qty === "생수×3" && rows[1].amt === null &&
    rows[1].tax === null,
  "named amountless rows and literal quantity notes remain editable",
);
assert(
  result.documents.every((d: { sourceKey: string }) =>
    /^[a-f0-9]{64}$/.test(d.sourceKey)
  ),
  "stable source identities returned",
);
assert(
  !JSON.stringify(calls).includes("input_image") &&
    JSON.stringify(calls[0]).includes("untrusted"),
  "native cells are text data, with fixed untrusted-source instructions",
);
const keys = result.documents.map((d: { sourceKey: string }) => d.sourceKey)
  .sort();
calls = [];
current = { documents: [...mapping.documents].reverse() };
result = await (await request(sheet)).json();
assert(
  JSON.stringify(keys) ===
    JSON.stringify(
      result.documents.map((d: { sourceKey: string }) => d.sourceKey).sort(),
    ),
  "AI result order cannot change duplicate identity",
);
for (
  const bad of [{ ...sheet, cells: [{ a: "A1", v: 1e16 }] }, {
    ...sheet,
    cells: [...sheet.cells, sheet.cells[0]],
  }, { ...sheet, cells: [{ a: "XFD999999", v: "big" }] }]
) {
  calls = [];
  response = await request(bad);
  assert(
    response.status === 400 && calls.length === 0,
    "invalid cells never reach paid/provider processing",
  );
}
calls = [];
current = {
  documents: [{ vendor: "B1", items: [{ name: ["A4"], amt: "Z99" }] }],
};
response = await request(sheet);
assert(
  response.status === 502 && calls.length === 1,
  "hallucinated cell references reject the entire sheet, not partial money",
);
calls = [];
current = {
  documents: [{ vendor: "B1", items: [{ name: ["A4"], amt: 999999 }] }],
};
response = await request(sheet);
assert(
  response.status === 502,
  "AI supplied literal financial numbers are rejected",
);
calls = [];
current = { documents: [] };
result = await (await request(sheet)).json();
assert(
  result.ok && result.documents.length === 0 && calls.length === 1,
  "summary-only sheets may be skipped without invented invoices",
);
const [typed] = await materializeSheet(
  validateSheet({
    name: "형식 검증",
    fileName: "test.xlsx",
    cells: [
      { a: "A1", v: "검증유통" },
      { a: "B1", v: 12, w: "000012" },
      { a: "A2", v: 46307, w: "2026-10-12", d: "2026-10-12" },
      { a: "A3", v: "양파" },
      { a: "B3", v: "(1,500)원" },
      { a: "C3", v: "1,2" },
      { a: "D3", v: null, f: true },
    ],
  }),
  {
    documents: [{
      vendor: "A1",
      invoiceNo: "B1",
      date: "A2",
      items: [{ name: ["A3"], qty: "C3", price: "B3", amt: "D3" }],
    }],
  },
);
assert(
  typed.document.invoiceNo === "000012" && typed.document.date === "2026-10-12",
  "formatted identifiers retain zeros and typed Excel dates do not shift timezone",
);
assert(
  typed.document.items[0].price === -1500 &&
    typed.document.items[0].qty === "1,2" &&
    typed.document.items[0].amt === null,
  "returns parse without inventing ambiguous numbers or missing formula results",
);
assert(
  typed.document.items[0].warnings.some((w) => w.includes("계산식")),
  "missing formula cache is actionable, not silently zero",
);
console.log(`INVOICE_SHEET_HTTP_OK ${checks} assertions`);
