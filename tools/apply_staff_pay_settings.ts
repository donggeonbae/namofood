// Reviewed one-time pay initialization. Dry by default, encrypted backup before CAS.
import {
  decryptText,
  encryptText,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";
import type { CloudRow, RecoveryStorage } from "./recover_staff_history.ts";

type State = Record<string, unknown>;
type Storage = Pick<
  RecoveryStorage,
  "readCurrent" | "createBackup" | "compareAndSwap"
>;
export const INITIAL_ROLES = ["총괄", "조리", "보조", "이송"] as const;
export const INITIAL_ROLE_WAGES = {
  총괄: 15000,
  조리: 15000,
  보조: 13000,
  이송: 13000,
};
const SETTINGS_FIELDS = ["roleWages", "staffRoles", "rolePayInitialized"];
/** Names are private runtime inputs, never public defaults or console diagnostics. */
export function validateStaffPayNames(value: unknown): Set<string> {
  if (
    !Array.isArray(value) || value.length !== 3 ||
    value.some((name) => typeof name !== "string" || !name.trim()) ||
    new Set(value).size !== 3
  ) {
    throw new Error(
      "NMF_STAFF_PAY_NAMES must be a JSON array of three distinct nonempty names; values omitted",
    );
  }
  return new Set(value as string[]);
}
export function parseStaffPayNames(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("NMF_STAFF_PAY_NAMES is not valid JSON; values omitted");
  }
  validateStaffPayNames(value);
  return value;
}

function object(value: unknown): value is State {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function settings(state: State): State {
  if (!object(state.settings)) {
    throw new Error("Invalid settings; initialization stopped");
  }
  return state.settings;
}
function members(state: State, field: "staff" | "staffArchive"): State[] {
  const rows = state[field] === undefined && field === "staffArchive"
    ? []
    : state[field];
  if (
    !Array.isArray(rows) ||
    rows.some((row) =>
      !object(row) || typeof row.id !== "string" || !row.id ||
      typeof row.name !== "string" ||
      row.role != null && typeof row.role !== "string"
    )
  ) {
    throw new Error("Invalid staff metadata; initialization stopped");
  }
  return rows as State[];
}
export function normalizeInitialRole(
  role: unknown,
): typeof INITIAL_ROLES[number] {
  if (INITIAL_ROLES.includes(role as typeof INITIAL_ROLES[number])) {
    return role as typeof INITIAL_ROLES[number];
  }
  const text = typeof role === "string" ? role : "";
  return /찬모|참모|조리|주방/.test(text)
    ? "조리"
    : /이송|운반|배송/.test(text)
    ? "이송"
    : /총괄|관리|실장|대표/.test(text)
    ? "총괄"
    : "보조";
}
function exact(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Field-level negative guard, including personal rates and every other state field. */
export function assertPayChangesOnly(
  before: State,
  after: State,
  namedTargets?: unknown,
) {
  const oldSettings = settings(before), nextSettings = settings(after);
  if (oldSettings.rolePayInitialized) {
    if (!exact(before, after)) {
      throw new Error("Initialized settings changed; initialization stopped");
    }
    return;
  }
  const namedOverrides = validateStaffPayNames(namedTargets);
  if (
    !exact(nextSettings.staffRoles, INITIAL_ROLES) ||
    !exact(nextSettings.roleWages, INITIAL_ROLE_WAGES) ||
    nextSettings.rolePayInitialized !== true
  ) {
    throw new Error("Unexpected initial role settings; initialization stopped");
  }
  const oldProtected = structuredClone(before),
    nextProtected = structuredClone(after);
  for (const field of SETTINGS_FIELDS) {
    delete settings(oldProtected)[field];
    delete settings(nextProtected)[field];
  }
  for (const field of ["staff", "staffArchive"] as const) {
    if (Object.hasOwn(before, field) !== Object.hasOwn(after, field)) {
      throw new Error("Staff collection presence changed");
    }
    const original = members(before, field), next = members(after, field);
    if (original.length !== next.length) {
      throw new Error("Staff collection size changed");
    }
    const scrubbedBefore: State[] = [], scrubbedAfter: State[] = [];
    original.forEach((row, i) => {
      const updated = next[i], expectedRole = normalizeInitialRole(row.role);
      if (
        updated.role !== expectedRole ||
        updated.previousRole !==
          (row.role === expectedRole ? row.previousRole : row.role ?? "")
      ) {
        throw new Error("Unexpected role/history change");
      }
      const b = structuredClone(row), a = structuredClone(updated);
      delete b.role;
      delete a.role;
      delete b.previousRole;
      delete a.previousRole;
      if (field === "staff" && namedOverrides.has(String(row.name))) {
        if (updated.wage !== 20000) {
          throw new Error("Unexpected named wage override");
        }
        delete b.wage;
        delete a.wage;
      }
      if (
        field === "staffArchive" && row.wage == null &&
        row.archivedWage == null && !row.historyUnknown
      ) {
        if (updated.archivedWage !== oldSettings.wage) {
          throw new Error("Unexpected frozen archive wage");
        }
        delete b.archivedWage;
        delete a.archivedWage;
      }
      scrubbedBefore.push(b);
      scrubbedAfter.push(a);
    });
    if (Object.hasOwn(before, field)) {
      oldProtected[field] = scrubbedBefore;
      nextProtected[field] = scrubbedAfter;
    }
  }
  if (!exact(oldProtected, nextProtected)) {
    throw new Error("Protected field changed; initialization stopped");
  }
}

export function planStaffPay(before: State, namedTargets?: unknown) {
  const oldSettings = settings(before), after = structuredClone(before);
  if (oldSettings.rolePayInitialized) {
    return {
      after,
      report: {
        initializationRequired: false,
        changedStaffRoles: 0,
        changedArchiveRoles: 0,
        namedWageChanges: 0,
        archiveWageFrozen: 0,
        protectedChanged: 0,
      },
    };
  }
  const namedOverrides = validateStaffPayNames(namedTargets);
  const active = members(before, "staff"),
    archive = members(before, "staffArchive"),
    all = [...active, ...archive];
  const ids = all.map((row) => row.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Duplicate staff IDs; initialization stopped");
  }
  for (const name of namedOverrides) {
    if (active.filter((row) => row.name === name).length !== 1) {
      throw new Error(
        "Named staff target missing or ambiguous; initialization stopped",
      );
    }
  }
  const freezing = archive.filter((row) =>
    row.wage == null && row.archivedWage == null && !row.historyUnknown
  );
  if (
    freezing.length &&
    (typeof oldSettings.wage !== "number" ||
      !Number.isFinite(oldSettings.wage) || oldSettings.wage < 0)
  ) {
    throw new Error("Global wage unavailable for archive preservation");
  }
  const nextSettings = settings(after);
  nextSettings.staffRoles = [...INITIAL_ROLES];
  nextSettings.roleWages = { ...INITIAL_ROLE_WAGES };
  nextSettings.rolePayInitialized = true;
  let changedStaffRoles = 0,
    changedArchiveRoles = 0,
    namedWageChanges = 0,
    archiveWageFrozen = 0;
  for (const field of ["staff", "staffArchive"] as const) {
    for (const row of members(after, field)) {
      if (
        field === "staffArchive" && row.wage == null &&
        row.archivedWage == null && !row.historyUnknown
      ) {
        row.archivedWage = oldSettings.wage;
        archiveWageFrozen++;
      }
      const role = normalizeInitialRole(row.role);
      if (role !== row.role) {
        row.previousRole = row.role ?? "";
        row.role = role;
        if (field === "staff") changedStaffRoles++;
        else changedArchiveRoles++;
      }
      if (
        field === "staff" && namedOverrides.has(String(row.name)) &&
        row.wage !== 20000
      ) {
        row.wage = 20000;
        namedWageChanges++;
      }
    }
  }
  assertPayChangesOnly(before, after, namedTargets);
  return {
    after,
    report: {
      initializationRequired: true,
      activeCount: active.length,
      archiveCount: archive.length,
      namedTargetCount: 3,
      changedStaffRoles,
      changedArchiveRoles,
      namedWageChanges,
      archiveWageFrozen,
      roleWages: INITIAL_ROLE_WAGES,
      staffRoles: INITIAL_ROLES,
      protectedChanged: 0,
    },
  };
}

async function decode(password: string, row: CloudRow): Promise<State> {
  try {
    const state: unknown = JSON.parse(await decryptText(password, row.data));
    if (!object(state)) throw new Error();
    return state;
  } catch {
    throw new Error(
      "Encrypted state could not be decoded; no staff details logged",
    );
  }
}
export async function applyStaffPay(
  options: {
    password: string;
    namedTargets?: unknown;
    apply: boolean;
    storage: Storage;
    now?: () => string;
    uuid?: () => string;
  },
) {
  const { password, apply, storage } = options;
  const now = options.now ?? (() => new Date().toISOString()),
    uuid = options.uuid ?? (() => crypto.randomUUID());
  const backups: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = await storage.readCurrent();
    if (
      current.id !== "namofood" ||
      !Number.isFinite(Date.parse(current.updated_at))
    ) throw new Error("Invalid current row; initialization stopped");
    const before = await decode(password, current),
      plan = planStaffPay(before, options.namedTargets);
    if (!apply || !plan.report.initializationRequired) {
      return {
        dry: !apply,
        saved: false,
        readBackVerified: false,
        attempt,
        backups,
        ...plan.report,
      };
    }
    const at = now(),
      backup: CloudRow = {
        id: `namofood@before-staff-pay-${
          at.replace(/[:.]/g, "-")
        }-${uuid()}-${attempt}`,
        data: current.data,
        updated_at: at,
      };
    const confirmed = await storage.createBackup(backup);
    if (
      confirmed.id !== backup.id || confirmed.data !== current.data ||
      Date.parse(confirmed.updated_at) !== Date.parse(at)
    ) throw new Error("Encrypted backup unconfirmed; state not written");
    backups.push(backup.id);
    const next: CloudRow = {
      id: "namofood",
      data: await encryptText(password, JSON.stringify(plan.after)),
      updated_at: at,
    };
    const saved = await storage.compareAndSwap(current, next);
    if (!saved) continue; // Re-read and rebuild from fresh state; never overwrite a stale baseline.
    const written = await decode(password, saved);
    assertPayChangesOnly(before, written, options.namedTargets);
    if (saved.id !== "namofood" || !exact(written, plan.after)) {
      throw new Error(
        "Saved state verification failed; inspect encrypted backup before retry",
      );
    }
    const readBack = await storage.readCurrent();
    if (
      readBack.id !== saved.id || readBack.data !== saved.data ||
      Date.parse(readBack.updated_at) !== Date.parse(saved.updated_at)
    ) {
      throw new Error(
        "Initialization committed but read-back changed concurrently; inspect before retry",
      );
    }
    if (!exact(await decode(password, readBack), plan.after)) {
      throw new Error(
        "Initialization committed but read-back verification failed",
      );
    }
    return {
      dry: false,
      saved: true,
      readBackVerified: true,
      attempt,
      backups,
      ...plan.report,
    };
  }
  throw new Error(
    "CAS conflict after 3 fresh attempts; no stale state overwritten",
  );
}

async function restStorage(): Promise<Storage> {
  const src = await Deno.readTextFile(
    new URL("../nmf_cloud.mjs", import.meta.url),
  );
  const key = src.match(/const KEY =\s*"([^"]+)"/)?.[1],
    origin = src.match(/const URL_ =\s*"([^"]+)"/)?.[1];
  if (!key || !origin || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(origin)) {
    throw new Error("Cloud configuration unavailable");
  }
  const url = `${origin}/rest/v1/namofood_state`,
    headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  async function request(
    query: string,
    method = "GET",
    payload?: unknown,
  ): Promise<CloudRow[]> {
    const response = await fetch(url + query, {
      method,
      headers: {
        ...headers,
        ...(method !== "GET" ? { Prefer: "return=representation" } : {}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Cloud ${method} failed (${response.status}); sensitive response omitted`,
      );
    }
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error("Unexpected cloud response");
    return rows as CloudRow[];
  }
  function single(rows: CloudRow[]): CloudRow {
    if (
      rows.length !== 1 || !rows[0].id || !rows[0].data || !rows[0].updated_at
    ) throw new Error("Expected exactly one encrypted row");
    return rows[0];
  }
  return {
    readCurrent: async () =>
      single(await request("?id=eq.namofood&select=id,data,updated_at")),
    createBackup: async (row) =>
      single(await request("?select=id,data,updated_at", "POST", [row])),
    async compareAndSwap(before, after) {
      const rows = await request(
        `?id=eq.namofood&updated_at=eq.${
          encodeURIComponent(before.updated_at)
        }&select=id,data,updated_at`,
        "PATCH",
        { data: after.data, updated_at: after.updated_at },
      );
      return rows.length ? single(rows) : null;
    },
  };
}

async function selfTest() {
  const namedTargets = ["가상대상A", "가상대상B", "가상대상C"];
  const assert = (ok: unknown, label: string) => {
    if (!ok) throw new Error(`Self-test failed: ${label}`);
  };
  const rejects = async (fn: () => unknown, label: string) => {
    let thrown = false;
    try {
      await fn();
    } catch {
      thrown = true;
    }
    assert(thrown, label);
  };
  const base: State = {
    settings: { wage: 15000, night: 1.5, custom: { preserve: true } },
    staff: [
      {
        id: "named-a",
        name: "가상대상A",
        role: "총괄",
        wage: 20000,
        bonus: 500,
      },
      { id: "named-b", name: "가상대상B", role: "참모", wage: 19000 },
      { id: "named-c", name: "가상대상C", role: "조리", wage: 20000 },
      { id: "manual", name: "Other", role: "", wage: 17777, off: ["일"] },
      { id: "zero", name: "Zero", role: "이송", wage: 0 },
    ],
    staffArchive: [
      {
        id: "archive",
        name: "Former",
        role: "주방",
        wage: null,
        historyNames: ["Old"],
        archivedAt: "unchanged",
      },
      { id: "zero-archive", name: "Former zero", role: "보조", wage: 0 },
      {
        id: "frozen",
        name: "Already frozen",
        role: "",
        wage: null,
        archivedWage: 12345,
      },
      {
        id: "unknown",
        name: "Unknown",
        role: "",
        wage: null,
        historyUnknown: true,
      },
    ],
    roster: { "2026-10": { "manual|1": { s: "22:00", e: "06:00", b: 60 } } },
    menus: { "2026-10": { "1|중식|1": "Manual soup" } },
    recipes: [{ menu: "Keep", qty: 1 }],
    sales: { preserve: 42 },
    updatedAt: "Inner timestamp unchanged",
  };
  const plan = planStaffPay(base, namedTargets),
    staff = members(plan.after, "staff"),
    archive = members(plan.after, "staffArchive");
  assert(
    plan.report.namedWageChanges === 1 && plan.report.archiveWageFrozen === 1,
    "bounded rate changes",
  );
  assert(
    staff[1].role === "조리" && staff[1].previousRole === "참모" &&
      archive[0].role === "조리" && archive[0].previousRole === "주방",
    "initial mapping and old role retained",
  );
  assert(
    staff[3].wage === 17777 && staff[4].wage === 0 && archive[1].wage === 0,
    "other personal and zero rates preserved",
  );
  assert(
    archive[0].archivedWage === 15000 && archive[2].archivedWage === 12345 &&
      !Object.hasOwn(archive[3], "archivedWage"),
    "archive history rates preserved",
  );
  assert(
    exact(base.settings, {
      wage: 15000,
      night: 1.5,
      custom: { preserve: true },
    }),
    "pure plan does not mutate input",
  );
  assertPayChangesOnly(base, plan.after, namedTargets);
  assert(
    exact([
      ...validateStaffPayNames(
        parseStaffPayNames(JSON.stringify(namedTargets)),
      ),
    ], namedTargets),
    "private runtime JSON targets accepted",
  );
  for (
    const invalid of [
      undefined,
      [],
      ["가상대상A", "가상대상B"],
      ["가상대상A", "가상대상A", "가상대상C"],
      ["가상대상A", " ", "가상대상C"],
      [1, "가상대상B", "가상대상C"],
    ]
  ) {
    await rejects(
      () => planStaffPay(base, invalid),
      "missing or invalid runtime targets fail closed",
    );
  }
  let invalidJsonMessage = "";
  try {
    parseStaffPayNames('["가상비공개대상"');
  } catch (error) {
    invalidJsonMessage = error instanceof Error ? error.message : "";
  }
  assert(
    invalidJsonMessage.length > 0 &&
      !invalidJsonMessage.includes("가상비공개대상"),
    "JSON parse diagnostic never quotes private target values",
  );
  const alternativeNames = ["가상대상A", "Other", "Zero"];
  const alternative = planStaffPay(base, alternativeNames);
  const alternateStaff = members(alternative.after, "staff");
  assert(
    alternative.report.namedWageChanges === 2 &&
      alternateStaff[3].wage === 20000 && alternateStaff[4].wage === 20000 &&
      alternateStaff[1].wage === 19000,
    "caller-selected targets, not hardcoded identities, receive overrides",
  );
  assertPayChangesOnly(base, alternative.after, alternativeNames);
  await rejects(
    () =>
      assertPayChangesOnly(base, { ...plan.after, roster: {} }, namedTargets),
    "roster mutation negative control",
  );
  const wrongRate = structuredClone(plan.after);
  members(wrongRate, "staff")[3].wage = 1;
  await rejects(
    () => assertPayChangesOnly(base, wrongRate, namedTargets),
    "unapproved personal rate negative control",
  );
  const userConfig = structuredClone(plan.after);
  settings(userConfig).staffRoles = ["청소"];
  settings(userConfig).roleWages = { 청소: 9900 };
  members(userConfig, "staff")[1].wage = 19500;
  assert(
    exact(planStaffPay(userConfig).after, userConfig),
    "already initialized does not restore deleted roles or reset personal rates",
  );
  const missing = structuredClone(base);
  members(missing, "staff").splice(0, 1);
  await rejects(
    () => planStaffPay(missing, namedTargets),
    "missing named target fails closed",
  );
  const duplicate = structuredClone(base);
  members(duplicate, "staff").push({
    id: "duplicate-name",
    name: "가상대상A",
    wage: null,
  });
  await rejects(
    () => planStaffPay(duplicate, namedTargets),
    "ambiguous named target fails closed",
  );
  const archiveNames = structuredClone(base);
  members(archiveNames, "staffArchive").push({
    id: "old-named-rate",
    name: "가상대상A",
    role: "총괄",
    wage: 17000,
    archivedWage: 16500,
  });
  members(archiveNames, "staffArchive").push({
    id: "old-named-null",
    name: "가상대상B",
    role: "참모",
    wage: null,
  });
  const archivePlan = planStaffPay(archiveNames, namedTargets),
    oldNames = members(archivePlan.after, "staffArchive").slice(-2);
  assert(
    oldNames[0].wage === 17000 && oldNames[0].archivedWage === 16500 &&
      oldNames[1].wage === null && oldNames[1].archivedWage === 15000,
    "named override is active-only, archived same names retain historical rates",
  );
  const wrongArchiveRate = structuredClone(archivePlan.after);
  members(wrongArchiveRate, "staffArchive").at(-2)!.wage = 20000;
  await rejects(
    () => assertPayChangesOnly(archiveNames, wrongArchiveRate, namedTargets),
    "named archived rate mutation negative control",
  );

  const password = "offline-pay-test-only",
    encrypted = async (
      state: State,
      at = "2026-10-06T01:00:00Z",
    ): Promise<CloudRow> => ({
      id: "namofood",
      data: await encryptText(password, JSON.stringify(state)),
      updated_at: at,
    });
  let current = await encrypted(base),
    writes = 0,
    backups = 0,
    failBackup = false,
    conflict: "edit" | "initialized" | null = null,
    sequence = 0;
  const backupIds = new Set<string>();
  const storage: Storage = {
    readCurrent: async () => current,
    async createBackup(row) {
      backups++;
      if (failBackup) throw new Error("Isolated backup failure");
      assert(
        row.data === current.data && !backupIds.has(row.id),
        "unique exact encrypted before snapshot",
      );
      backupIds.add(row.id);
      await decode(password, row);
      return row;
    },
    async compareAndSwap(before, after) {
      writes++;
      if (conflict) {
        const kind = conflict;
        conflict = null;
        const remote = kind === "initialized"
          ? structuredClone(userConfig)
          : await decode(password, current);
        if (kind === "edit") {
          settings(remote).wage = 16000;
          settings(remote).custom = { concurrent: true };
          members(remote, "staff")[3].wage = 18000;
          remote.menus = { concurrent: true };
        }
        current = await encrypted(remote, "2026-10-06T02:00:00Z");
        return null;
      }
      assert(
        before.updated_at === current.updated_at,
        "CAS exact latest timestamp",
      );
      current = after;
      return after;
    },
  };
  const options = {
    password,
    namedTargets,
    storage,
    now: () => "2026-10-06T03:00:00Z",
    uuid: () => `test-${++sequence}`,
  };
  const dry = await applyStaffPay({ ...options, apply: false });
  assert(
    dry.dry && !dry.saved && writes === 0 && backups === 0,
    "default dry writes nothing",
  );
  await rejects(
    () => applyStaffPay({ ...options, namedTargets: undefined, apply: true }),
    "uninitialized missing runtime targets abort before any backup/write",
  );
  assert(
    writes === 0 && backups === 0,
    "missing private target input causes zero writes",
  );
  failBackup = true;
  await rejects(
    () => applyStaffPay({ ...options, apply: true }),
    "backup failure aborts apply",
  );
  assert(writes === 0, "backup failure prevents CAS");
  failBackup = false;
  const applied = await applyStaffPay({ ...options, apply: true });
  assert(
    applied.saved && applied.readBackVerified && writes === 1,
    "encrypted save and exact fresh readback",
  );
  assertPayChangesOnly(base, await decode(password, current), namedTargets);
  const again = await applyStaffPay({ ...options, apply: true });
  assert(!again.saved && writes === 1, "second apply idempotent");
  const initializedWithoutNames = await applyStaffPay({
    ...options,
    namedTargets: undefined,
    apply: true,
  });
  assert(
    !initializedWithoutNames.saved && writes === 1,
    "initialized state allows missing private names without reinitializing",
  );
  current = await encrypted(base);
  conflict = "edit";
  const raced = await applyStaffPay({ ...options, apply: true }),
    fresh = await decode(password, current);
  assert(
    raced.saved && raced.attempt === 2 &&
      members(fresh, "staff")[3].wage === 18000 &&
      exact(fresh.menus, { concurrent: true }),
    "fresh retry preserves concurrent personal and menu edits",
  );
  assert(
    members(fresh, "staffArchive")[0].archivedWage === 16000 &&
      settings(fresh).wage === 16000,
    "archive freezes fresh global rate without changing it",
  );
  current = await encrypted(base);
  conflict = "initialized";
  const alreadyRaced = await applyStaffPay({ ...options, apply: true });
  assert(
    !alreadyRaced.saved && alreadyRaced.attempt === 2 &&
      exact(await decode(password, current), userConfig),
    "concurrent initialization retains role CRUD and custom rates",
  );
  current = await encrypted(base);
  const writesBefore = writes;
  await rejects(
    () =>
      applyStaffPay({
        ...options,
        apply: true,
        storage: {
          ...storage,
          compareAndSwap: async () => {
            writes++;
            return null;
          },
        },
      }),
    "three conflict cap",
  );
  assert(
    writes - writesBefore === 3 && exact(await decode(password, current), base),
    "no overwrite after three CAS conflicts",
  );
  const unconfirmed = writes;
  await rejects(
    () =>
      applyStaffPay({
        ...options,
        apply: true,
        storage: {
          ...storage,
          createBackup: async (row) => ({ ...row, data: "unconfirmed" }),
        },
      }),
    "unconfirmed backup aborts",
  );
  assert(writes === unconfirmed, "unconfirmed snapshot prevents write");
  console.log(
    JSON.stringify({
      selfTest: "STAFF_PAY_SETTINGS_OK",
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
        "Use no flags for dry, --apply for reviewed write, or --self-test",
      );
    }
    if (Deno.args.includes("--self-test")) await selfTest();
    else {
      const password = Deno.env.get("NMF_PW");
      if (!password) throw new Error("NMF_PW required; no password fallback");
      const namedTargets = parseStaffPayNames(
        Deno.env.get("NMF_STAFF_PAY_NAMES"),
      );
      console.log(
        JSON.stringify(
          await applyStaffPay({
            password,
            namedTargets,
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
        error: error instanceof Error
          ? error.message
          : "Initialization stopped",
      }),
    );
    Deno.exit(1);
  }
}
