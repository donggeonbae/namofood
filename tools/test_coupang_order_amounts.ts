import { organize } from "../supabase/functions/nmf-coupang/ai.ts";
import { validateOrders } from "../supabase/functions/nmf-coupang/protocol.mjs";
import { GO_MODEL } from "../supabase/functions/_shared/opencode-go.ts";
const assert = (v: unknown, m: string) => {
  if (!v) throw Error(m);
};
const orderNo = "12345678901234",
  range = { from: "2026-10-20", to: "2026-10-22" };
const item = (name: string, qty: number | null = null) => ({
  name,
  spec: "",
  unit: "개",
  qty,
  price: null,
  amt: null,
});
const provider = (rows: unknown[]) =>
  (async () =>
    new Response(
      JSON.stringify({
        type: "message",
        role: "assistant",
        model: GO_MODEL,
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify({ orders: rows }) }],
      }),
    )) as typeof fetch;
async function organizeOne(
  body: string,
  items: ReturnType<typeof item>[],
  status = "배송중",
  date = "2026-10-20",
) {
  const text =
    `주문상세\n2026. 10. 20 주문주문번호 ${orderNo}\n${status}\n2026. 10. 22 도착예정\n${body}`;
  return organize(
    {
      pages: [{
        text,
        links: [{
          orderNo,
          path: "/ssr/desktop/order/" + orderNo,
          text: "주문 상세보기",
        }],
      }],
    },
    range,
    "test-only",
    provider([{ sourcePage: 0, orderNo, date, status, total: null, items }]),
  );
}
const one = await organizeOne(
  "고래밥, 46g, 60개\n34,990 원\n1개\n장바구니 담기\n총 상품가격\n34,990 원\n할인금액\n-2,990 원\n배송비\n0 원\n총 결제금액\n32,000 원",
  [item("고래밥", 1)],
);
assert(
  one.orders[0].date === "2026-10-20",
  "order date is retained even when delivery is later",
);
assert(
  one.orders[0].items[0].amt === 32000,
  "single-product amount must be the observed actual paid total, not the pre-discount price",
);
assert(
  one.orders[0].items[0].price === 34990,
  "observed listed price remains separate from paid amount",
);
const formattedSource =
  `주문상세\n2026. 10. 20 주문주문번호 ${orderNo}\n배송완료\n콜라\n10,000 원\n1개\n총 결제금액\n9,000 원`;
const formatted = await organize(
  {
    pages: [{
      text: formattedSource,
      links: [{
        orderNo,
        path: "/ssr/desktop/order/" + orderNo,
        text: "주문 상세보기",
      }],
    }],
  },
  range,
  "test-only",
  provider([{
    sourcePage: 0,
    orderNo,
    date: "2026-10-20",
    status: "배송완료",
    total: "9,000",
    items: [{ ...item("콜라", 1), price: "10,000", amt: "9,000" }],
  }]),
);
assert(
  formatted.orders[0].items[0].amt === 9000,
  "fully identified source amounts must not depend on AI using a numeric rather than formatted-string JSON field",
);
let sourceProviderCalls = 0;
const nativeSource = formattedSource.replace(
  "총 결제금액",
  "총 상품가격\n10,000 원\n할인금액\n-1,000 원\n배송비\n0 원\n총 결제금액",
);
const direct = await organize(
  {
    pages: [{
      text: nativeSource,
      links: [{
        orderNo,
        path: "/ssr/desktop/order/" + orderNo,
        text: "주문 상세보기",
      }],
    }],
  },
  range,
  "test-only",
  (async () => {
    sourceProviderCalls++;
    throw Error("No AI needed for a complete, verified standard detail");
  }) as typeof fetch,
);
assert(
  direct.orders[0].items[0].amt === 9000 && sourceProviderCalls === 0 &&
    direct.extraction.sourceOrders === 1,
  "standard source extraction must not fail when the AI provider is unavailable",
);
const multi = await organizeOne(
  "콜라\n10,000 원\n2개\n장바구니 담기\n생수\n2,000 원\n3개\n장바구니 담기\n총 상품가격\n26,000 원\n할인금액\n-1,000 원\n배송비\n3,000 원\n총 결제금액\n28,000 원",
  [item("콜라", 2), item("생수", 3)],
);
assert(
  JSON.stringify(multi.orders[0].items.map((i) => i.amt)) === "[20000,6000]",
  "confirmed source quantities and subtotal disambiguate unit prices from line amounts",
);
assert(
  multi.orders[0].total === 28000 && !!multi.orders[0].amountNote,
  "order discount/shipping remains separate and visible, never allocated arbitrarily",
);
let rejected = false;
try {
  await organizeOne(
    "콜라\n1,000 원\n1개\n총 결제금액\n1,000 원",
    [item("콜라", 1)],
    "배송중",
    "2026-10-22",
  );
} catch {
  rejected = true;
}
assert(
  rejected,
  "a delivery date cannot pass as the order date just because both appear in the evidence",
);
for (
  const status of [
    "주문완료",
    "결제완료",
    "상품준비중",
    "배송준비중",
    "배송중",
    "배송완료",
    "구매확정",
  ]
) {
  const evidence = `2026. 10. 20 주문번호 ${orderNo} ${status} 콜라 1개 1000원`;
  assert(
    validateOrders(
      {
        orders: [{
          orderNo,
          date: "2026-10-20",
          status,
          evidence,
          total: 1000,
          items: [{ ...item("콜라", 1), amt: 1000 }],
        }],
      },
      evidence,
      range,
    ).length === 1,
    `${status} is eligible by order date, not delivery completion`,
  );
}
for (const status of ["취소완료", "반품완료", "환불완료", "결제대기"]) {
  const evidence = `2026. 10. 20 주문번호 ${orderNo} ${status} 콜라 1개 1000원`;
  let rejected = false;
  try {
    validateOrders(
      {
        orders: [{
          orderNo,
          date: "2026-10-20",
          status,
          evidence,
          total: 1000,
          items: [item("콜라", 1)],
        }],
      },
      evidence,
      range,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, `${status} cannot become procurement`);
}
console.log(
  "COUPANG_ORDER_NOT_DELIVERY_DATE_PENDING_SINGLE_PAID_MULTI_SUBTOTAL_AMOUNTS_NO_FAKE_ALLOCATION_OK",
);
