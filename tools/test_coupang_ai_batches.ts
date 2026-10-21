import { organize } from "../supabase/functions/nmf-coupang/ai.ts";
import { GO_MODEL } from "../supabase/functions/_shared/opencode-go.ts";

const range = { from: "2026-10-01", to: "2026-10-21" };
const assert = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
const pages = Array.from({ length: 11 }, (_, i) => {
  const orderNo = String(12345678901200 + i);
  return {
    text:
      `주문상세\n2026. 10. 20 주문주문번호 ${orderNo}\n배송완료\n검증 콜라 ${i}\n30,000 원\n2개\n총 결제금액\n30,000 원`,
    links: [{
      text: "주문 상세보기",
      path: `/ssr/desktop/order/${orderNo}`,
      orderNo,
    }],
  };
});
const native = (orders: unknown[], stop_reason = "end_turn") =>
  new Response(JSON.stringify({
    type: "message",
    role: "assistant",
    model: GO_MODEL,
    stop_reason,
    content: [{ type: "text", text: JSON.stringify({ orders }) }],
  }));
const rows = (source: typeof pages) =>
  source.map((p, sourcePage) => ({
    sourcePage,
    orderNo: p.links[0].orderNo,
    date: "2026-10-20",
    status: "배송완료",
    total: null,
    // No AI echo of the original evidence: the server binds the exact detail page.
    items: [{
      name: p.text.match(/검증 콜라 \d+/)![0],
      spec: "",
      unit: "개",
      qty: 2,
      price: null,
      amt: 30000,
    }],
  }));
let calls = 0, peak = 0, active = 0;
const provider = (async (_url, init) => {
  calls++;
  active++;
  peak = Math.max(peak, active);
  const request = JSON.parse(String(init?.body));
  const input = JSON.parse(request.messages[0].content[0].text);
  assert(
    input.pages.length <= 4,
    "one AI call must not receive the entire month's orders",
  );
  assert(request.model === GO_MODEL, "do not change providers or models");
  await Promise.resolve();
  active--;
  return native(rows(input.pages));
}) as typeof fetch;
const result = await organize({ pages }, range, "test-only", provider);
assert(
  result.orders.length === 11 && calls === 3 && peak <= 3,
  "all eleven orders survive three bounded batches",
);
assert(
  result.orders.every((o) => o.total === 30000 && o.items[0].qty === 2),
  "observed totals and quantities retained without guesses",
);
assert(
  !JSON.stringify(result).includes("sourcePage"),
  "internal source references are not public business fields",
);
for (
  const variant of ["wrong-page", "fake-item", "fake-date", "missing-order"]
) {
  let failed = false;
  try {
    await organize(
      { pages: pages.slice(0, 2) },
      range,
      "test-only",
      (async () => {
        const orders = rows(pages.slice(0, 2));
        if (variant === "wrong-page") orders[0].sourcePage = 1;
        if (variant === "fake-item") orders[0].items[0].name = "없는 상품";
        if (variant === "fake-date") orders[0].date = "2026-10-19";
        if (variant === "missing-order") orders.pop();
        return native(orders);
      }) as typeof fetch,
    );
  } catch {
    failed = true;
  }
  assert(
    failed,
    `${variant} must still fail grounding; do not weaken validation`,
  );
}
let attempts = 0;
const recovered = await organize(
  { pages: pages.slice(0, 4) },
  range,
  "test-only",
  (async (_url, init) => {
    attempts++;
    const input = JSON.parse(
      JSON.parse(String(init?.body)).messages[0].content[0].text,
    );
    return native(
      rows(input.pages),
      input.pages.length > 2 ? "max_tokens" : "end_turn",
    );
  }) as typeof fetch,
);
assert(
  recovered.orders.length === 4 && attempts === 3,
  "a truncated batch splits instead of accepting partial JSON or repeating the same large prompt",
);
let incomplete = "";
try {
  await organize(
    { pages: pages.slice(0, 1) },
    range,
    "test-only",
    (async () => native([], "max_tokens")) as typeof fetch,
  );
} catch (e) {
  incomplete = (e as Error).message;
}
assert(
  incomplete === "ai_output_limit",
  "an unsplittable response reports the actual failure reason",
);
console.log(
  "COUPANG_BATCH_SOURCE_BINDING_STRICT_NEGATIVES_OUTPUT_LIMIT_SPLIT_OK",
);
