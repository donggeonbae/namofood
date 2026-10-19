// Offline tests of the actual authenticated card OCR handler. No real network.
import { createHandler } from "../supabase/functions/nmf-invoice-ocr/index.ts";
import {
  sanitizeCardText,
  validateCardDocument,
} from "../supabase/functions/nmf-invoice-ocr/card.ts";

const NOW = Date.UTC(2026, 9, 11, 1);
const PASSWORD = "offline-card-test-password";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=";
const env = (
  key: string,
) => ({ NMF_PW: PASSWORD, OPENCODE_GO_API_KEY: "offline-go-key" }[key] || "");
let checks = 0;
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
  checks++;
}
async function request(extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({
    action: "extract",
    app: "food",
    nonce: crypto.randomUUID(),
    documentType: "card",
    image: { mime: "image/png", data: PNG },
    ...extra,
  });
  const bytes = new TextEncoder().encode(body);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PASSWORD),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`nmf-invoice:${digest}:${NOW}`),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return new Request("https://offline.test/ocr", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://d-bae.com",
      "x-nmf-time": String(NOW),
      "x-nmf-signature": signature,
    },
    body,
  });
}
function response(document: unknown) {
  return Response.json({
    status: "completed",
    error: null,
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(document) }],
    }],
  });
}
const transaction = {
  date: "2026-10-10",
  time: "00:05",
  merchant: "테스트 식자재",
  amount: 35000,
  status: "approved",
  cardLabel: "테스트 카드 1234",
  last4: "1234",
  approvalNo: "87654321",
  installment: "일시불",
  note: "",
  warnings: [],
};
let calls = 0;
const handler = createHandler({
  env,
  now: () => NOW,
  fetchImpl: ((url, init) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert(
      String(url) === "https://opencode.ai/inference/go/anthropic/v1/messages",
      "card uses only the Go Responses endpoint",
    );
    assert(
      payload.model === "claude-haiku-5-5" && !("reasoning" in payload),
      "card uses the selected Luna model without reasoning",
    );
    assert(
      !("store" in payload) && payload.stream === false &&
        payload.max_tokens === 8192,
      "card provider persistence and limits unchanged",
    );
    assert(
      payload.messages[0].content.length === 2 &&
        payload.messages[0].content[1].type === "image",
      "card image included once",
    );
    assert(
      payload.system.includes("신뢰할 수 없는") &&
        payload.system.includes("CVC") &&
        payload.system.includes("청구"),
      "card prompt isolates image instructions and excludes sensitive/summary data",
    );
    assert(
      !JSON.stringify(payload).includes(PASSWORD),
      "password never sent to OCR provider",
    );
    return Promise.resolve(
      response({ transactions: [transaction], warnings: [] }),
    );
  }) as typeof fetch,
});
const extracted = await handler(await request());
const extractedBody = await extracted.json();
assert(
  extracted.status === 200,
  "real handler accepts the card document contract",
);
assert(
  extractedBody.documentType === "card",
  "card response is distinguished from invoice",
);
assert(
  extractedBody.document.transactions[0].amount === 35000,
  "card row survives parsing",
);
assert(calls === 1, "card image uses exactly one provider call");
assert(
  extractedBody.model === "claude-haiku-5-5" &&
    extractedBody.processedAt === new Date(NOW).toISOString(),
  "card processing metadata is real handler metadata",
);
assert(
  /^[a-f0-9]{64}$/.test(extractedBody.imageSha256),
  "card response includes image digest, not the photo",
);
assert(
  !("labelReview" in extractedBody) && !("rawText" in extractedBody.document) &&
    !JSON.stringify(extractedBody).includes(PNG),
  "card has no second-pass, raw text, or photo response",
);
assert(
  extracted.headers.get("access-control-allow-origin") ===
      "https://d-bae.com" &&
    extracted.headers.get("cache-control") === "no-store",
  "card CORS and no-store remain request-scoped",
);

const status = await handler(await request({ action: "status" }));
const statusBody = await status.json();
assert(
  statusBody.cardOcrEnabled === true && statusBody.cardMaxProviderCalls === 1,
  "status advertises card single-pass support",
);
assert(
  statusBody.labelReviewEnabled === true && statusBody.maxProviderCalls === 2 &&
    statusBody.imageStored === false && statusBody.provider === "OpenCode Go",
  "legacy invoice status fields unchanged",
);
assert(calls === 1, "status does not call provider");

const cancelled = validateCardDocument({
  transactions: [{ ...transaction, amount: -35000, status: "cancelled" }, {
    ...transaction,
    amount: -1200,
  }],
});
assert(
  cancelled.transactions[0].amount === 35000 &&
    cancelled.transactions[0].status === "cancelled",
  "cancellation amount is positive magnitude without netting away row",
);
assert(
  cancelled.transactions[1].amount === 1200 &&
    cancelled.transactions[1].status === "unknown" &&
    cancelled.transactions[1].warnings.some((warning) =>
      warning.includes("음수")
    ),
  "negative amount contradicting approval becomes unknown with warning, not fabricated cancellation",
);
const unknown = validateCardDocument({
  transactions: [{
    ...transaction,
    date: "2026-02-30",
    time: "24:00",
    amount: null,
    status: "판독불가",
  }, { ...transaction, date: null, time: null, status: null }],
});
assert(
  unknown.transactions[0].date === null &&
    unknown.transactions[0].time === null &&
    unknown.transactions[0].amount === null &&
    unknown.transactions[0].status === "unknown",
  "invalid/unknown readings remain null/unknown, never fabricated",
);
assert(
  unknown.transactions[0].warnings.length >= 4 &&
    unknown.transactions[1].date === null,
  "uncertain date, time, amount, status have visible warnings",
);
assert(
  validateCardDocument({
    transactions: [{
      ...transaction,
      date: "2024-02-29",
      time: "23:59",
      amount: 0,
    }],
  }).transactions[0].date === "2024-02-29",
  "valid leap date, 24-hour time and explicitly read zero accepted",
);

const PAN = "4111111111111111",
  PHONE = "010-1234-5678",
  ACCOUNT = "123-45-678901";
const privateText =
  `카드번호 ${PAN} 전화 ${PHONE} 계좌번호 ${ACCOUNT} CVC:987 비밀번호:DO_NOT_RETURN`;
const privacy = validateCardDocument({
  rawText: privateText,
  image: PNG,
  warnings: [privateText],
  transactions: [{
    ...transaction,
    merchant: privateText,
    cardLabel: "테스트 4111-1111-1111-1111",
    last4: PAN,
    approvalNo: privateText,
    installment: privateText,
    note: privateText,
    warnings: [privateText],
    password: "DO_NOT_RETURN",
  }],
});
const privacyJson = JSON.stringify(privacy);
for (
  const token of [
    PAN,
    PHONE,
    ACCOUNT,
    "987",
    "DO_NOT_RETURN",
    PNG,
    "4111-1111-1111-1111",
  ]
) {
  assert(
    !privacyJson.includes(token),
    "private data omitted from every card response field",
  );
}
assert(
  privacy.transactions[0].last4 === "" &&
    Object.keys(privacy).join(",") === "transactions,warnings",
  "only exact last four digits allowed; arbitrary raw fields dropped",
);
assert(
  validateCardDocument({ transactions: [{ ...transaction, last4: "5678" }] })
    .transactions[0].last4 === "5678",
  "last four digits preserved when explicitly read",
);
assert(
  !sanitizeCardText("계좌번호 123 45 678901").includes("678901"),
  "grouped labelled account is fully redacted",
);
assert(
  !sanitizeCardText("Account:12345678 Phone:1234567 CVC:9 8 7").match(
    /123456|9 8 7/,
  ),
  "English labelled account, phone, and spaced CVC redacted",
);
assert(
  !sanitizeCardText("비밀번호 p a s s w o r d").includes("p a s s"),
  "spaced password text not retained",
);
assert(
  !validateCardDocument({
    transactions: [{ ...transaction, cardLabel: "테스트 4111 1111" }],
  }).transactions[0].cardLabel.includes("4111"),
  "card label cannot expose more than last four digits",
);
assert(
  !sanitizeCardText("4111\u200b1111\u200b1111\u200b1111").includes(
    "4111111111111111",
  ),
  "invisible separators cannot leak full PAN",
);
assert(
  !sanitizeCardText("02-123-4567").includes("02-123-4567"),
  "short landline phone is redacted",
);
assert(
  !sanitizeCardText("4111-****-****-5678").includes("4111"),
  "masked PAN prefix is not exposed",
);
const summary = validateCardDocument({
  transactions: [transaction, { ...transaction, merchant: "청구금액" }, {
    ...transaction,
    kind: "statement_total",
  }],
});
assert(
  summary.transactions.length === 1 && summary.warnings.length > 0,
  "known statement total/payment rows excluded with warning",
);
function rejects(value: unknown, label: string) {
  let rejected = false;
  try {
    validateCardDocument(value);
  } catch {
    rejected = true;
  }
  assert(rejected, label);
}
for (const amount of ["35,000", 1.1, NaN, Infinity, 1e12 + 1, -1e12 - 1]) {
  rejects(
    { transactions: [{ ...transaction, amount }] },
    "non-numeric, fractional, non-finite, excessive amounts rejected",
  );
}
rejects(
  { transactions: Array.from({ length: 1001 }, () => transaction) },
  "more than 200 transaction rows rejected",
);
assert(
  validateCardDocument({
    transactions: Array.from({ length: 200 }, () => transaction),
  }).transactions.length === 200,
  "200-row limit accepted exactly",
);
rejects({ transactions: [null] }, "malformed row rejected");
rejects(
  { transactions: [{ ...transaction, merchant: { secret: PAN } }] },
  "non-string field never serialized",
);
rejects(
  { transactions: [{ ...transaction, currency: "USD" }] },
  "explicit foreign-currency row rejected",
);
rejects(
  { transactions: [transaction], currency: "EUR" },
  "explicit foreign-currency document rejected",
);
assert(
  validateCardDocument({ transactions: [{ ...transaction, currency: "KRW" }] })
    .transactions[0].amount === 35000,
  "explicit KRW accepted without returning currency extras",
);

const replayRequest = await request();
assert(
  (await handler(replayRequest.clone())).status === 200,
  "first nonce accepted",
);
const beforeReplay = calls;
assert(
  (await handler(replayRequest.clone())).status === 409 &&
    calls === beforeReplay,
  "card shares existing nonce replay defense",
);
const tampered = await request();
tampered.headers.set("x-nmf-signature", "0".repeat(64));
assert(
  (await handler(tampered)).status === 401 && calls === beforeReplay,
  "card preserves HMAC authentication",
);
assert(
  (await handler(await request({ documentType: "cards" }))).status === 400 &&
    calls === beforeReplay,
  "unknown document type rejected before provider",
);
assert(
  (await handler(await request({ image: { mime: "image/png", data: "bad" } })))
        .status === 400 && calls === beforeReplay,
  "card shares existing image bounds/type validation",
);
const hostile = await request();
hostile.headers.set("origin", "https://hostile.invalid");
const hostileResponse = await handler(hostile);
assert(
  hostileResponse.status === 403 &&
    !hostileResponse.headers.has("access-control-allow-origin"),
  "untrusted origin remains denied",
);
const noOrigin = await request();
noOrigin.headers.delete("origin");
assert(
  (await handler(noOrigin)).status === 200,
  "existing authenticated origin-less clients remain supported",
);

let invalidCalls = 0;
const invalidHandler = createHandler({
  env,
  now: () => NOW,
  fetchImpl: (() => {
    invalidCalls++;
    return Promise.resolve(
      response({ transactions: [{ ...transaction, amount: 1.5 }] }),
    );
  }) as typeof fetch,
});
const invalidResponse = await invalidHandler(await request());
assert(
  invalidResponse.status === 502 && invalidCalls === 1,
  "invalid card document fails closed with no corrective/review call",
);
const upstreamHandler = createHandler({
  env,
  now: () => NOW,
  fetchImpl: (() =>
    Promise.resolve(
      new Response(`secret ${PAN}`, { status: 429 }),
    )) as typeof fetch,
});
const upstreamResponse = await upstreamHandler(await request());
const upstreamBody = await upstreamResponse.json();
assert(
  upstreamResponse.status === 502 && upstreamBody.providerStatus === 429 &&
    !JSON.stringify(upstreamBody).includes(PAN),
  "safe upstream classification never reflects sensitive body",
);
let timeoutCalls = 0, aborted = false;
const timeoutHandler = createHandler({
  env,
  now: () => NOW,
  timeoutMs: 10,
  fetchImpl: ((_url, init) => {
    timeoutCalls++;
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true })
    );
  }) as typeof fetch,
});
const timeoutResponse = await timeoutHandler(await request());
assert(
  timeoutResponse.status === 504 && timeoutCalls === 1 && aborted,
  "card shared timeout aborts one call without retry",
);
let unfinishedCalls = 0;
const unfinishedHandler = createHandler({
  env,
  now: () => NOW,
  fetchImpl: (() => {
    unfinishedCalls++;
    return Promise.resolve(
      Response.json({
        status: "incomplete",
        output_text: JSON.stringify({ transactions: [transaction] }),
        incomplete_details: { reason: "max_output_tokens" },
      }),
    );
  }) as typeof fetch,
});
assert(
  (await unfinishedHandler(await request())).status === 502 &&
    unfinishedCalls === 1,
  "incomplete provider response cannot masquerade as accepted card rows",
);
console.log(`CARD_OCR_OK ${checks} checks`);
