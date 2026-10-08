// The retired endpoint must not touch state, run logs, quotas, or model services.
// This loads the actual handler; database and network observations fail closed.
// Run: deno run --allow-env --allow-read tools/test_menu_automation_disabled.ts
type Handler = (request: Request) => Promise<Response>;
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const SECRET = "offline-retired-menu-secret";
const globals = globalThis as unknown as Record<string, unknown>;
const nativeFetch = globalThis.fetch;
const keys = [
  "NMF_CRON_SECRET",
  "NMF_PW",
  "OPENCODE_API_KEY",
  "OPENCODE_GO_API_KEY",
  "NMF_MENU_AUTOMATION_ENABLED",
];
const savedEnv = new Map(keys.map((key) => [key, Deno.env.get(key)]));
let handler!: Handler;
let databaseCalls = 0;
let networkCalls = 0;
const forbiddenDatabase = () => {
  databaseCalls++;
  throw new Error("retired menu endpoint attempted database access");
};
try {
  for (const key of keys) Deno.env.delete(key);
  Deno.env.set("NMF_CRON_SECRET", SECRET);
  // No deployment environment, body flag, or source header may re-enable it.
  Deno.env.set("NMF_MENU_AUTOMATION_ENABLED", "true");
  globals.__nmfRetiredDb = {
    sql: Object.assign(forbiddenDatabase, { begin: forbiddenDatabase }),
    logValues: forbiddenDatabase,
    readState: forbiddenDatabase,
    writeState: forbiddenDatabase,
    snapshotState: forbiddenDatabase,
  };
  globals.__nmfRetiredCapture = (callback: Handler) => handler = callback;
  globalThis.fetch = () => {
    networkCalls++;
    throw new Error("retired menu endpoint attempted network access");
  };
  let source = await Deno.readTextFile(
    new URL("../supabase/functions/nmf-menu-plan/index.ts", import.meta.url),
  );
  const negative = Deno.env.get("NMF_DISABLED_HANDLER_NEGATIVE_CONTROL");
  if (negative === "bypass") {
    assert(
      source.includes("const NMF_MENU_AUTOMATION_ENABLED = false;"),
      "negative control must target the production retirement guard",
    );
    source = source.replace(
      "const NMF_MENU_AUTOMATION_ENABLED = false;",
      "const NMF_MENU_AUTOMATION_ENABLED = true;",
    );
  } else assert(!negative, "unknown retirement negative control");
  assert(
    source.includes('from "../_shared/database.ts";'),
    "production database import observation exists",
  );
  source = source.replace(
    /import\s*\{[^}]+\}\s*from "\.\.\/_shared\/database\.ts";/,
    "const { logValues, readState, snapshotState, sql, writeState } = (globalThis as any).__nmfRetiredDb;",
  ).replace(
    'from "./lib.ts";',
    `from ${
      JSON.stringify(
        new URL("../supabase/functions/nmf-menu-plan/lib.ts", import.meta.url)
          .href,
      )
    };`,
  ).replace("Deno.serve(", "(globalThis as any).__nmfRetiredCapture(");
  await import(`data:application/typescript;base64,${
    btoa(
      Array.from(
        new TextEncoder().encode(source),
        (byte) => String.fromCharCode(byte),
      ).join(""),
    )
  }`);
  assert(handler, "actual handler must register");
  const invoke = (body: string, headers: Record<string, string> = {}) =>
    handler(
      new Request("https://offline.invalid/nmf-menu-plan", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, ...headers },
        body,
      }),
    );
  for (
    const body of [
      "{}",
      '{"dry":true}',
      '{"preview":true}',
      '{"retry":true}',
      '{"force":true,"retry":true,"weeks":2}',
      '{"weeks":999}',
      '{"enabled":true}',
      "not json",
      "null",
      "[]",
    ]
  ) {
    const response = await invoke(body, { "x-source": "supabase_cron_retry" });
    const data = await response.json();
    assert(
      response.status === 200 && data.ok === true && data.disabled === true,
      `authorized body ${body} must return the retired status`,
    );
    assert(
      data.generated === 0 && data.saved === 0 && data.runId === null,
      `authorized body ${body} cannot generate, save, or claim a run`,
    );
    assert(
      typeof data.reason === "string" && data.reason.includes("중지"),
      "retirement response must explain the disabled state in Korean",
    );
  }
  for (const authorization of ["", "Bearer wrong-secret", `Basic ${SECRET}`]) {
    const response = await invoke("{}", { Authorization: authorization });
    assert(
      response.status === 401 &&
        (await response.json()).reason === "unauthorized",
      "retirement must preserve custom authentication",
    );
  }
  Deno.env.delete("NMF_CRON_SECRET");
  assert(
    (await invoke("{}")).status === 401,
    "missing server secret fails closed",
  );
  for (const method of ["GET", "OPTIONS", "PUT", "DELETE"]) {
    const response = await handler(
      new Request("https://offline.invalid/nmf-menu-plan", { method }),
    );
    assert(
      response.status === 405,
      "retirement preserves existing POST-only method policy",
    );
  }
  assert(
    databaseCalls === 0,
    `no state, log, or quota calls: ${databaseCalls}`,
  );
  assert(networkCalls === 0, `no LLM or other network calls: ${networkCalls}`);
  console.log(
    "MENU_AUTOMATION_DISABLED_OK / ACTUAL_HANDLER / NO_DATABASE_NETWORK / FORCE_PREVIEW_RETRY_BLOCKED / AUTH_PRESERVED",
  );
} finally {
  globalThis.fetch = nativeFetch;
  for (const [key, value] of savedEnv) {
    value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
  delete globals.__nmfRetiredDb;
  delete globals.__nmfRetiredCapture;
}
