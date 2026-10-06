// Explicit one-time staff-history recovery. Dry by default; never restores active staff.
import {
  decryptText,
  encryptText,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";

type JsonObject = Record<string, unknown>;
export type CloudRow = { id: string; data: string; updated_at: string };
export type BackupRef = Pick<CloudRow, "id" | "updated_at">;
export type RosterStats = {
  cells: number;
  months: Record<string, { cells: number; hours: number }>;
};
export interface RecoveryStorage {
  readCurrent(): Promise<CloudRow>;
  listDailyBackups(): Promise<BackupRef[]>;
  readBackup(ref: BackupRef): Promise<CloudRow>;
  createBackup(row: CloudRow): Promise<CloudRow>;
  compareAndSwap(before: CloudRow, after: CloudRow): Promise<CloudRow | null>;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function idOf(row: JsonObject): string | null {
  const id = row.id;
  return (typeof id === "string" && id.trim()) ||
      (typeof id === "number" && Number.isFinite(id))
    ? String(id)
    : null;
}
function records(state: JsonObject, field: string): JsonObject[] {
  const value = state[field] ?? (field === "staffArchive" ? [] : undefined);
  if (
    !Array.isArray(value) || value.some((row) => !object(row) || !idOf(row))
  ) {
    throw new Error("Invalid staff collection; recovery stopped");
  }
  return value as JsonObject[];
}
async function decode(password: string, row: CloudRow): Promise<JsonObject> {
  let value: unknown;
  try {
    value = JSON.parse(await decryptText(password, row.data));
  } catch {
    // JSON parser diagnostics can quote decrypted employee fields. Never log them.
    throw new Error("Encrypted state could not be decoded; recovery stopped");
  }
  if (!object(value)) {
    throw new Error("Invalid encrypted state; recovery stopped");
  }
  return value;
}
function meaningful(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (object(value)) return Object.keys(value).length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "string" || value.trim().length > 0;
}
function shiftHours(value: unknown): number {
  if (!object(value)) return 0;
  const minutes = (time: unknown): number | null => {
    if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return null;
    const [h, m] = time.split(":").map(Number);
    return h < 24 && m < 60 ? h * 60 + m : null;
  };
  const start = minutes(value.s), end = minutes(value.e);
  if (start === null || end === null || start === end) return 0;
  const breakMinutes = Number(value.b) || 0;
  return Math.max(0, end + (end < start ? 1440 : 0) - start - breakMinutes) /
    60;
}

/** Only IDs with actual retained monthly roster entries, excluding current/archive IDs. */
export function orphanRoster(state: JsonObject): Map<string, RosterStats> {
  const known = new Set(
    [...records(state, "staff"), ...records(state, "staffArchive")].map(idOf),
  );
  const roster = state.roster ?? {};
  if (!object(roster)) throw new Error("Invalid roster; recovery stopped");
  const result = new Map<string, RosterStats>();
  for (const [month, cells] of Object.entries(roster)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !object(cells)) continue;
    const [year, monthNumber] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    for (const [key, value] of Object.entries(cells)) {
      const match = key.match(/^(.+)\|(\d+|adj)$/);
      if (!match || !meaningful(value) || known.has(match[1])) continue;
      if (
        match[2] === "adj"
          ? Number(value) === 0
          : Number(match[2]) < 1 || Number(match[2]) > lastDay
      ) continue;
      const stats = result.get(match[1]) ?? { cells: 0, months: {} };
      const monthly = stats.months[month] ?? { cells: 0, hours: 0 };
      stats.cells++;
      monthly.cells++;
      monthly.hours += shiftHours(value);
      stats.months[month] = monthly;
      result.set(match[1], stats);
    }
  }
  return result;
}

export function assertArchiveOnly(before: JsonObject, after: JsonObject): void {
  const protectedBefore = structuredClone(before),
    protectedAfter = structuredClone(after);
  delete protectedBefore.staffArchive;
  delete protectedAfter.staffArchive;
  if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter)) {
    throw new Error("Protected data changed; recovery stopped");
  }
  const original = records(before, "staffArchive"),
    next = records(after, "staffArchive");
  if (
    JSON.stringify(next.slice(0, original.length)) !== JSON.stringify(original)
  ) {
    throw new Error("Existing archive changed; recovery stopped");
  }
  const active = new Set(records(before, "staff").map(idOf));
  const existing = new Set(original.map(idOf));
  const orphans = orphanRoster(before);
  for (const row of next.slice(original.length)) {
    const id = idOf(row)!;
    if (active.has(id) || existing.has(id) || !orphans.has(id)) {
      throw new Error("Ineligible or duplicate recovery; recovery stopped");
    }
    existing.add(id);
  }
}

function orderedDaily(refs: BackupRef[]): BackupRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!/^namofood@\d{4}-\d{2}-\d{2}$/.test(ref.id)) return false;
    if (!Number.isFinite(Date.parse(ref.updated_at)) || seen.has(ref.id)) {
      throw new Error("Invalid backup inventory; recovery stopped");
    }
    seen.add(ref.id);
    return true;
  }).sort((a, b) =>
    Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
    b.id.localeCompare(a.id)
  );
}

/** Newest exact staff metadata only. A malformed/ambiguous latest match is not guessed. */
export async function planRecovery(
  before: JsonObject,
  refs: BackupRef[],
  readState: (ref: BackupRef) => Promise<JsonObject>,
  archivedAt: string,
) {
  const orphans = orphanRoster(before), unresolved = new Set(orphans.keys());
  const additions: JsonObject[] = [], rejected = new Set<string>();
  const names = new Map<string, Set<string>>();
  let snapshotsRead = 0;
  for (const ref of orderedDaily(refs)) {
    const snapshot = await readState(ref);
    snapshotsRead++;
    if (!Array.isArray(snapshot.staff)) continue;
    for (const id of orphans.keys()) {
      const matches = snapshot.staff.filter((row) =>
        object(row) && idOf(row) === id
      ) as JsonObject[];
      if (!matches.length) continue;
      const historyNames = names.get(id) ?? new Set<string>();
      for (const row of matches) {
        if (typeof row.name === "string" && row.name.trim()) {
          historyNames.add(row.name);
        }
        if (Array.isArray(row.historyNames)) {
          for (const name of row.historyNames) {
            if (typeof name === "string" && name.trim()) historyNames.add(name);
          }
        }
      }
      names.set(id, historyNames);
      if (!unresolved.has(id)) continue;
      unresolved.delete(id);
      const staff = matches[0];
      if (
        typeof staff.name !== "string" || !staff.name.trim() ||
        matches.some((row) => JSON.stringify(row) !== JSON.stringify(staff))
      ) {
        rejected.add(id);
        continue;
      }
      additions.push({
        ...structuredClone(staff),
        archivedAt,
        recoveredFrom: { backupId: ref.id, updated_at: ref.updated_at },
      });
    }
  }
  for (const row of additions) {
    row.historyNames = [...(names.get(idOf(row)!) ?? [])];
  }
  const after = structuredClone(before);
  if (additions.length) {
    after.staffArchive = [...records(before, "staffArchive"), ...additions];
  }
  assertArchiveOnly(before, after);
  const months: Record<string, { cells: number; hours: number }> = {};
  for (const row of additions) {
    for (
      const [month, stats] of Object.entries(orphans.get(idOf(row)!)!.months)
    ) {
      const total = months[month] ?? { cells: 0, hours: 0 };
      total.cells += stats.cells;
      total.hours += stats.hours;
      months[month] = total;
    }
  }
  for (const stats of Object.values(months)) {
    stats.hours = Math.round(stats.hours * 100) / 100;
  }
  return {
    after,
    additions,
    report: {
      orphanCount: orphans.size,
      recoverableCount: additions.length,
      unresolvedCount: unresolved.size + rejected.size,
      ambiguousOrInvalidCount: rejected.size,
      snapshotsRead,
      months,
      protectedChanged: 0,
    },
  };
}

export async function recoverStaffHistory(options: {
  password: string;
  apply: boolean;
  storage: RecoveryStorage;
  now?: () => string;
  uuid?: () => string;
}) {
  const { password, apply, storage } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const backups: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = await storage.readCurrent();
    if (
      current.id !== "namofood" ||
      !Number.isFinite(Date.parse(current.updated_at))
    ) {
      throw new Error("Invalid current row; recovery stopped");
    }
    const before = await decode(password, current), at = now();
    const refs = orphanRoster(before).size
      ? await storage.listDailyBackups()
      : [];
    const plan = await planRecovery(before, refs, async (ref) => {
      const row = await storage.readBackup(ref);
      if (row.id !== ref.id || row.updated_at !== ref.updated_at) {
        throw new Error("Backup changed during read; rerun recovery");
      }
      return await decode(password, row);
    }, at);
    if (!apply || !plan.additions.length) {
      return { dry: !apply, saved: false, attempt, backups, ...plan.report };
    }
    // Exact old encrypted blob: one unique snapshot for each CAS attempt, no upsert/reuse.
    const backup: CloudRow = {
      id: `namofood@before-staff-history-recovery-${
        at.replace(/[:.]/g, "-")
      }-${uuid()}-${attempt}`,
      data: current.data,
      updated_at: at,
    };
    const confirmed = await storage.createBackup(backup);
    if (confirmed.id !== backup.id || confirmed.data !== current.data) {
      throw new Error("Encrypted backup unconfirmed; state not written");
    }
    backups.push(backup.id);
    const next: CloudRow = {
      id: "namofood",
      data: await encryptText(password, JSON.stringify(plan.after)),
      updated_at: at,
    };
    const saved = await storage.compareAndSwap(current, next);
    if (!saved) continue; // Next attempt reads current state and recomputes eligibility.
    const written = await decode(password, saved);
    assertArchiveOnly(before, written);
    if (
      saved.id !== "namofood" ||
      JSON.stringify(written) !== JSON.stringify(plan.after)
    ) {
      throw new Error(
        "Written state verification failed; inspect encrypted snapshot",
      );
    }
    return { dry: false, saved: true, attempt, backups, ...plan.report };
  }
  throw new Error(
    "CAS conflict after 3 fresh attempts; no stale state overwritten",
  );
}

async function restStorage(): Promise<RecoveryStorage> {
  const src = await Deno.readTextFile(
    new URL("../nmf_cloud.mjs", import.meta.url),
  );
  const key = src.match(/const KEY =\s*"([^"]+)"/)?.[1];
  const origin = src.match(/const URL_ =\s*"([^"]+)"/)?.[1];
  if (!key || !origin || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(origin)) {
    throw new Error("Cloud configuration unavailable");
  }
  const url = `${origin}/rest/v1/namofood_state`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  async function request(
    query: string,
    method = "GET",
    body?: unknown,
  ): Promise<CloudRow[]> {
    const response = await fetch(url + query, {
      method,
      headers: {
        ...headers,
        ...(method !== "GET" ? { Prefer: "return=representation" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Cloud ${method} failed (${response.status}); no sensitive response logged`,
      );
    }
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error("Unexpected cloud response");
    return rows as CloudRow[];
  }
  function single(rows: CloudRow[]): CloudRow {
    if (
      rows.length !== 1 || !rows[0].id || !rows[0].data || !rows[0].updated_at
    ) {
      throw new Error("Expected exactly one encrypted cloud row");
    }
    return rows[0];
  }
  return {
    readCurrent: async () =>
      single(await request("?id=eq.namofood&select=id,data,updated_at")),
    async listDailyBackups() {
      const refs: BackupRef[] = [];
      const limit = 200;
      for (let offset = 0; offset < 10_000; offset += limit) {
        const rows = await request(
          `?id=like.namofood%40*&select=id,updated_at&order=updated_at.desc,id.desc&limit=${limit}&offset=${offset}`,
        );
        refs.push(...rows.map(({ id, updated_at }) => ({ id, updated_at })));
        if (rows.length < limit) return orderedDaily(refs);
      }
      throw new Error("Backup inventory exceeded safe bound; recovery stopped");
    },
    readBackup: async (ref) =>
      single(
        await request(
          `?id=eq.${encodeURIComponent(ref.id)}&select=id,data,updated_at`,
        ),
      ),
    createBackup: async (row) =>
      single(await request("?select=id,data,updated_at", "POST", [row])),
    async compareAndSwap(before, after) {
      const rows = await request(
        `?id=eq.namofood&updated_at=eq.${
          encodeURIComponent(before.updated_at)
        }&select=id,data,updated_at`,
        "PATCH",
        {
          data: after.data,
          updated_at: after.updated_at,
        },
      );
      return rows.length ? single(rows) : null;
    },
  };
}

async function selfTest() {
  const assert = (ok: unknown, label: string) => {
    if (!ok) throw new Error(`Self-test failed: ${label}`);
  };
  const mustReject = async (fn: () => unknown, label: string) => {
    let failed = false;
    try {
      await fn();
    } catch {
      failed = true;
    }
    assert(failed, label);
  };
  const shift = { s: "22:00", e: "06:00", b: 60 };
  const base: JsonObject = {
    staff: [{ id: "active", name: "Current", wage: 100 }],
    staffArchive: [{ id: "archived", name: "Archived" }],
    roster: {
      "2026-10": {
        "active|1": shift,
        "archived|1": shift,
        "lost|1": shift,
        "unknown|2": "휴",
        "empty|1": "",
        "empty|2": {},
        "zero|adj": 0,
        "bad-day|32": shift,
      },
    },
    menus: { "2026-10": { "1|중식|1": "Manual soup" } },
    recipes: { manual: { items: [{ name: "Keep", qty: 1 }] } },
    settings: { manual: "Keep" },
    updatedAt: "Keep exact inner timestamp",
  };
  const refs = [
    { id: "namofood@2026-10-01", updated_at: "2026-10-01T00:00:00Z" },
    { id: "namofood@2026-10-03", updated_at: "2026-10-03T00:00:00Z" },
    { id: "namofood@before-ignored", updated_at: "2026-10-04T00:00:00Z" },
  ];
  const latest = {
    id: "lost",
    name: "Newest exact",
    wage: 12345,
    role: "Exact",
    def: shift,
    off: ["일"],
    custom: { keep: true },
  };
  const snapshots = new Map<string, JsonObject>([
    [refs[0].id, {
      staff: [{ ...latest, name: "Old", wage: 10 }, {
        id: "active",
        name: "Do not recover",
      }],
    }],
    [refs[1].id, { staff: [latest] }],
  ]);
  const plan = await planRecovery(
    base,
    refs,
    async (ref) => snapshots.get(ref.id)!,
    "2026-10-06T00:00:00Z",
  );
  assert(
    plan.report.orphanCount === 2 && plan.report.recoverableCount === 1 &&
      plan.report.unresolvedCount === 1,
    "eligibility, empty/existing exclusions and unresolved only",
  );
  assert(
    plan.additions[0].name === latest.name &&
      plan.additions[0].wage === latest.wage,
    "newest exact metadata",
  );
  assert(
    JSON.stringify(plan.additions[0].historyNames) ===
      JSON.stringify(["Newest exact", "Old"]),
    "historical exact names retained without renaming latest",
  );
  assert(
    JSON.stringify(plan.additions[0].custom) === JSON.stringify(latest.custom),
    "custom metadata retained",
  );
  assert(plan.report.months["2026-10"].hours === 7, "overnight shift totals");
  assertArchiveOnly(base, plan.after);
  await mustReject(
    () =>
      assertArchiveOnly(base, { ...plan.after, settings: { changed: true } }),
    "protected change negative control",
  );
  const ambiguous = await planRecovery(
    base,
    refs,
    async () => ({ staff: [latest, { ...latest, wage: 1 }] }),
    "now",
  );
  assert(
    !ambiguous.additions.length &&
      ambiguous.report.ambiguousOrInvalidCount === 1,
    "ambiguous latest metadata not guessed",
  );

  const password = "isolated-test-only";
  const encrypted = async (
    state: JsonObject,
    updated_at = "2026-10-06T01:00:00Z",
  ): Promise<CloudRow> => ({
    id: "namofood",
    data: await encryptText(password, JSON.stringify(state)),
    updated_at,
  });
  let current = await encrypted(base),
    backupCalls = 0,
    writeCalls = 0,
    conflict = false,
    failBackup = false;
  const savedBackupIds = new Set<string>();
  const storage: RecoveryStorage = {
    readCurrent: async () => current,
    listDailyBackups: async () => refs,
    readBackup: async (ref) => ({
      ...ref,
      data: await encryptText(password, JSON.stringify(snapshots.get(ref.id))),
    }),
    async createBackup(row) {
      backupCalls++;
      if (failBackup) throw new Error("Isolated backup failure");
      assert(
        row.data === current.data,
        "backup preserves exact encrypted current state",
      );
      assert(!savedBackupIds.has(row.id), "unique backup per attempt");
      savedBackupIds.add(row.id);
      await decode(password, row);
      return row;
    },
    async compareAndSwap(before, after) {
      writeCalls++;
      if (conflict) {
        conflict = false;
        const remote = await decode(password, current);
        (remote.staff as JsonObject[]).push(structuredClone(latest));
        remote.settings = { manual: "Concurrent edit" };
        remote.roster = {
          ...(remote.roster as JsonObject),
          "2026-09": { "new-lost|1": shift },
        };
        current = await encrypted(remote, "2026-10-06T02:00:00Z");
        return null;
      }
      assert(before.updated_at === current.updated_at, "CAS current version");
      current = after;
      return after;
    },
  };
  let sequence = 0;
  const options = {
    password,
    storage,
    now: () => "2026-10-06T03:00:00Z",
    uuid: () => `test-${++sequence}`,
  };
  const dry = await recoverStaffHistory({ ...options, apply: false });
  assert(
    dry.dry && dry.recoverableCount === 1 && backupCalls === 0 &&
      writeCalls === 0,
    "dry performs no writes",
  );
  failBackup = true;
  await mustReject(
    () => recoverStaffHistory({ ...options, apply: true }),
    "backup failure prevents write",
  );
  assert(writeCalls === 0, "no CAS on backup failure");
  failBackup = false;
  const saved = await recoverStaffHistory({ ...options, apply: true });
  assert(
    saved.saved && saved.recoverableCount === 1 && writeCalls === 1,
    "verified encrypted apply",
  );
  assertArchiveOnly(base, await decode(password, current));
  const again = await recoverStaffHistory({ ...options, apply: true });
  assert(
    !again.saved && again.recoverableCount === 0 && writeCalls === 1,
    "idempotent no-op",
  );
  current = await encrypted(base);
  conflict = true;
  const raced = await recoverStaffHistory({ ...options, apply: true });
  const fresh = await decode(password, current);
  assert(
    raced.attempt === 2 && !raced.saved && raced.unresolvedCount === 2,
    "fresh eligibility after CAS conflict",
  );
  assert(
    (fresh.settings as JsonObject).manual === "Concurrent edit" &&
      (fresh.staff as JsonObject[]).some((row) => row.id === "lost"),
    "concurrent reinstatement and edits preserved",
  );
  assert(
    (fresh.staffArchive as JsonObject[]).length === 1,
    "reinstated employee not archived",
  );
  current = await encrypted(base);
  const attemptsBefore = writeCalls;
  await mustReject(
    () =>
      recoverStaffHistory({
        ...options,
        apply: true,
        storage: {
          ...storage,
          compareAndSwap: async () => {
            writeCalls++;
            return null;
          },
        },
      }),
    "persistent conflict stops after three attempts",
  );
  assert(writeCalls - attemptsBefore === 3, "bounded CAS attempts");
  assert(
    JSON.stringify(await decode(password, current)) === JSON.stringify(base),
    "persistent conflict never overwrites state",
  );
  const unconfirmedCalls = writeCalls;
  await mustReject(
    () =>
      recoverStaffHistory({
        ...options,
        apply: true,
        storage: {
          ...storage,
          createBackup: async (row) => ({ ...row, data: "unconfirmed" }),
        },
      }),
    "unconfirmed backup rejected",
  );
  assert(writeCalls === unconfirmedCalls, "unconfirmed backup prevents CAS");
  console.log(
    JSON.stringify({
      selfTest: "STAFF_HISTORY_RECOVERY_OK",
      protectedChanged: 0,
      network: false,
    }),
  );
}

if (import.meta.main) {
  try {
    if (
      Deno.args.some((arg) => !["--apply", "--self-test"].includes(arg)) ||
      Deno.args.includes("--apply") && Deno.args.includes("--self-test")
    ) {
      throw new Error(
        "Use no flags for dry run, --apply for reviewed write, or --self-test",
      );
    }
    if (Deno.args.includes("--self-test")) await selfTest();
    else {
      const password = Deno.env.get("NMF_PW");
      if (!password) throw new Error("NMF_PW required; no password fallback");
      console.log(
        JSON.stringify(
          await recoverStaffHistory({
            password,
            apply: Deno.args.includes("--apply"),
            storage: await restStorage(),
          }),
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Recovery stopped",
      }),
    );
    Deno.exit(1);
  }
}
