import { createHandler } from "../supabase/functions/nmf-coupang/handler.ts";
import { signature } from "../supabase/functions/nmf-coupang/protocol.mjs";
import { GO_MODEL } from "../supabase/functions/_shared/opencode-go.ts";
const assert = (v: unknown, m: string) => {
  if (!v) throw Error(m);
};
const id = crypto.randomUUID(), lease = crypto.randomUUID();
let kind = "import",
  through: unknown = "untouched",
  completed = 0,
  failures = 0;
const handler = createHandler({
  env: (k) => ({
    "NMF_PW": "test-app",
    "NMF_COUPANG_WORKER_TOKEN": "test-worker",
    "OPENCODE_API_KEY": "test-ai",
  }[k] || ""),
  queue: {
    info: async () => ({ online: true, lastImportThrough: "2026-10-18" }),
    beginFinish: async () => ({
      kind,
      from_date: "2026-10-01",
      to_date: "2026-10-21",
    }),
    done: async (
      _id: string,
      _lease: string,
      _cipher: string,
      value: unknown,
    ) => {
      through = value;
      completed++;
    },
    fail: async () => {
      failures++;
    },
  },
  fetcher: (async () =>
    new Response(
      JSON.stringify({
        type: "message",
        role: "assistant",
        model: GO_MODEL,
        stop_reason: "end_turn",
        content: [{ type: "text", text: '{"orders":[]}' }],
      }),
    )) as typeof fetch,
});
async function request(body: Record<string, unknown>) {
  const raw = JSON.stringify({
      nonce: crypto.randomUUID(),
      jobId: id,
      lease,
      ...body,
    }),
    time = String(Date.now());
  return handler(
    new Request("https://test", {
      method: "POST",
      headers: {
        "x-nmf-time": time,
        "x-nmf-signature": await signature(
          body.role === "app" ? "test-app" : "test-worker",
          body.role,
          time,
          raw,
        ),
      },
      body: raw,
    }),
  );
}
const defaults =
  await (await request({ role: "app", room: "namostore", action: "defaults" }))
    .json();
assert(
  defaults.worker.lastImportThrough === "2026-10-18" && !defaults.job,
  "defaults is small, authenticated, and excludes order bodies",
);
const snapshot = {
  pages: [{ text: "선택 기간 완료 주문 없음", links: [] }],
  truncated: false,
};
assert(
  (await request({ role: "worker", action: "finish", snapshot })).status ===
      200 && through === "2026-10-21",
  "full success advances to requested through date",
);
through = "untouched";
await request({
  role: "worker",
  action: "finish",
  snapshot: { ...snapshot, truncated: true },
});
assert(through === null, "partial scan must not skip unread dates next time");
through = "untouched";
await request({ role: "worker", action: "finish", snapshot: { pages: [] } });
assert(
  through === "untouched" && failures === 1,
  "failed import never advances cursor",
);
kind = "login";
await request({ role: "worker", action: "finish", state: "ready" });
assert(
  through === null && completed === 3,
  "login-only completion cannot advance cursor",
);
console.log("COUPANG_CURSOR_SUCCESS_ONLY_PARTIAL_FAILED_LOGIN_PROTECTED_OK");
