// Actual recipe HTTP handler, isolated database/runtime, no network or live state.
import { encryptText } from "../supabase/functions/nmf-recipe-fill/lib.ts";

type Handler = (req: Request) => Promise<Response>;
const APP_PASSWORD = "offline-cors-password",
  CRON_SECRET = "offline-cors-secret";
const DOMAIN = "https://d-bae.com", GITHUB = "https://donggeonbae.github.io";
const ATTACKER = "https://d-bae.com.attacker.invalid";
const endpoint = "https://offline.invalid/functions/v1/nmf-recipe-fill";
const globals = globalThis as unknown as Record<string, unknown>;
const envKeys = ["NMF_PW", "NMF_CRON_SECRET", "NMF_TABLE", "NMF_ROOM"];
const originalEnv = new Map(envKeys.map((key) => [key, Deno.env.get(key)]));
const nativeFetch = globalThis.fetch;
let handler!: Handler, statusFailure = false, readCalls = 0, claimCalls = 0;
let waitForReads: Promise<void> | undefined;
let reachedReads: (() => void) | undefined;
let reachedAt = 0;
let cases = 0;
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  assert(
    actual === expected,
    `${message}: expected ${expected}, got ${actual}`,
  );
}
function assertCors(response: Response, origin: string | null, label: string) {
  equal(
    response.headers.get("access-control-allow-origin"),
    origin,
    `${label}: exact origin`,
  );
  equal(
    response.headers.get("vary"),
    "Origin",
    `${label}: cache varies by origin`,
  );
  equal(
    response.headers.get("cache-control"),
    "no-store",
    `${label}: no-store retained`,
  );
  assert(
    !response.headers.has("access-control-allow-credentials"),
    `${label}: no credential widening`,
  );
  cases++;
}
async function signed(
  origin?: string,
  extra: Record<string, unknown> = {},
  time = Date.now(),
) {
  const ts = String(time), enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(APP_PASSWORD),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        enc.encode(`nmf-recipe:status:${ts}`),
      ),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nmf-time": ts,
      "x-nmf-signature": sig,
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ action: "status", ...extra }),
  });
}
async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}

try {
  Deno.env.set("NMF_PW", APP_PASSWORD);
  Deno.env.set("NMF_CRON_SECRET", CRON_SECRET);
  Deno.env.set("NMF_TABLE", "namofood_state");
  Deno.env.set("NMF_ROOM", "namofood");
  globalThis.fetch = () =>
    Promise.reject(new Error("Network forbidden in CORS fixture"));
  const row = {
    data: await encryptText(
      APP_PASSWORD,
      JSON.stringify({ recipes: [], methods: {}, recipeMeta: {}, menus: {} }),
    ),
    updated_at: new Date().toISOString(),
  };
  const sql = (parts: TemplateStringsArray) => {
    const text = parts.join("?");
    if (text.startsWith("select id,status,started_at")) {
      return Promise.resolve([]);
    }
    if (text.startsWith("select public.nmf_claim_recipe_run")) {
      claimCalls++;
      return Promise.resolve([{ claimed: false }]);
    }
    throw new Error("Unexpected SQL/write in CORS fixture");
  };
  globals.__recipeCorsDb = {
    sql,
    async readState() {
      readCalls++;
      if (reachedReads && readCalls >= reachedAt) reachedReads();
      if (waitForReads) await waitForReads;
      if (statusFailure) throw new Error("isolated status read failure");
      return [row];
    },
    logValues: () => {
      throw new Error("Unexpected log write");
    },
    snapshotState: () => {
      throw new Error("Unexpected snapshot write");
    },
    writeState: () => {
      throw new Error("Unexpected state write");
    },
  };
  globals.__recipeCorsCapture = (value: Handler) => {
    handler = value;
  };
  const file = new URL(
    "../supabase/functions/nmf-recipe-fill/index.ts",
    import.meta.url,
  );
  let source = await Deno.readTextFile(file);
  const databaseImport =
    /import\s*\{[\s\S]*?\}\s*from "\.\.\/_shared\/database\.ts";/;
  assert(
    databaseImport.test(source),
    "capture actual database import, never import production DB",
  );
  source = source.replace(
    databaseImport,
    "const {logValues,readState,snapshotState,sql,writeState}=(globalThis as any).__recipeCorsDb;",
  );
  source = source.replace(
    'from "./lib.ts";',
    `from ${
      JSON.stringify(
        new URL("../supabase/functions/nmf-recipe-fill/lib.ts", import.meta.url)
          .href,
      )
    };`,
  );
  assert(source.includes("Deno.serve("), "actual HTTP registration captured");
  source = source.replace(
    "Deno.serve(",
    "(globalThis as any).__recipeCorsCapture(",
  );
  await import(`data:application/typescript,${encodeURIComponent(source)}`);
  assert(handler, "actual handler loaded");

  for (const origin of [DOMAIN, GITHUB]) {
    const pre = await handler(
      new Request(endpoint, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "apikey,content-type,x-nmf-time,x-nmf-signature",
        },
      }),
    );
    equal(pre.status, 200, "preflight remains unauthenticated");
    assertCors(pre, origin, "allowed preflight");
    equal(
      pre.headers.get("access-control-allow-methods"),
      "POST, OPTIONS",
      "unchanged methods",
    );
    equal(
      pre.headers.get("access-control-allow-headers"),
      "authorization, apikey, content-type, x-nmf-time, x-nmf-signature",
      "unchanged allowed headers",
    );
    const status = await handler(await signed(origin));
    equal(status.status, 200, "signed status succeeds");
    equal((await body(status)).ok, true, "real status response");
    assertCors(status, origin, "allowed signed status");
    const unauthorized = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: '{"action":"status"}',
      }),
    );
    equal(unauthorized.status, 401, "origin alone cannot authenticate");
    equal(
      (await body(unauthorized)).reason,
      "unauthorized",
      "authentication error retained",
    );
    assertCors(unauthorized, origin, "allowed 401");
    const method = await handler(
      new Request(endpoint, { headers: { origin } }),
    );
    equal(method.status, 405, "method rejected");
    assertCors(method, origin, "allowed 405");
    const invalid = await handler(await signed(origin, { force: true }));
    equal(invalid.status, 400, "app privileged parameters remain forbidden");
    assertCors(invalid, origin, "allowed 400");
    statusFailure = true;
    const failed = await handler(await signed(origin));
    statusFailure = false;
    equal(failed.status, 500, "database failure remains error");
    assertCors(failed, origin, "allowed 500");
  }
  for (
    const origin of [
      ATTACKER,
      "https://www.d-bae.com",
      "http://d-bae.com",
      "null",
      "https://d-bae.com:8443",
    ]
  ) {
    const pre = await handler(
      new Request(endpoint, { method: "OPTIONS", headers: { origin } }),
    );
    assertCors(pre, null, "untrusted origin preflight not reflected");
    const status = await handler(await signed(origin));
    equal(
      status.status,
      200,
      "HMAC remains auth boundary; browser independently denied CORS",
    );
    assertCors(status, null, "untrusted origin POST not reflected");
    const denied = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: { origin },
        body: '{"action":"status"}',
      }),
    );
    equal(denied.status, 401, "untrusted unauthenticated still denied");
    assertCors(denied, null, "untrusted error not reflected");
  }
  const noOrigin = await handler(await signed());
  equal(noOrigin.status, 200, "signed request without Origin works");
  assertCors(noOrigin, null, "no Origin signed status");
  const cronStatus = await handler(
    new Request(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        "content-type": "application/json",
      },
      body: '{"action":"status"}',
    }),
  );
  equal(
    cronStatus.status,
    200,
    "existing cron secret authentication without Origin",
  );
  assertCors(cronStatus, null, "no Origin cron status");
  const cronBusy = await handler(
    new Request(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        "content-type": "application/json",
      },
      body: '{"action":"run"}',
    }),
  );
  equal(
    cronBusy.status,
    200,
    "cron run authentication reaches existing atomic claim",
  );
  equal(claimCalls, 1, "exactly one mocked claim, no generation or writes");
  equal((await body(cronBusy)).busy, true, "existing busy behavior");
  assertCors(cronBusy, null, "no Origin cron busy");
  const stale = await handler(await signed(DOMAIN, {}, Date.now() - 120_000));
  equal(stale.status, 401, "stale HMAC still rejected");
  assertCors(stale, DOMAIN, "allowed stale-auth response");

  // All three requests wait inside real status flow before any response is made.
  // This discriminates request-local origin from unsafe shared mutable origin state.
  let release!: () => void;
  waitForReads = new Promise<void>((done) => {
    release = done;
  });
  const allReading = new Promise<void>((done) => {
    reachedReads = done;
  });
  reachedAt = readCalls + 3;
  const pending = Promise.all(
    await Promise.all(
      [DOMAIN, GITHUB, ATTACKER].map((origin) => signed(origin)),
    ).then((requests) => requests.map((req) => handler(req))),
  );
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      allReading,
      new Promise<never>((_, reject) => {
        readTimer = setTimeout(
          () =>
            reject(
              new Error("Concurrent status fixture did not reach all reads"),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(readTimer);
    release();
  }
  const concurrent = await pending;
  for (const [i, origin] of [DOMAIN, GITHUB, null].entries()) {
    assertCors(concurrent[i], origin, "overlapping request isolation");
  }
  console.log(
    JSON.stringify({
      result: "RECIPE_CORS_OK",
      cases,
      actualHandler: true,
      network: false,
      liveWrites: 0,
    }),
  );
} finally {
  globalThis.fetch = nativeFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  delete globals.__recipeCorsDb;
  delete globals.__recipeCorsCapture;
}
