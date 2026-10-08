// Deterministic scheduling contract; never connects to a production database.
function assert(
  value: unknown,
  message = "schedule contract failed",
): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "unexpected schedule value",
) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}

const migration = await Deno.readTextFile(
  new URL(
    "../supabase/migrations/20261008171612_nmf_menu_recommend_daily_prepare.sql",
    import.meta.url,
  ),
);
type Bank = {
  date: string;
  ready?: boolean;
  lease?: number;
  attemptedAt?: number;
};
function eligibleDates(now: string, banks: Bank[]): string[] {
  const ms = Date.parse(now), kst = new Date(ms + 9 * 3_600_000);
  const start = Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate(),
  );
  const active = banks.filter((bank) => (bank.lease || 0) > ms).length;
  return Array.from(
    { length: 15 },
    (_, offset) =>
      new Date(start + offset * 86_400_000).toISOString().slice(0, 10),
  )
    .filter((date) =>
      !banks.some((bank) =>
        bank.date === date && (bank.ready || (bank.lease || 0) > ms)
      )
    )
    .sort((a, b) =>
      (banks.find((bank) => bank.date === a)?.attemptedAt || 0) -
        (banks.find((bank) => bank.date === b)?.attemptedAt || 0) ||
      a.localeCompare(b)
    )
    .slice(0, Math.max(0, 2 - active));
}
assert(migration.includes("(now() at time zone 'Asia/Seoul')::date"));
assert(migration.includes("generate_series(0, 14)"));
assert(migration.includes("limit slots_available"));
assert(migration.includes("greatest(0, 2 - count(*))"));
assert(migration.includes("banks.response is null"));
assert(migration.includes("banks.lease_expires_at <= now()"));
assert(
  migration.includes(
    "order by banks.updated_at nulls first, offsets.day_offset",
  ),
);
assert(migration.includes("'action', 'prepare'"));
assert(migration.includes("'nmf_recipe_fill_secret'"));
assert(migration.includes("security invoker"));
assert(migration.includes("set search_path = ''"));
assert(migration.includes("from public, anon, authenticated"));
assert(
  !/security definer|update\s+cron\.job|insert\s+into\s+cron\.job/i.test(
    migration,
  ),
);
assert(
  !/cron\.(?:unschedule|alter_job)/.test(migration),
  "existing retired-menu/recipe jobs untouched",
);
assertEquals((migration.match(/select cron\.schedule\(/g) || []).length, 2);
assert(migration.includes("'5 21 * * *'"));
assert(migration.includes("'*/5 * * * *'"));
assertEquals(eligibleDates("2026-10-08T14:59:59Z", []), [
  "2026-10-08",
  "2026-10-09",
]);
assertEquals(eligibleDates("2026-10-08T15:00:00Z", []), [
  "2026-10-09",
  "2026-10-10",
]);
assertEquals(eligibleDates("2026-12-31T15:00:00Z", []), [
  "2027-01-01",
  "2027-01-02",
]);
assertEquals(eligibleDates("2028-02-28T15:00:00Z", []), [
  "2028-02-29",
  "2028-03-01",
]);
const now = "2026-10-09T00:00:00Z", ms = Date.parse(now);
const ready = Array.from(
  { length: 14 },
  (_, offset) => ({
    date: new Date(Date.parse("2026-10-09T00:00:00Z") + offset * 86_400_000)
      .toISOString().slice(0, 10),
    ready: true,
  }),
);
assertEquals(eligibleDates(now, ready), ["2026-10-23"], "today+14 included");
assertEquals(
  eligibleDates(now, [...ready, { date: "2026-10-23", ready: true }]),
  [],
  "ready horizon emits no work",
);
assertEquals(
  eligibleDates(now, [{ date: "2026-10-09", lease: ms + 150_000 }]),
  ["2026-10-10"],
  "one active job leaves one slot",
);
assertEquals(
  eligibleDates(now, [{ date: "2026-10-09", lease: ms + 150_000 }, {
    date: "2026-10-10",
    lease: ms + 150_000,
  }]),
  [],
  "two active jobs leave no slots",
);
assertEquals(eligibleDates(now, [{ date: "2026-10-09", lease: ms - 1 }]), [
  "2026-10-09",
  "2026-10-10",
], "expired lease is retried");
assertEquals(
  eligibleDates(now, [{ date: "2026-10-09", attemptedAt: ms }, {
    date: "2026-10-10",
    attemptedAt: ms,
  }]),
  ["2026-10-11", "2026-10-12"],
  "repeated failures cannot starve new dates",
);
const failedWindow = Array.from(
  { length: 15 },
  (_, offset) => ({
    date: new Date(Date.parse("2026-10-09T00:00:00Z") + offset * 86_400_000)
      .toISOString().slice(0, 10),
    attemptedAt: ms - offset,
  }),
);
assertEquals(
  eligibleDates(now, failedWindow),
  ["2026-10-23", "2026-10-22"],
  "oldest failed attempts receive fair retries",
);
console.log(
  "MENU_RECOMMEND_SCHEDULE_OK / KST_ROLLOVER / INCLUSIVE_14_DAY_HORIZON / TWO_GLOBAL_SLOTS / READY_SKIP / EXPIRED_LEASE_RETRY / FAIR_FAILURE_RETRY / RETIRED_JOBS_UNTOUCHED",
);
