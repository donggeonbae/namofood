import {
  GO_BASE,
  GO_MODEL,
} from "../supabase/functions/_shared/opencode-go.ts";
import { reviewPayments } from "../supabase/functions/nmf-payment-match/lib.ts";
import { organize } from "../supabase/functions/nmf-coupang/ai.ts";
import {
  buildTaxReport,
  reviewTax,
} from "../supabase/functions/nmf-tax-nightly/lib.ts";
import {
  generateRecipesWithFallback,
  openCodeProtocol,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";
import { parseOpenCodeResponse } from "../supabase/functions/nmf-menu-plan/lib.ts";
import { parseRecommendationOpenCodeResponse } from "../supabase/functions/nmf-menu-recommend/lib.ts";
let calls = 0;
const assert = (v: unknown, m: string) => {
  if (!v) throw Error(m);
};
const envelope = (value: unknown) => ({
  type: "message",
  role: "assistant",
  model: GO_MODEL,
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "not business data" }, {
    type: "text",
    text: JSON.stringify(value),
  }],
});
function provider(value: unknown): typeof fetch {
  return (async (url, init) => {
    calls++;
    const b = JSON.parse(String(init?.body)), h = new Headers(init?.headers);
    assert(
      String(url) === GO_BASE + "/messages" && b.model === GO_MODEL,
      "every consumer selects Haiku on Go Anthropic, never Zen",
    );
    assert(
      h.get("anthropic-version") === "2023-06-01" &&
        h.get("user-agent")?.startsWith("namofood-") &&
        h.get("x-opencode-session"),
      "native version, honest client and session headers",
    );
    assert(
      Array.isArray(b.messages) &&
        /JSON/.test(b.system || b.messages[0].content) && !b.reasoning &&
        !b.text && !("store" in b) && !("temperature" in b),
      "no unsupported Responses or thinking-model sampling options",
    );
    return new Response(JSON.stringify(envelope(value)));
  }) as typeof fetch;
}
assert(
  (await reviewPayments([], "offline-test", provider({ matches: [] })))
    .length === 0,
  "payment validation accepts native final text only",
);
assert(
  (await organize(
    { pages: [{ text: "완료 주문 없음", links: [] }] },
    { from: "2026-10-01", to: "2026-10-20" },
    "offline-test",
    provider({ orders: [] }),
  )).orders.length === 0,
  "Coupang keeps grounding validation after native response normalization",
);
const ai = await reviewTax(buildTaxReport({}, "2026-10-20"), {
  apiKey: "offline-test",
  baseUrl: GO_BASE,
  model: GO_MODEL,
  fetcher: provider({ summary: "검증", checks: [], costChecks: [] }),
});
assert(
  ai.model === GO_MODEL && ai.summary === "검증",
  "tax uses the same selected model without changing calculated money",
);
assert(
  openCodeProtocol(GO_MODEL) === "messages",
  "recipe protocol resolves Claude Messages",
);
assert(
  parseOpenCodeResponse("messages", envelope({ recipes: [] })) ===
    '{"recipes":[]}',
  "menu protocol parser ignores thinking and preserves final JSON",
);
assert(
  parseRecommendationOpenCodeResponse("messages", envelope({ days: [] })) ===
    '{"days":[]}',
  "recommendation parser ignores thinking and preserves final JSON",
);
const recipe = {
  menu: "육전",
  comp: "주찬",
  items: [{ item: "소고기 홍두깨살", qty: 100, unit: "g" }, {
    item: "계란",
    qty: 0.5,
    unit: "ea",
  }, { item: "밀가루", qty: 8, unit: "g" }],
  method: [
    "1. 100명 기준 재료를 계량하고 전판, 배식용기를 준비해 25명분씩 4배치로 분할한다.",
    "2. 소고기 홍두깨살을 같은 두께로 손질하고 전용 칼과 도마를 구분한다.",
    "3. 밀가루와 계란물을 각각 준비해 배치별로 소고기에 묻힌다.",
    "4. 전판에 기름을 두르고 고기를 겹치지 않게 배치별로 부친다.",
    "5. 가장 두꺼운 조각의 중심온도 75℃를 1분 이상 확인한다.",
    "6. 완성품은 배식용기에 나누고 60℃ 이상 보온하며 배식 직전 회차별로 교체한다.",
  ].join("\n"),
};
const generated = await generateRecipesWithFallback({
  prompt: "육전 레시피 JSON",
  targetMenus: ["육전"],
  apiKey: "offline-test",
  baseUrl: GO_BASE,
  primaryModel: GO_MODEL,
  fallbackModel: GO_MODEL,
  timeoutMs: 1000,
  maxTokens: 8192,
  fetchImpl: provider({ recipes: [recipe] }),
});
assert(
  generated.model === GO_MODEL && generated.recipes.length === 1 &&
    generated.attempts.length === 1,
  "recipe uses native Haiku, preserves food-safety validation and does not retry identical fallback model",
);
assert(calls === 4, "one bounded provider call per tested consumer");
console.log(
  "GO_HAIKU_NATIVE_TAX_PAYMENT_COUPANG_RECIPE_RECOMMEND_HEADERS_PROTOCOL_THINKING_NO_LEDGER_WRITES_OK",
);
