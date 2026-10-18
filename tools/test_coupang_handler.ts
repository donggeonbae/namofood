import { createHandler } from "../supabase/functions/nmf-coupang/handler.ts";
import { organize } from "../supabase/functions/nmf-coupang/ai.ts";
import { signature } from "../supabase/functions/nmf-coupang/protocol.mjs";
const assert = (v: unknown, message: string) => {
  if (!v) throw Error(message);
};
let calls = 0;
const queue = {
  info: async () => {
    calls++;
    return { online: true, state: "ready" };
  },
  enqueue: async (id: string) => {
    calls++;
    return id;
  },
  claim: async () => {
    calls++;
    return null;
  },
};
const handler = createHandler({
  env: (key) => ({
    "NMF_PW": "test-app-password",
    "NMF_COUPANG_WORKER_TOKEN": "test-worker-password",
  }[key] || ""),
  queue,
});
async function request(
  body: Record<string, unknown>,
  secret = "test-app-password",
  origin = "https://d-bae.com",
) {
  const raw = JSON.stringify({ nonce: crypto.randomUUID(), ...body }),
    time = String(Date.now());
  return handler(
    new Request("https://example.test", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-nmf-time": time,
        "x-nmf-signature": await signature(secret, body.role, time, raw),
      },
      body: raw,
    }),
  );
}
const unauthorized = await request({
  role: "app",
  room: "namostore",
  action: "status",
}, "wrong");
assert(unauthorized.status === 401, "reject wrong signatures");
assert(calls === 0, "no DB work before auth");
assert(
  (await request({ role: "worker", action: "claim" })).status === 401,
  "app credential cannot claim worker queue",
);
assert(
  (await request({ role: "app", room: "namofood", action: "status" }))
    .status === 403,
  "room restricted",
);
assert(
  (await request(
    { role: "app", room: "namostore", action: "status" },
    "test-app-password",
    "https://evil.test",
  )).status === 403,
  "reject other origins",
);
const good = await request({
  role: "app",
  room: "namostore",
  action: "status",
});
assert(good.status === 200, "app status works");
const job = await request({
  role: "app",
  room: "namostore",
  action: "start",
  from: "2026-10-01",
  to: "2026-10-31",
});
assert(job.status === 200, "real bounded import can enqueue");
assert(
  (await request({
    role: "app",
    room: "namostore",
    action: "start",
    from: "2026-10-31",
    to: "2026-10-01",
  })).status === 400,
  "inverted period rejected",
);
assert(
  (await request({ role: "worker", action: "claim" }, "test-worker-password"))
    .status === 200,
  "worker uses separate authority",
);
const evidence =
  "2026.10.12 주문 12345678901234 배송완료 콜라 24개 2박스 30,000원";
const order = {
  orderNo: "12345678901234",
  date: "2026-10-12",
  status: "배송완료",
  total: 30000,
  evidence,
  items: [{
    name: "콜라",
    spec: "24개",
    qty: 2,
    unit: "박스",
    price: 15000,
    amt: 30000,
  }],
};
let providerCalls = 0;
const provider = (async (url: RequestInfo | URL, options?: RequestInit) => {
  assert(
    String(url) === "https://opencode.ai/zen/go/v1/responses",
    "Go endpoint only",
  );
  const body = JSON.parse(String(options?.body));
  assert(
    body.model === "gpt-6-luna" && body.store === false,
    "requested model, no response storage",
  );
  assert(
    !String(options?.body).includes("test-worker-password"),
    "no worker key in AI payload",
  );
  providerCalls++;
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({ orders: [order] }),
        }],
      }],
    }),
    { headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;
const organized = await organize(
  { pages: [{ text: evidence, links: [] }], truncated: true },
  { from: "2026-10-01", to: "2026-10-31" },
  "fake-provider-key",
  provider,
);
assert(
  providerCalls === 1 && organized.orders.length === 1,
  "one genuine provider-shaped response parsed",
);
assert(
  organized.orders[0].items[0].price === null,
  "calculated price not introduced",
);
assert(
  organized.truncated === true && organized.warnings.length > 0,
  "partial coverage disclosed",
);
let failed = false;
try {
  await organize(
    { pages: [{ text: evidence, links: [] }] },
    { from: "2026-10-01", to: "2026-10-31" },
    "fake-provider-key",
    (async () => new Response("{}", { status: 403 })) as typeof fetch,
  );
} catch {
  failed = true;
}
assert(failed, "provider access denial is not a success or paid fallback");
console.log(
  "COUPANG_AUTH_BODY_ROLE_ROOM_ORIGIN_PERIOD_QUEUE_AI_GROUNDING_GO_ONLY_PARTIAL_FAILURE_OK",
);
