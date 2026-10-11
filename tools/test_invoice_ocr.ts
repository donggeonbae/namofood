// Offline tests of the real invoice HTTP handler. No production/network writes.
import { createHandler } from "../supabase/functions/nmf-invoice-ocr/index.ts";
import { validateDocument } from "../supabase/functions/nmf-invoice-ocr/lib.ts";

const NOW = Date.UTC(2026, 9, 11, 1);
const PASSWORD = "offline-invoice-test-password";
const ORIGIN = "https://d-bae.com";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=";
const fixture = {
  date: "2026-10-09",
  vendor: "나모 식자재",
  invoiceNo: "A-10",
  subtotal: 50000,
  tax: 5000,
  total: 55000,
  rawText: "양파 10 kg 5500 공급가액 50000 부가세 5000 합계 55000",
  warnings: [],
  items: [{
    name: "양파",
    spec: "국산",
    qty: 10,
    unit: "kg",
    price: 5500,
    supplyAmount: 50000,
    amt: 55000,
    tax: 5000,
    confidence: 0.91,
    warnings: [],
  }],
};
let checks = 0, calls = 0;
const env = (
  key: string,
) => ({ NMF_PW: PASSWORD, OPENCODE_API_KEY: "offline-zen-key" }[key] || "");
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
  checks++;
}
// Real document-layout totals, with anonymized illustrative rows (not source-photo OCR).
const actualLayoutFixture = {
  date: "2026-10-09",
  vendor: "테스트 공급자",
  invoiceNo: "테스트 권호",
  subtotal: 732550,
  tax: 53450,
  total: 786000,
  previousBalance: 890200,
  balanceTotal: 1676200,
  rawText: "① 전미수금 890200 ② 당일거래합계 786000 ①+② 합계 1676200",
  warnings: [],
  items: [
    {
      name: "테스트 과세품",
      spec: "",
      qty: 5,
      unit: "개",
      price: 117590,
      supplyAmount: 534500,
      tax: 53450,
      amt: 587950,
      confidence: 0.99,
      warnings: [],
    },
    {
      name: "테스트 면세품",
      spec: "",
      qty: 10,
      unit: "kg",
      price: 19805,
      supplyAmount: 198050,
      tax: null,
      amt: 198050,
      confidence: 0.99,
      warnings: [],
    },
  ],
};
const layout = validateDocument(actualLayoutFixture);
assert(
  layout.previousBalance === 890200 && layout.balanceTotal === 1676200 &&
    layout.total === 786000,
  "retain prior balance separately from current purchase total",
);
assert(
  layout.items[0].supplyAmount === 534500 && layout.items[0].tax === 53450 &&
    layout.items[0].amt === 587950 && layout.items[1].tax === null,
  "retain net/gross columns and leave blank VAT unknown",
);
async function request(
  action = "extract",
  options: {
    body?: Record<string, unknown>;
    timestamp?: number;
    origin?: string;
    tamper?: boolean;
  } = {},
) {
  const timestamp = String(options.timestamp ?? NOW);
  const body = JSON.stringify(
    options.body ||
      {
        action,
        app: "food",
        nonce: crypto.randomUUID(),
        ...(action === "extract"
          ? { image: { mime: "image/png", data: PNG } }
          : {}),
      },
  );
  const encoder = new TextEncoder();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(body)),
  );
  const hex = (bytes: Uint8Array) =>
    [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(PASSWORD),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = hex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(`nmf-invoice:${hex(digest)}:${timestamp}`),
      ),
    ),
  );
  return new Request("https://offline.invalid/functions/v1/nmf-invoice-ocr", {
    method: "POST",
    body: options.tamper ? body.replace("food", "cafe") : body,
    headers: {
      origin: options.origin ?? ORIGIN,
      "content-type": "application/json",
      "x-nmf-time": timestamp,
      "x-nmf-signature": signature,
    },
  });
}
function completedResponse(text: string) {
  return {
    status: "completed",
    error: null,
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    }],
  };
}
const provider = (input: string | URL | Request, init?: RequestInit) => {
  calls++;
  assert(
    String(input) === "https://opencode.ai/zen/go/v1/responses",
    "only the user-selected Go endpoint, never paid Zen fallback",
  );
  const sent = JSON.parse(String(init?.body));
  assert(
    sent.model === "gpt-6-luna" && sent.reasoning.effort === "none" &&
      sent.max_output_tokens === 8192,
    "bounded vision model configuration",
  );
  assert(
    !("temperature" in sent) && !("thinking" in sent) &&
      !("max_tokens" in sent) && !("messages" in sent) &&
      !("response_format" in sent) && !String(init?.body).includes(PASSWORD),
    "no Chat Completions parameters, incompatible sampling or password leak",
  );
  assert(
    Array.isArray(sent.input[0].content) &&
      sent.input[0].content[0].type === "input_text" &&
      sent.input[0].content[1].type === "input_image" &&
      sent.input[0].content[1].detail === "high" &&
      sent.input[0].content[1].image_url === `data:image/png;base64,${PNG}`,
    "actual image array sent unchanged",
  );
  assert(
    sent.store === false && sent.stream === false &&
      sent.text.format.type === "json_object" &&
      sent.instructions.includes("previousBalance"),
    "bounded nonstored JSON Responses request keeps invoice instructions",
  );
  assert(
    init?.headers &&
      new Headers(init.headers).get("authorization") ===
        "Bearer offline-zen-key",
    "server provider credential",
  );
  const providerHeaders = new Headers(init?.headers);
  assert(
    providerHeaders.get("user-agent") === "namofood-invoice-ocr/1.0" &&
      /^nmf-invoice-food-[a-f0-9-]{36}$/.test(
        providerHeaders.get("x-opencode-session") || "",
      ) && init?.redirect === "error",
    "honest app identity, per-conversation session and no redirects to other billing paths",
  );
  return Promise.resolve(
    new Response(
      JSON.stringify(completedResponse(JSON.stringify(fixture))),
    ),
  );
};
const handler = createHandler({ env, fetchImpl: provider, now: () => NOW });
let response = await handler(await request("status"));
let result = await response.json();
assert(
  response.status === 200 && result.configured === true &&
    result.imageStored === false && calls === 0,
  "status does not call provider/store images",
);
assert(
  result.provider === "OpenCode Go" && result.plan === "go",
  "status identifies the user's selected Go plan without exposing its key/base",
);
assert(
  result.model === "gpt-6-luna",
  "requested GPT-6 Luna is the exact default, never GPT-5.6 or Kimi",
);
assert(
  !JSON.stringify(result).includes("offline-zen-key"),
  "status has no secrets",
);
response = await handler(await request());
result = await response.json();
assert(
  response.status === 200 && result.document.items[0].amt === 55000 &&
    result.document.total === 55000,
  "exact printed financial values preserved",
);
assert(
  result.document.items[0].confidence === 0.91 &&
    /^[a-f0-9]{64}$/.test(result.imageSha256),
  "review confidence and image fingerprint",
);
assert(
  result.document.warnings.length === 0 &&
    result.document.items[0].warnings.length === 0,
  "valid VAT statement has no false arithmetic warning",
);
const successes = calls;
for (
  const [label, opts, expected] of [
    ["body tampering", { tamper: true }, 401],
    ["expired signature", { timestamp: NOW - 60001 }, 401],
    ["future signature", { timestamp: NOW + 60001 }, 401],
    ["attacker origin", { origin: "https://d-bae.com.attacker.invalid" }, 403],
    ["invalid nonce", {
      body: { action: "status", app: "food", nonce: "not-a-uuid" },
    }, 400],
    ["invalid app", {
      body: { action: "status", app: "other", nonce: crypto.randomUUID() },
    }, 400],
    ["missing image", {
      body: { action: "extract", app: "food", nonce: crypto.randomUUID() },
    }, 400],
    ["SVG image", {
      body: {
        action: "extract",
        app: "food",
        nonce: crypto.randomUUID(),
        image: { mime: "image/svg+xml", data: PNG },
      },
    }, 400],
    ["mismatched magic bytes", {
      body: {
        action: "extract",
        app: "food",
        nonce: crypto.randomUUID(),
        image: { mime: "image/jpeg", data: PNG },
      },
    }, 400],
    ["external image URL", {
      body: {
        action: "extract",
        app: "food",
        nonce: crypto.randomUUID(),
        image: { mime: "image/png", data: "https://private.invalid/image" },
      },
    }, 400],
  ] as const
) {
  response = await handler(await request("extract", opts));
  assert(response.status === expected, label);
}
assert(calls === successes, "invalid requests never reach paid OCR");
response = await handler(
  new Request("https://offline.invalid", {
    method: "OPTIONS",
    headers: { origin: "https://attacker.invalid" },
  }),
);
assert(
  response.status === 403 &&
    !response.headers.has("access-control-allow-origin"),
  "bad-origin preflight rejected",
);
response = await handler(
  new Request("https://offline.invalid", {
    method: "OPTIONS",
    headers: { origin: "https://donggeonbae.github.io" },
  }),
);
assert(
  response.status === 204 &&
    response.headers.get("access-control-allow-origin") ===
      "https://donggeonbae.github.io",
  "allowed preflight",
);
const replay = await request();
await handler(replay.clone());
response = await handler(replay.clone());
assert(
  response.status === 409 && calls === successes + 1,
  "replay cannot cause another billed extraction",
);
const unavailable = createHandler({
  env: (k) => k === "NMF_PW" ? PASSWORD : "",
  fetchImpl: provider,
  now: () => NOW,
});
response = await unavailable(await request("status"));
result = await response.json();
assert(
  result.configured === false,
  "missing Go credentials are reported unavailable",
);
response = await unavailable(await request());
assert(
  response.status === 503,
  "missing Go key extraction is explicit unavailable",
);
const badBase = createHandler({
  env: (k) =>
    k === "NMF_INVOICE_BASE_URL" ? "https://opencode.ai/zen/v1" : env(k),
  fetchImpl: provider,
  now: () => NOW,
});
response = await badBase(await request("status"));
assert(
  (await response.json()).configured === false,
  "normal Zen override is rejected instead of creating additional paid usage",
);
for (
  const [keys, expectedKey] of [
    [{ OPENCODE_GO_API_KEY: "go-only-key" }, "go-only-key"],
    [{
      OPENCODE_GO_API_KEY: "go-preferred-key",
      OPENCODE_API_KEY: "generic-key",
    }, "go-preferred-key"],
    [{
      NMF_INVOICE_API_KEY: "invoice-override-key",
      OPENCODE_GO_API_KEY: "go-key",
      OPENCODE_API_KEY: "generic-key",
    }, "invoice-override-key"],
  ] as const
) {
  const nonce = crypto.randomUUID();
  let selectedKeyCalls = 0;
  const keyHandler = createHandler({
    env: (key) =>
      key === "NMF_PW" ? PASSWORD : (keys as Record<string, string>)[key] || "",
    now: () => NOW,
    fetchImpl: (input, init) => {
      selectedKeyCalls++;
      const headers = new Headers(init?.headers);
      assert(
        String(input) === "https://opencode.ai/zen/go/v1/responses" &&
          headers.get("authorization") === `Bearer ${expectedKey}` &&
          headers.get("x-opencode-session") === `nmf-invoice-cafe-${nonce}`,
        "Go credential precedence and signed app/nonce session binding",
      );
      return Promise.resolve(
        new Response(
          JSON.stringify(completedResponse(JSON.stringify(fixture))),
        ),
      );
    },
  });
  assert(
    (await (await keyHandler(await request("status"))).json()).configured ===
      true,
    "Go-only or dedicated credentials configure the selected plan",
  );
  const keyResult = await (await keyHandler(
    await request("extract", {
      body: {
        action: "extract",
        app: "cafe",
        nonce,
        image: { mime: "image/png", data: PNG },
      },
    }),
  )).json();
  assert(
    keyResult.ok === true && selectedKeyCalls === 1,
    "one extraction uses only the selected Go credential with no retry",
  );
}
for (
  const modelReply of [
    "not json",
    JSON.stringify({ ...fixture, items: "bad" }),
    JSON.stringify({ ...fixture, total: "55,000" }),
    JSON.stringify({
      ...fixture,
      items: [{ ...fixture.items[0], confidence: 2 }],
    }),
  ]
) {
  const bad = createHandler({
    env,
    now: () => NOW,
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify(completedResponse(modelReply)),
        ),
      ),
  });
  response = await bad(await request());
  result = await response.json();
  assert(
    response.status === 502 && result.ok === false &&
      !JSON.stringify(result).includes(modelReply),
    "malformed model result rejected without raw leakage",
  );
}
const truncated = createHandler({
  env,
  now: () => NOW,
  fetchImpl: () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ...completedResponse(JSON.stringify(fixture)),
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ),
    ),
});
response = await truncated(await request());
assert(response.status === 502, "truncated model output not silently accepted");
const completedFixture = completedResponse(JSON.stringify(fixture));
for (
  const [label, envelope] of [
    ["failed response", {
      ...completedFixture,
      status: "failed",
      error: { message: "private-response-error" },
    }],
    ["completed but errored", {
      ...completedFixture,
      error: { message: "private-response-error" },
    }],
    ["in-progress response", { ...completedFixture, status: "in_progress" }],
    ["incomplete message", {
      ...completedFixture,
      output: [{ ...completedFixture.output[0], status: "incomplete" }],
    }],
    ["refusal mixed with JSON", {
      ...completedFixture,
      output: [{
        ...completedFixture.output[0],
        content: [...completedFixture.output[0].content, {
          type: "refusal",
          refusal: "private-response-error",
        }],
      }],
    }],
    ["non-assistant message", {
      ...completedFixture,
      output: [{ ...completedFixture.output[0], role: "user" }],
    }],
    ["SDK-only convenience text", {
      status: "completed",
      output_text: JSON.stringify(fixture),
    }],
    ["reasoning-only JSON", {
      status: "completed",
      output: [{
        type: "reasoning",
        summary: [{ type: "summary_text", text: JSON.stringify(fixture) }],
      }],
    }],
    ["empty output text", completedResponse("")],
    ["unexpected output tool call", {
      ...completedFixture,
      output: [
        { type: "function_call", name: "private-response-error" },
        ...completedFixture.output,
      ],
    }],
  ] as const
) {
  const rejectEnvelope = createHandler({
    env,
    now: () => NOW,
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify(envelope))),
  });
  const rejectedResponse = await rejectEnvelope(await request());
  const rejectedResult = await rejectedResponse.json();
  assert(
    rejectedResponse.status === 502 &&
      rejectedResult.code === "invalid_model_response" &&
      !JSON.stringify(rejectedResult).includes("private-response-error"),
    `Responses ${label} rejected without raw details`,
  );
}
const reasoningFirst = createHandler({
  env,
  now: () => NOW,
  fetchImpl: () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ...completedFixture,
          output: [{
            type: "reasoning",
            summary: [{
              type: "summary_text",
              text: JSON.stringify({ ...fixture, total: 999999 }),
            }],
          }, ...completedFixture.output],
        }),
      ),
    ),
});
const reasoningResult = await (await reasoningFirst(await request())).json();
assert(
  reasoningResult.ok === true && reasoningResult.document.total === 55000 &&
    reasoningResult.document.rawText === fixture.rawText,
  "reasoning before assistant message is ignored, never extracted as invoice text",
);
const splitJson = JSON.stringify(fixture),
  midpoint = Math.floor(splitJson.length / 2);
const splitText = createHandler({
  env,
  now: () => NOW,
  fetchImpl: () =>
    Promise.resolve(
      new Response(JSON.stringify({
        ...completedFixture,
        output: [{
          ...completedFixture.output[0],
          content: [
            { type: "output_text", text: splitJson.slice(0, midpoint) },
            { type: "output_text", text: splitJson.slice(midpoint) },
          ],
        }],
      })),
    ),
});
assert(
  (await (await splitText(await request())).json()).document.total === 55000,
  "multiple completed output_text pieces form the one final JSON object",
);
for (const incompatible of ["kimi-k2.6", "gpt-5.6-luna"]) {
  const staleModel = createHandler({
    env: (key) => key === "NMF_INVOICE_MODEL" ? incompatible : env(key),
    now: () => NOW,
    fetchImpl: provider,
  });
  const staleStatus = await (await staleModel(await request("status"))).json();
  assert(
    staleStatus.configured === false && staleStatus.model === incompatible,
    "incompatible or user-rejected model override is reported, never silently substituted",
  );
  assert(
    (await staleModel(await request())).status === 503,
    "incompatible override makes no paid provider call",
  );
}
const inflated = createHandler({
  env,
  now: () => NOW,
  fetchImpl: () => Promise.resolve(new Response(" ".repeat(256001))),
});
response = await inflated(await request());
assert(response.status === 502, "provider output body bounded");
const failed = createHandler({
  env,
  now: () => NOW,
  fetchImpl: () =>
    Promise.resolve(
      new Response("credential = very-private-secret", { status: 401 }),
    ),
});
response = await failed(await request());
result = await response.json();
assert(
  response.status === 502 &&
    !JSON.stringify(result).includes("very-private-secret"),
  "upstream failure has no credential leakage",
);
assert(
  result.code === "ocr_provider_error" && result.providerStatus === 401 &&
    result.message.includes("인증"),
  "safe upstream status distinguishes rejected API credentials",
);
for (
  const [upstreamStatus, hint] of [
    [402, "구독"],
    [400, "요청"],
    [403, "권한"],
    [404, "모델"],
    [429, "한도"],
    [503, "일시"],
  ] as const
) {
  let classifiedCalls = 0;
  const classified = createHandler({
    env,
    now: () => NOW,
    fetchImpl: () => {
      classifiedCalls++;
      return Promise.resolve(
        new Response("secret-provider-body = private-image-data", {
          status: upstreamStatus,
        }),
      );
    },
  });
  const classifiedResponse = await classified(await request());
  const classifiedResult = await classifiedResponse.json();
  assert(
    classifiedResponse.status === 502 &&
      classifiedResult.code === "ocr_provider_error" &&
      classifiedResult.providerStatus === upstreamStatus &&
      classifiedResult.message.includes(hint) &&
      !JSON.stringify(classifiedResult).includes("private-image-data") &&
      classifiedCalls === 1,
    `HTTP ${upstreamStatus} safely classified without retry or raw provider leakage`,
  );
}
const timed = createHandler({
  env,
  now: () => NOW,
  timeoutMs: 5,
  fetchImpl: (_input, init) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("AbortError", "AbortError")),
        { once: true },
      )
    ),
});
response = await timed(await request());
result = await response.json();
assert(
  response.status === 504 && result.code === "ocr_timeout",
  "bounded timeout reports retryable failure",
);
let release!: () => void;
const gate = new Promise<void>((resolve) => release = resolve);
const parallel = createHandler({
  env,
  now: () => NOW,
  fetchImpl: async () => {
    await gate;
    return new Response(
      JSON.stringify(completedResponse(JSON.stringify(fixture))),
    );
  },
});
const [r1, r2] = await Promise.all([request(), request()]);
const p1 = parallel(r1), p2 = parallel(r2);
await new Promise((resolve) => setTimeout(resolve, 10));
response = await parallel(await request());
assert(response.status === 429, "maximum two ongoing extractions per worker");
release();
await Promise.all([p1, p2]);
let burstRelease!: () => void, burstCalls = 0;
const burstGate = new Promise<void>((resolve) => burstRelease = resolve);
const burstHandler = createHandler({
  env,
  now: () => NOW,
  fetchImpl: async () => {
    burstCalls++;
    await burstGate;
    return new Response(
      JSON.stringify(completedResponse(JSON.stringify(fixture))),
    );
  },
});
const burstRequests = await Promise.all([request(), request(), request()]);
const burstResults = burstRequests.map((req) => burstHandler(req));
await new Promise((resolve) => setTimeout(resolve, 10));
burstRelease();
const burstResponses = await Promise.all(burstResults);
assert(
  burstCalls === 2 &&
    burstResponses.filter((res) => res.status === 429).length === 1,
  "simultaneous requests cannot race through concurrency limit",
);
const oversize = await request("status");
const oversizedRequest = new Request(oversize, {
  headers: {
    ...Object.fromEntries(oversize.headers),
    "content-length": String(12 * 1024 * 1024 + 1),
  },
});
response = await handler(oversizedRequest);
assert(response.status === 413, "oversized body rejected before allocation");
const decodedOversize = createHandler({
  env,
  fetchImpl: provider,
  now: () => NOW,
});
response = await decodedOversize(
  await request("extract", {
    body: {
      action: "extract",
      app: "food",
      nonce: crypto.randomUUID(),
      image: {
        mime: "image/png",
        data: "A".repeat(Math.ceil((8 * 1024 * 1024 + 1) / 3) * 4),
      },
    },
  }),
);
assert(response.status === 413, "decoded image cap enforced");
const mismatch = validateDocument({
  ...fixture,
  total: 56000,
  items: [{ ...fixture.items[0], qty: 9 }],
});
assert(
  mismatch.items[0].qty === 9 && mismatch.items[0].amt === 55000 &&
    mismatch.items[0].warnings.length > 0 && mismatch.warnings.length > 0,
  "arithmetic warnings never rewrite printed figures",
);
const uncertain = validateDocument({
  ...fixture,
  date: "2026-02-30",
  items: [{ ...fixture.items[0], qty: null, price: null, confidence: 0.3 }],
});
assert(
  uncertain.date === null && uncertain.items[0].qty === null &&
    uncertain.items[0].warnings.length >= 2 && uncertain.warnings.length > 0,
  "invalid calendar, unknowns and low confidence require review",
);
const vatIncluded = validateDocument({
  ...fixture,
  items: [{ ...fixture.items[0], qty: 10, amt: 55000 }],
});
assert(
  vatIncluded.warnings.length === 0,
  "tax-inclusive row sum is not mistaken for an error",
);
let tooManyRejected = false;
try {
  validateDocument({
    ...fixture,
    items: Array.from({ length: 201 }, () => fixture.items[0]),
  });
} catch {
  tooManyRejected = true;
}
assert(tooManyRejected, "model rows bounded");
assert(
  layout.warnings.length === 0 &&
    layout.items.every((item) => item.warnings.length === 0),
  "mixed taxable/blank-VAT statement totals are valid independently",
);
const layout2 = validateDocument({
  ...actualLayoutFixture,
  date: "2026-10-07",
  subtotal: 691078,
  tax: 52102,
  total: 743180,
  previousBalance: 3128900,
  balanceTotal: 3872080,
  items: [
    {
      ...actualLayoutFixture.items[0],
      qty: 1,
      price: 573122,
      supplyAmount: 521020,
      tax: 52102,
      amt: 573122,
    },
    {
      ...actualLayoutFixture.items[1],
      qty: 1,
      price: 170058,
      supplyAmount: 170058,
      amt: 170058,
    },
  ],
});
assert(
  layout2.total === 743180 && layout2.balanceTotal === 3872080 &&
    layout2.subtotal === 691078 && layout2.warnings.length === 0,
  "second photographed layout separates current expense from outstanding balance",
);
const changedNet = validateDocument({
  ...actualLayoutFixture,
  items: [
    { ...actualLayoutFixture.items[0], supplyAmount: 530000 },
    actualLayoutFixture.items[1],
  ],
});
assert(
  changedNet.items[0].supplyAmount === 530000 &&
    changedNet.items[0].amt === 587950 &&
    changedNet.items[0].warnings.some((warning) =>
      warning.includes("공급가액")
    ) &&
    changedNet.warnings.some((warning) => warning.includes("공급가액 합계")),
  "net-plus-tax and net-column totals are checked without correcting source values",
);
const confusedCarryover = validateDocument({
  ...actualLayoutFixture,
  total: 1676200,
});
assert(
  confusedCarryover.total === 1676200 &&
    confusedCarryover.warnings.some((warning) =>
      warning.includes("당일 거래 합계")
    ),
  "carryover mistaken for current total requires a visible warning, not a silent replacement",
);
const legacy = validateDocument({
  ...fixture,
  previousBalance: undefined,
  balanceTotal: undefined,
  items: [{ ...fixture.items[0], supplyAmount: undefined }],
});
assert(
  legacy.previousBalance === null && legacy.balanceTotal === null &&
    legacy.items[0].supplyAmount === null && legacy.items[0].amt === 55000 &&
    legacy.items[0].price === 5500,
  "older schema remains readable but missing net/balance fields are never calculated",
);
const missingCurrent = validateDocument({
  ...actualLayoutFixture,
  total: null,
  items: [
    { ...actualLayoutFixture.items[0], amt: null },
    actualLayoutFixture.items[1],
  ],
});
assert(
  missingCurrent.total === null && missingCurrent.items[0].amt === null &&
    missingCurrent.previousBalance === 890200,
  "neither net-plus-tax nor balance-minus-prior fills missing printed totals",
);
const slightMismatch = validateDocument({
  ...actualLayoutFixture,
  total: 786500,
  balanceTotal: 1676700,
});
assert(
  slightMismatch.warnings.some((warning) => warning.includes("품목 합계")),
  "large invoices do not hide a 500-won discrepancy behind a percentage tolerance",
);
const layoutHandler = createHandler({
  env,
  now: () => NOW,
  fetchImpl: () =>
    Promise.resolve(
      new Response(
        JSON.stringify(completedResponse(JSON.stringify(actualLayoutFixture))),
      ),
    ),
});
const layoutHttp = await (await layoutHandler(await request())).json();
assert(
  layoutHttp.document.total === 786000 &&
    layoutHttp.document.balanceTotal === 1676200 &&
    layoutHttp.document.items[0].supplyAmount === 534500 &&
    layoutHttp.document.items[0].amt === 587950,
  "actual HTTP response retains all independent invoice columns",
);
console.log(
  JSON.stringify({
    ok: true,
    assertions: checks,
    providerFixtureCalls: calls,
    productionCalls: 0,
    databaseWrites: 0,
    imageStorageWrites: 0,
  }),
);
