import {
  completeMenuDates,
  decryptText,
  encryptText,
  selectRollingDates,
  SLOT_INDICES,
  type State,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const state = {
  menus: {
    "2026-09": {} as Record<string, string>,
    "2026-10": {} as Record<string, string>,
  },
};
for (let i = 0; i < 14; i++) {
  const date = new Date(Date.UTC(2026, 8, 28 + i));
  const ym = date.toISOString().slice(0, 7) as keyof typeof state.menus;
  for (const meal of ["조식", "중식", "석식", "야식"]) {
    for (const slot of SLOT_INDICES) {
      state.menus[ym][`${date.getUTCDate()}|${meal}|${slot}`] = "기존 메뉴";
    }
  }
}
assert(
  JSON.stringify(selectRollingDates(state, "2026-09-28")) === '["2026-10-12"]',
  "generate exactly same weekday +14 across month boundary",
);
assert(
  selectRollingDates({ menus: {} }, "2026-09-28").includes("2026-10-12"),
  "prioritize +14 when catching up",
);
assert(
  selectRollingDates({ menus: {} }, "2026-12-25").includes("2027-01-08"),
  "year boundary",
);
for (const meal of ["조식", "중식", "석식", "야식"]) {
  for (const slot of SLOT_INDICES) {
    state.menus["2026-10"][`12|${meal}|${slot}`] = "수동 메뉴";
  }
}
assert(
  selectRollingDates(state, "2026-09-28").length === 0,
  "complete manual menus untouched",
);

// Exercise the actual HTTP handler without importing the production database or
// making a network connection. SQL semantics below cover only the statements
// used by this handler, and unknown statements/URLs fail closed.
type Run = Record<string, unknown> & {
  run_id: string;
  started_at: string;
  status: string;
  note: string;
  targets: string[];
};
type Stored = { data: string; updated_at: string };
type Handler = (request: Request) => Promise<Response>;
type LlmInput = {
  date: string;
  model: string;
  prompt: string;
  signal: AbortSignal;
};
type Fixture = {
  row: Stored;
  runs: Run[];
  calls: LlmInput[];
  snapshots: number;
  writes: number;
  conflict?: () => Promise<void>;
  llm: (input: LlmInput) => Promise<Response>;
};
const PASSWORD = "offline-menu-test-password";
const SECRET = "offline-menu-test-secret";
const MEALS = ["조식", "중식", "석식", "야식"];
let now = Date.parse("2026-10-02T03:00:00Z");
let fixture!: Fixture;
let handler: Handler;
let beforeMerge: (() => void) | undefined;
let lockTail = Promise.resolve();
const signalTimers = new Set<ReturnType<typeof setTimeout>>();
const nativeDate = Date;
const nativeFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const envKeys = [
  "NMF_PW",
  "NMF_CRON_SECRET",
  "OPENCODE_API_KEY",
  "OPENCODE_GO_API_KEY",
  "OPENCODE_BASE_URL",
  "NMF_MENU_MODEL",
  "NMF_MENU_FALLBACK_MODEL",
  "NMF_MENU_MAX_TOKENS",
  "NMF_TABLE",
  "NMF_ROOM",
];
const savedEnv = new Map(envKeys.map((key) => [key, Deno.env.get(key)]));

function equal(actual: unknown, expected: unknown, message: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)}`,
  );
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("offline handler did not complete")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Transaction = { release?: () => void };
async function query(
  parts: TemplateStringsArray,
  values: unknown[],
  tx?: Transaction,
): Promise<unknown[]> {
  const text = parts.join("?");
  if (text.includes("pg_advisory_xact_lock")) {
    assert(tx, "claim lock must run inside a transaction");
    const next = gate(), previous = lockTail;
    lockTail = next.promise;
    await previous;
    tx.release = next.resolve;
    return [];
  }
  if (text.startsWith("update public.namofood_menu_runs set status='error'")) {
    const [at, cutoff] = values as string[];
    const stale = fixture.runs.filter((run) =>
      run.status === "running" &&
      Date.parse(run.started_at) < Date.parse(cutoff)
    );
    for (const run of stale) {
      run.status = "error";
      run.finished_at = at;
      run.note = text.includes("case when note like 'preview:%'") &&
          run.note.startsWith("preview:")
        ? "preview: stale cleanup: 실행시간 초과"
        : "stale cleanup: 실행시간 초과";
      run.error = "Edge 실행이 완료 로그를 남기기 전에 종료됨";
    }
    return stale.map((run) => ({ run_id: run.run_id }));
  }
  if (text.startsWith("select run_id from public.namofood_menu_runs")) {
    return fixture.runs.filter((run) =>
      run.status === "running" &&
      Date.parse(run.started_at) >= Date.parse(String(values[0]))
    ).slice(0, 1);
  }
  if (text.startsWith("insert into public.namofood_menu_runs")) {
    const run = structuredClone(values[0]) as Run;
    assert(
      !fixture.runs.some((other) => other.run_id === run.run_id),
      "run IDs must be unique",
    );
    fixture.runs.push(run);
    return [];
  }
  if (text.startsWith("update public.namofood_menu_runs set ")) {
    const run = fixture.runs.find((other) => other.run_id === values[1]);
    assert(run, "finishRun must update a claimed row");
    Object.assign(run, structuredClone(values[0]));
    return [];
  }
  if (
    text.startsWith("select started_at,") &&
    text.includes("from public.namofood_menu_runs")
  ) {
    return fixture.runs.filter((run) =>
      run.run_id !== values[0] &&
      Date.parse(run.started_at) >= Date.parse(String(values[1])) &&
      (run.targets.length > 0 || run.target_start != null) &&
      (!text.includes("note not like 'preview:%'") ||
        !run.note.startsWith("preview:")) &&
      (!text.includes("note not like 'dry run:%'") ||
        !run.note.startsWith("dry run:"))
    );
  }
  throw new Error(`Unexpected offline SQL: ${text}`);
}
function sqlFor(tx?: Transaction) {
  return Object.assign(
    (
      first: TemplateStringsArray | Record<string, unknown>,
      ...values: unknown[]
    ) =>
      Array.isArray(first) && Object.hasOwn(first, "raw")
        ? query(first as TemplateStringsArray, values, tx)
        : first,
    {
      begin: async (
        callback: (sql: ReturnType<typeof sqlFor>) => Promise<unknown>,
      ) => {
        const transaction: Transaction = {};
        try {
          return await callback(sqlFor(transaction));
        } finally {
          transaction.release?.();
        }
      },
    },
  );
}
const db = {
  sql: sqlFor(),
  logValues: (row: Record<string, unknown>) => row,
  readState: (table: string, room: string) => {
    assert(
      table === "namofood_state" && room === "namofood",
      "read only the configured room",
    );
    return Promise.resolve([structuredClone(fixture.row)]);
  },
  writeState: async (
    table: string,
    room: string,
    expected: string,
    data: string,
    at: string,
  ) => {
    assert(
      table === "namofood_state" && room === "namofood",
      "write only the configured room",
    );
    fixture.writes++;
    if (fixture.conflict) {
      const conflict = fixture.conflict;
      fixture.conflict = undefined;
      await conflict();
      return [];
    }
    if (fixture.row.updated_at !== expected) return [];
    fixture.row = { data, updated_at: at };
    return [{ id: room, updated_at: at }];
  },
  snapshotState: (table: string, room: string) => {
    assert(
      table === "namofood_state" && room.startsWith("namofood@"),
      "snapshots cannot overwrite the room",
    );
    fixture.snapshots++;
    return Promise.resolve();
  },
};

function menuFixture(missing: number[]): State {
  const month: Record<string, string> = {};
  for (let day = 2; day <= 16; day++) {
    for (const meal of MEALS) {
      month[`${day}|${meal}|n`] = "250";
      if (!missing.includes(day)) {
        for (const slot of SLOT_INDICES) {
          month[`${day}|${meal}|${slot}`] = `기존${day}${meal}${slot}`;
        }
      }
    }
  }
  return {
    menus: { "2026-10": month },
    settings: {
      meals: Object.fromEntries(MEALS.map((meal) => [meal, { price: 10000 }])),
      tickets: Object.fromEntries(MEALS.map((meal) => [meal, 10000])),
      marker: "수동 설정 보존",
    },
    recipes: [{ menu: "수동메뉴", item: "소고기", qty: 100, unit: "g" }],
    methods: { 수동메뉴: "수동 조리법" },
    recipeMeta: { 수동메뉴: { by: "user" } },
    headcountMeta: { "2026-10-15|중식": { by: "manual", updated: "manual" } },
  };
}
function llmResponse(input: LlmInput, badSoup = false): Response {
  const fixedLine = input.prompt.match(
    /다음 기존 셀[^\n]+복사하세요: (\{[^\n]+\})/,
  );
  const fixed = fixedLine
    ? JSON.parse(fixedLine[1]) as Record<string, string>
    : {};
  const dishes = {
    "1": "소고기무국",
    "2": "제육볶음",
    "7": "생선구이",
    "3": "감자조림",
    "4": "콩나물무침",
    "8": "어묵볶음",
  };
  const plan = {
    days: [{
      date: input.date,
      meals: MEALS.map((meal) => ({
        meal,
        slots: Object.fromEntries(
          SLOT_INDICES.map((
            slot,
          ) => [
            slot,
            fixed[`${input.date}|${meal}|${slot}`] ??
              `${input.date}${meal}${dishes[slot]}`,
          ]),
        ),
        extras: [],
      })),
    }],
  };
  if (badSoup) plan.days[0].meals[1].slots["1"] = "제육볶음";
  const text = JSON.stringify(plan);
  return Response.json(
    input.model === "minimax-m3"
      ? { stop_reason: "end_turn", content: [{ type: "text", text }] }
      : { choices: [{ finish_reason: "stop", message: { content: text } }] },
  );
}
async function setup(missing: number[], llm: Fixture["llm"], runs: Run[] = []) {
  const value = menuFixture(missing);
  fixture = {
    row: {
      data: await encryptText(PASSWORD, JSON.stringify(value)),
      updated_at: "2026-10-02T02:00:00Z",
    },
    runs,
    calls: [],
    snapshots: 0,
    writes: 0,
    llm,
  };
  beforeMerge = undefined;
  lockTail = Promise.resolve();
  return value;
}
function request(body: Record<string, unknown> = {}, signal?: AbortSignal) {
  return new Request("https://offline.invalid/nmf-menu-plan", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "x-source": "offline_test" },
    body: JSON.stringify(body),
    signal,
  });
}
async function invoke(
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  const response = await bounded(handler(request(body, signal)));
  assert(
    response.status === 200,
    `handler failed: ${await response.clone().text()}`,
  );
  return await response.json();
}
async function currentState(): Promise<State> {
  return JSON.parse(await decryptText(PASSWORD, fixture.row.data));
}

try {
  globalThis.Date = new Proxy(nativeDate, {
    construct: (target, args) =>
      Reflect.construct(target, args.length ? args : [now]),
    get: (target, key, receiver) =>
      key === "now" ? () => now : Reflect.get(target, key, receiver),
  });
  for (const key of envKeys) Deno.env.delete(key);
  Deno.env.set("NMF_PW", PASSWORD);
  Deno.env.set("NMF_CRON_SECRET", SECRET);
  Deno.env.set("OPENCODE_API_KEY", "offline-placeholder");
  globals.__nmfOfflineDb = db;
  globals.__nmfCaptureHandler = (callback: Handler) => {
    handler = callback;
  };
  globals.__nmfBeforeGenerationMerge = () => beforeMerge?.();
  // Preserve real timeout behavior, but cancel outstanding long deadlines when
  // the offline harness ends so the runner does not wait for the 110s run lease.
  globals.__nmfOfflineTimeout = (ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      signalTimers.delete(timer);
      controller.abort(new DOMException("offline timeout", "TimeoutError"));
    }, ms);
    signalTimers.add(timer);
    return controller.signal;
  };
  globalThis.fetch = async (url, init) => {
    assert(
      typeof url === "string" &&
        /^https:\/\/opencode\.ai\/zen\/go\/v1\/(messages|chat\/completions)$/
          .test(url),
      `Unexpected network URL: ${String(url)}`,
    );
    const body = JSON.parse(String(init?.body));
    assert(
      body.max_tokens === 10000,
      "production handler must send its configured token budget",
    );
    const prompt = body.messages[0].content as string;
    const dates = JSON.parse(
      prompt.match(/정확한 날짜[^\n]+: (\[[^\n]+\])/)![1],
    ) as string[];
    equal(dates.length, 1, "each model call targets exactly one date");
    const input = {
      date: dates[0],
      model: body.model,
      prompt,
      signal: init!.signal!,
    };
    fixture.calls.push(input);
    input.signal.throwIfAborted();
    return await fixture.llm(input);
  };
  let source = await Deno.readTextFile(
    new URL("../supabase/functions/nmf-menu-plan/index.ts", import.meta.url),
  );
  const negative = Deno.env.get("NMF_DAILY_HANDLER_NEGATIVE_CONTROL");
  if (negative === "discard-partial") {
    assert(
      source.includes("generationDiagnostics = chunkResults.map"),
      "negative control integration point exists",
    );
    source = source.replace(
      "generationDiagnostics = chunkResults.map",
      'if (chunkResults.some((result) => !result.plan)) throw new Error("isolated all-or-nothing mutation");\n      generationDiagnostics = chunkResults.map',
    );
  } else if (negative === "request-save-signal") {
    source = source.replace(
      "const saveSignal = AbortSignal.timeout(SAVE_RESERVE_MS);",
      "const saveSignal = runSignal;",
    );
  } else assert(!negative, "unknown isolated handler mutation");
  assert(
    source.includes('from "../_shared/database.ts";'),
    "production database import must be replaced",
  );
  source = source.replace(
    /import\s*\{[^}]+\}\s*from "\.\.\/_shared\/database\.ts";/,
    "const { logValues, readState, snapshotState, sql, writeState } = (globalThis as any).__nmfOfflineDb;",
  );
  source = source.replace(
    'from "./lib.ts";',
    `from ${
      JSON.stringify(
        new URL("../supabase/functions/nmf-menu-plan/lib.ts", import.meta.url)
          .href,
      )
    };`,
  );
  source = source.replace(
    "Deno.serve(",
    "(globalThis as any).__nmfCaptureHandler(",
  );
  source = source.replaceAll(
    "AbortSignal.timeout(",
    "(globalThis as any).__nmfOfflineTimeout(",
  );
  source = source.replace(
    "mergeMenuPlan(generationState, candidate, {",
    "(globalThis as any).__nmfBeforeGenerationMerge();\n              mergeMenuPlan(generationState, candidate, {",
  );
  await import(
    `data:application/typescript;base64,${
      btoa(
        Array.from(
          new TextEncoder().encode(source),
          (byte) => String.fromCharCode(byte),
        ).join(""),
      )
    }`
  );
  assert(handler!, "actual index registered its handler");

  const original = await setup(
    [15, 16],
    (input) => Promise.resolve(llmResponse(input, input.date.endsWith("15"))),
  );
  fixture.conflict = async () => {
    const latest = await currentState();
    latest.menus!["2026-10"]["16|중식|2"] = "최신 수동 차돌볶음";
    latest.menus!["2026-10"]["16|중식|n"] = "444";
    latest.headcountMeta = {
      ...latest.headcountMeta,
      "2026-10-16|중식": { by: "manual", updated: "late-user-edit" },
    };
    fixture.row = {
      data: await encryptText(PASSWORD, JSON.stringify(latest)),
      updated_at: "2026-10-02T03:00:01Z",
    };
  };
  const partial = await invoke();
  equal(
    partial.status,
    "partial",
    "one failed date cannot discard the other completed date",
  );
  equal(partial.succeededDates, ["2026-10-16"], "completed date persisted");
  equal(partial.failedDates.map((item: { date: string }) => item.date), [
    "2026-10-15",
  ], "failed date reported separately");
  const saved = await currentState();
  assert(
    completeMenuDates(saved, MEALS).includes("2026-10-16") &&
      !completeMenuDates(saved, MEALS).includes("2026-10-15"),
    "read-back observes partial completion only",
  );
  equal(
    saved.menus!["2026-10"]["16|중식|2"],
    "최신 수동 차돌볶음",
    "CAS retry preserves late manual food",
  );
  equal(
    saved.menus!["2026-10"]["16|중식|n"],
    "444",
    "CAS retry preserves late manual headcount",
  );
  equal(saved.settings, original.settings, "unrelated settings untouched");
  equal(saved.recipes, original.recipes, "manual recipe rows untouched");
  assert(
    fixture.writes === 2 && fixture.snapshots === 1,
    "CAS retry commits once and snapshots only committed state",
  );
  assert(
    fixture.runs[0].status === "partial" &&
      (fixture.runs[0].generation as { failedDates: unknown[] }).failedDates
          .length === 1,
    "durable log records the partial result",
  );
  assert(
    fixture.calls.find((call) => call.model === "minimax-m3")?.prompt.includes(
      "제육볶음",
    ),
    "fallback receives the invalid soup diagnostic",
  );
  equal(
    fixture.calls.filter((call) => call.date === "2026-10-15").length,
    6,
    "persistently invalid date is bounded to initial plus two corrections per model",
  );
  const failedChunk = partial.generation.chunks.find((
    chunk: { dates: string[] },
  ) => chunk.dates.includes("2026-10-15"));
  assert(
    failedChunk.correctionCount === 4 && failedChunk.corrections.length === 4,
    "all four launched corrections remain visible for the failed date",
  );
  const count = fixture.calls.length;
  const cooling = await invoke({ retry: true });
  equal(
    cooling.retry.deferred[0].reason,
    "cooldown",
    "immediate retry deferred",
  );
  equal(fixture.calls.length, count, "cooldown cannot call an LLM");
  equal(
    fixture.runs.at(-1)!.targets,
    [],
    "no-op cron does not consume date quota",
  );
  const forced = await invoke({ retry: true, force: true });
  equal(forced.retry.deferred, [], "authorized force bypasses only cooldown");
  assert(fixture.calls.length > count, "forced recovery runs the pending date");
  for (let attempt = 3; attempt <= 3; attempt++) {
    now += 31 * 60_000;
    await invoke({ retry: true });
  }
  const beforeCap = fixture.calls.length;
  now += 31 * 60_000;
  const capped = await invoke({ retry: true });
  equal(
    capped.retry.deferred[0].reason,
    "daily_limit",
    "third real date attempt is the daily limit",
  );
  equal(
    capped.retry.deferred[0].attempts,
    3,
    "fallbacks and no-op ticks do not count as extra attempts",
  );
  equal(fixture.calls.length, beforeCap, "daily cap cannot call an LLM");
  const forceCapped = await invoke({ force: true });
  equal(
    forceCapped.retry.deferred[0].reason,
    "daily_limit",
    "force cannot bypass the daily cap",
  );
  equal(
    fixture.calls.length,
    beforeCap,
    "forced daily-cap no-op cannot call an LLM",
  );

  await setup(
    [16],
    (input) => Promise.resolve(llmResponse(input, fixture.calls.length === 1)),
  );
  const corrected = await invoke();
  equal(
    corrected.status,
    "done",
    "same-model corrective prompt recovers an invalid soup candidate",
  );
  equal(
    fixture.calls.length,
    2,
    "validator correction remains bounded to one additional model call",
  );
  assert(
    fixture.calls.every((call) => call.model === "deepseek-v4.1-flash"),
    "validator correction retries the same model before fallback",
  );
  assert(
    fixture.calls[1].prompt.includes("제육볶음") &&
      fixture.calls[1].prompt.includes("슬롯 1"),
    "correction prompt contains the actual validation failure",
  );
  const correctedChunk = corrected.generation.chunks[0];
  assert(
    correctedChunk.correctionCount === 1 &&
      correctedChunk.corrections.length === 1 &&
      correctedChunk.corrections[0].model === "deepseek-v4.1-flash" &&
      correctedChunk.corrections[0].attempt === 1 &&
      correctedChunk.corrections[0].error.includes("제육볶음") &&
      correctedChunk.attempts[0].ok === true,
    "validator failure and successful correction remain visible in durable diagnostics",
  );
  equal(
    (fixture.runs[0].generation as { chunks: unknown[] }).chunks,
    corrected.generation.chunks,
    "durable correction diagnostics match the returned result",
  );

  for (const failure of ["transport", "timeout"] as const) {
    await setup(
      [16],
      (input) =>
        input.model !== "deepseek-v4.1-flash"
          ? Promise.resolve(llmResponse(input))
          : failure === "transport"
          ? Promise.resolve(
            new Response("offline provider unavailable", { status: 503 }),
          )
          : Promise.reject(
            new DOMException("offline attempt timeout", "TimeoutError"),
          ),
    );
    const fallback = await invoke();
    equal(fallback.status, "done", `${failure} falls back successfully`);
    equal(fixture.calls.map((call) => call.model), [
      "deepseek-v4.1-flash",
      "minimax-m3",
    ], `${failure} cannot trigger same-model corrective calls`);
    equal(
      fallback.generation.chunks[0].correctionCount,
      0,
      `${failure} cannot create a correction log`,
    );
  }

  const validatorAbort = new AbortController();
  await setup([16], async (input) => {
    const response = llmResponse(input, true), payload = await response.json();
    response.json = () => {
      validatorAbort.abort(
        new DOMException(
          "offline generation cancelled before correction",
          "AbortError",
        ),
      );
      return Promise.resolve(payload);
    };
    return response;
  });
  const stoppedCorrection = await invoke({}, validatorAbort.signal);
  equal(
    stoppedCorrection.status,
    "error",
    "aborted invalid generation remains pending",
  );
  equal(
    stoppedCorrection.generation.chunks[0].correctionCount,
    0,
    "shared generation abort prevents corrective calls after validation fails",
  );
  equal(
    fixture.calls.filter((call) => call.model === "deepseek-v4.1-flash").length,
    1,
    "aborted model is not reprompted",
  );

  await setup([16], (input) => Promise.resolve(llmResponse(input)));
  for (let attempt = 0; attempt < 3; attempt++) await invoke({ preview: true });
  equal(fixture.writes, 0, "previews never save state");
  const afterPreviews = await invoke({ retry: true });
  equal(
    afterPreviews.status,
    "done",
    "preview attempts do not consume real date quota",
  );
  equal(
    afterPreviews.retry.deferred,
    [],
    "preview attempts do not impose cooldown",
  );

  await setup([16], (input) => Promise.resolve(llmResponse(input)));
  for (
    const invalid of [{ preview: 1 }, { preview: "true" }, { dry: 1 }, {
      retry: "true",
    }, {
      force: "true",
    }]
  ) {
    const response = await bounded(handler(request(invalid)));
    equal(
      response.status,
      500,
      "invalid request flag rejected before generation",
    );
    assert(
      (await response.json()).error.includes("boolean"),
      "invalid flag reports its type error",
    );
    equal(
      fixture.runs.at(-1)!.targets,
      [],
      "invalid request flags cannot consume target quota",
    );
  }
  equal(fixture.calls.length, 0, "invalid request flags cannot call an LLM");
  equal(fixture.writes, 0, "invalid request flags cannot save state");

  const stale: Run = {
    run_id: "stale-preview",
    started_at: new Date(now - 6 * 60_000).toISOString(),
    status: "running",
    note: "preview: 생성 중 (저장 안 함)",
    targets: ["2026-10-16"],
    target_start: "2026-10-16",
    target_end: "2026-10-16",
  };
  await setup([16], (input) => Promise.resolve(llmResponse(input)), [stale]);
  const afterStalePreview = await invoke({ retry: true });
  equal(
    afterStalePreview.status,
    "done",
    "stale preview cannot block real recovery",
  );
  assert(
    String(fixture.runs[0].status) === "error" &&
      fixture.runs[0].note.startsWith("preview:"),
    "cleanup preserves preview provenance for quota exclusion",
  );

  const entered = gate(), release = gate();
  await setup([16], async (input) => {
    entered.resolve();
    await release.promise;
    return llmResponse(input);
  });
  const first = handler(request()), second = handler(request({ retry: true }));
  try {
    await bounded(entered.promise);
    const busy = await (await bounded(Promise.race([first, second]))).clone()
      .json();
    equal(
      busy.reason,
      "already_running",
      "simultaneous invocations claim only one live run",
    );
    equal(
      fixture.calls.length,
      1,
      "busy request cannot spend another model call",
    );
    equal(
      fixture.runs.length,
      1,
      "busy request cannot consume another quota row",
    );
  } finally {
    release.resolve();
  }
  const concurrent = await Promise.all([first, second]);
  assert(
    (await Promise.all(concurrent.map((response) => response.json()))).some((
      result,
    ) => result.status === "done"),
    "the claimed invocation finishes normally",
  );

  const abort = new AbortController();
  await setup(
    [15, 16],
    (input) =>
      input.date.endsWith("16")
        ? Promise.resolve(llmResponse(input))
        : new Promise((_, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          );
        }),
  );
  // Observation at the accepted-generation merge boundary aborts the request
  // deterministically; it does not replace the real validation/merge/save logic.
  beforeMerge = () => {
    beforeMerge = undefined;
    abort.abort(new DOMException("offline request interrupted", "AbortError"));
  };
  const interrupted = await invoke({}, abort.signal);
  equal(
    interrupted.status,
    "partial",
    "request abort retains the accepted day under the separate save signal",
  );
  assert(
    completeMenuDates(await currentState(), MEALS).includes("2026-10-16"),
    "completed chunk survives request abort in encrypted read-back",
  );
  equal(interrupted.failedDates.map((item: { date: string }) => item.date), [
    "2026-10-15",
  ], "aborted unfinished date remains pending");
  console.log(
    "DAILY_AUTOMATION_OK / ACTUAL_HANDLER_PARTIAL_CAS_MANUAL / COOLDOWN_DAILY_CAP / FORCE_CAP_BOUND / CORRECTION_DIAGNOSTICS / PREVIEW_QUOTA / INVALID_FLAGS / STALE_PREVIEW / ATOMIC_BUSY / ABORT_COMPLETED_DAY",
  );
} finally {
  globalThis.Date = nativeDate;
  globalThis.fetch = nativeFetch;
  for (const timer of signalTimers) clearTimeout(timer);
  for (const [key, value] of savedEnv) {
    value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
  for (
    const key of [
      "__nmfOfflineDb",
      "__nmfCaptureHandler",
      "__nmfBeforeGenerationMerge",
      "__nmfOfflineTimeout",
    ]
  ) delete globals[key];
}
