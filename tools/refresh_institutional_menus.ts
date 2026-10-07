// Reviewed institutional catalog + future AI refresh. Dry unless --apply.
// Required: NMF_PW and --today YYYY-MM-DD. No password-file fallback.
import {
  dateCell,
  decryptText,
  encryptText,
  type MenuPlan,
  type PlanMeal,
  SLOT_INDICES,
  type State,
  validateMenuVariety,
} from "../supabase/functions/nmf-menu-plan/lib.ts";
import {
  canonicalDish,
  mainProfileKey,
} from "../supabase/functions/_shared/institutional-menu.ts";
import {
  createPremiumDishProfiler,
  MANUAL_FAMILIAR_DISHES,
  type ManualRecipeState,
  MENU_MANUAL_VERSION,
  menuManualViolations,
} from "../supabase/functions/_shared/menu-manual.ts";
import {
  mergeRecipes,
  type Recipe,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";

export const REFRESH_MODEL = "codex-institutional-curation-v2";
export const RECOVERY_RUN_ID = "5b93526c-f0c9-4f5f-aa6d-cc8d10a02921";
export const RECOVERY_BACKUP_ID =
  `namofood@before-menu-recovery-2026-10-16-${RECOVERY_RUN_ID}`;
export type CatalogEntry = {
  recipe: Recipe;
  role: "main" | "soup" | "side" | "kimchi";
  method: string;
  protein: string;
  seasoning: string;
};
export type OwnershipProofs = { runAdded: Record<string, string[]> };
export type RefreshOptions = {
  today: string;
  updated: string;
  runId: string;
  force?: boolean;
  /** Explicit opt-in: repair only manual-policy violations, including today. */
  manualPolicy?: boolean;
  maxSearch?: number;
};
export type RefreshPlan = {
  after: State;
  plan: MenuPlan;
  ownedCells: string[];
  changedCells: string[];
  refreshedMeals: string[];
  skippedMeals: Array<{ meal: string; reason: string }>;
  catalogAdded: string[];
  catalogSkipped: string[];
  protectedChanged: string[];
  generatedOwnership: OwnershipProofs;
  missingNewRecipes: string[];
};
export type CloudRow = { id: string; data: string; updated_at: string };
export type RefreshStorage = {
  readCurrent(): Promise<CloudRow>;
  readBackup(id: string): Promise<CloudRow | undefined>;
  readRunAdded(runIds: string[]): Promise<OwnershipProofs>;
  createBackup(row: CloudRow): Promise<CloudRow>;
  compareAndSwap(
    before: CloudRow,
    after: CloudRow,
  ): Promise<CloudRow | undefined>;
};
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const filled = (v: unknown) =>
  v !== undefined && v !== null && String(v).trim() !== "";
function validDate(date: string) {
  dateCell(date);
}
function cellValue(state: State, fullKey: string): unknown {
  const [date, meal, slot] = fullKey.split("|");
  const { ym, day } = dateCell(date);
  return state.menus?.[ym]?.[`${day}|${meal}|${slot}`];
}
function setCell(state: State, fullKey: string, value: unknown) {
  const [date, meal, slot] = fullKey.split("|");
  const { ym, day } = dateCell(date);
  state.menus ||= {};
  const month = state.menus[ym] ||= {};
  if (value === undefined) delete month[`${day}|${meal}|${slot}`];
  else month[`${day}|${meal}|${slot}`] = value;
}
function allMenuCells(state: State): Map<string, unknown> {
  const cells = new Map<string, unknown>();
  for (const [ym, month] of Object.entries(state.menus || {})) {
    for (const [key, value] of Object.entries(month)) {
      const [day, meal, slot] = key.split("|");
      const date = `${ym}-${String(Number(day)).padStart(2, "0")}`;
      try {
        validDate(date);
      } catch {
        continue;
      }
      cells.set(`${date}|${meal}|${slot}`, value);
    }
  }
  return cells;
}

export function validateOwnershipProofs(value: unknown): OwnershipProofs {
  const p = value as OwnershipProofs;
  if (
    !p || typeof p !== "object" || !p.runAdded ||
    typeof p.runAdded !== "object" || Array.isArray(p.runAdded)
  ) throw new Error("Ownership file must contain runAdded object");
  for (const [runId, cells] of Object.entries(p.runAdded)) {
    if (
      !runId || !Array.isArray(cells) ||
      cells.some((key) =>
        typeof key !== "string" ||
        !/^\d{4}-\d{2}-\d{2}\|[^|]+\|(?:\d+|n)$/.test(key)
      )
    ) {
      throw new Error(
        "Invalid ownership cell keys; no inferred ownership allowed",
      );
    }
  }
  return { runAdded: structuredClone(p.runAdded) };
}

/** Only values inserted into formerly empty cells belong to retained recovery. */
export function deriveRecoveryOwnedCells(
  before: State,
  current: State,
  runId = RECOVERY_RUN_ID,
): string[] {
  return [...allMenuCells(current)].filter(([key, value]) => {
    const [date, meal, slot] = key.split("|");
    return /^\d+$/.test(slot) && Number(slot) > 0 && filled(value) &&
      current.menuPlanMeta?.[`${date}|${meal}`]?.runId === runId &&
      current.menuPlanMeta?.[`${date}|${meal}`]?.by === "ai" &&
      !filled(cellValue(before, key));
  }).map(([key]) => key).sort();
}

/** Existing recipe rows/maps retain exact content; only genuinely new names append. */
function appendCatalog(
  before: State,
  after: State,
  bank: readonly CatalogEntry[],
  today: string,
) {
  const recipes = before.recipes === undefined ? [] : before.recipes;
  if (!Array.isArray(recipes)) {
    throw new Error("Existing recipe collection is invalid");
  }
  const names = new Map<string, string>();
  for (const row of recipes) {
    if (row && typeof row === "object" && typeof row.menu === "string") {
      names.set(canonicalDish(row.menu), row.menu);
    }
  }
  for (const field of ["methods", "sources", "recipeMeta", "recipeAsk"]) {
    for (const name of Object.keys((before[field] || {}) as object)) {
      if (!names.has(canonicalDish(name))) names.set(canonicalDish(name), name);
    }
  }
  const additions: Recipe[] = [], skipped: string[] = [];
  for (const entry of bank) {
    const name = entry.recipe?.menu;
    if (!name || !["main", "soup", "side", "kimchi"].includes(entry.role)) {
      throw new Error("Catalog entry lacks menu/role");
    }
    const canonical = canonicalDish(name);
    if (names.has(canonical)) {
      skipped.push(name);
      continue;
    }
    names.set(canonical, name);
    additions.push(structuredClone(entry.recipe));
  }
  if (additions.length) {
    after.recipes ||= [];
    const merged = mergeRecipes(after, additions, today);
    if (merged.added.length !== additions.length) {
      throw new Error(
        `Catalog recipe validation failed: ${merged.skipped.join("; ")}`,
      );
    }
  }
  return { added: additions.map((recipe) => recipe.menu), skipped, names };
}

export function assertRefreshProtected(
  before: State,
  after: State,
  allowedCells: Set<string>,
  targets: Set<string>,
  appendedNames: Set<string>,
) {
  const violations: string[] = [];
  const bCells = allMenuCells(before), aCells = allMenuCells(after);
  for (const key of new Set([...bCells.keys(), ...aCells.keys()])) {
    if (!allowedCells.has(key) && !equal(bCells.get(key), aCells.get(key))) {
      violations.push(`menu:${key}`);
    }
    if (/\|(0|n)$/.test(key) && !equal(bCells.get(key), aCells.get(key))) {
      violations.push(`protected:${key}`);
    }
  }
  for (
    const key of new Set([
      ...Object.keys(before.menuPlanMeta || {}),
      ...Object.keys(after.menuPlanMeta || {}),
    ])
  ) {
    if (
      !targets.has(key) &&
      !equal(before.menuPlanMeta?.[key], after.menuPlanMeta?.[key])
    ) violations.push(`meta:${key}`);
  }
  const bRecipes = (before.recipes || []) as unknown[],
    aRecipes = (after.recipes || []) as unknown[];
  if (
    aRecipes.length < bRecipes.length ||
    !equal(aRecipes.slice(0, bRecipes.length), bRecipes)
  ) violations.push("existing recipe rows");
  for (
    const row of aRecipes.slice(bRecipes.length) as Array<{ menu?: string }>
  ) {
    if (!row.menu || !appendedNames.has(row.menu)) {
      violations.push(
        "unapproved recipe append",
      );
    }
  }
  for (const field of ["methods", "sources", "recipeMeta", "recipeAsk"]) {
    const old = (before[field] || {}) as Record<string, unknown>,
      next = (after[field] || {}) as Record<string, unknown>;
    for (const name of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (
        (Object.hasOwn(old, name) || !appendedNames.has(name)) &&
        !equal(old[name], next[name])
      ) violations.push(`${field}:${name}`);
    }
  }
  const mutable = new Set([
    "menus",
    "menuPlanMeta",
    "recipes",
    "methods",
    "sources",
    "recipeMeta",
    "recipeAsk",
    "updatedAt",
  ]);
  for (
    const field of new Set([...Object.keys(before), ...Object.keys(after)])
  ) {
    if (!mutable.has(field) && !equal(before[field], after[field])) {
      violations
        .push(`state:${field}`);
    }
  }
  if (violations.length) {
    throw new Error(
      `Protected data changed: ${violations.slice(0, 12).join(", ")}`,
    );
  }
  return violations;
}

function hash(value: string): number {
  let n = 2166136261;
  for (const ch of value) n = Math.imul(n ^ ch.charCodeAt(0), 16777619) >>> 0;
  return n;
}

function knownNonAnimalMain(protein: string): boolean {
  return [
    "egg",
    "tofu",
    "tofu-egg",
    "vegetable",
    "veg",
    "bean",
    "plant",
    "계란",
    "달걀",
    "두부",
    "채소",
    "야채",
    "버섯",
  ].includes(protein.toLowerCase().trim());
}

function mealContents(state: State, mealKey: string) {
  const cells = [...allMenuCells(state)].filter(([key, value]) =>
    key.startsWith(`${mealKey}|`) && filled(value) &&
    /^\d+$/.test(key.split("|")[2]) && Number(key.split("|")[2]) > 0
  );
  const slots = Object.fromEntries(
    cells.filter(([key]) =>
      (SLOT_INDICES as readonly string[]).includes(key.split("|")[2])
    ).map((
      [key, value],
    ) => [key.split("|")[2], String(value)]),
  );
  const extras = cells.filter(([key]) =>
    !(SLOT_INDICES as readonly string[]).includes(key.split("|")[2])
  ).map(([, value]) => String(value));
  return { slots, extras };
}

function manualRecipeState(state: State): ManualRecipeState {
  return {
    recipes: state.recipes,
    methods: state.methods,
    recipeAsk: state.recipeAsk,
  };
}

/** Variety validation mutates no recipe maps; clone only the food cells we stage. */
function clonedMenuContext(state: State): State {
  return { ...state, menus: structuredClone(state.menus) };
}

function completeRecipeNames(state: State): Set<string> {
  const names = new Set<string>();
  for (const row of (state.recipes || []) as Array<Record<string, unknown>>) {
    if (
      typeof row.menu === "string" && typeof row.item === "string" &&
      row.item.trim() && row.item.trim() !== "물" && Number(row.qty) > 0 &&
      typeof (state.methods as Record<string, unknown> | undefined)
          ?.[row.menu] === "string" &&
      filled((state.methods as Record<string, unknown>)[row.menu]) &&
      !Object.hasOwn((state.recipeAsk || {}) as object, row.menu)
    ) names.add(row.menu);
  }
  return names;
}

/** Minimal repair: retain valid old dishes and add the missing protein upgrade. */
function planManualPolicyRefresh(
  before: State,
  bank: readonly CatalogEntry[],
  ownership: OwnershipProofs,
  options: RefreshOptions,
): RefreshPlan {
  const after = structuredClone(before),
    validationBase = clonedMenuContext(before);
  const recipeState = manualRecipeState(before);
  const complete = completeRecipeNames(before);
  const premium = createPremiumDishProfiler(recipeState);
  const bankProfiles = new Map(
    bank.map((entry) => [canonicalDish(entry.recipe.menu), entry]),
  );
  const familiar = new Set(MANUAL_FAMILIAR_DISHES.map(canonicalDish));
  const useCounts = new Map<string, number>();
  for (const [, value] of allMenuCells(before)) {
    if (typeof value !== "string") continue;
    const name = canonicalDish(value);
    useCounts.set(name, (useCounts.get(name) || 0) + 1);
  }
  // Saved legacy recipes may themselves be erroneous AI drafts. Composition
  // comes only from the reviewed main-dish catalog and confirmed human-edited
  // examples; recipe readiness is necessary, but is not a source endorsement.
  const approved = new Set([
    ...bank.filter((entry) => entry.role === "main").map((entry) =>
      canonicalDish(entry.recipe.menu)
    ),
    ...familiar,
  ]);
  const candidates = [...complete].filter((name) =>
    approved.has(canonicalDish(name)) && premium(name).substantial
  );
  const profileKey = (name: string): string | undefined => {
    const known = mainProfileKey(name);
    if (known) return known;
    const profile = premium(name);
    if (
      profile.substantial && profile.protein && profile.method &&
      profile.seasoning
    ) {
      return `${profile.protein}|${profile.method}|${profile.seasoning}`;
    }
    const entry = bankProfiles.get(canonicalDish(name));
    return entry?.role === "main"
      ? `${entry.protein}|${entry.method}|${entry.seasoning}`
      : undefined;
  };
  const owned = new Set<string>(), allowed = new Set<string>();
  const targets: string[] = [], skippedMeals: RefreshPlan["skippedMeals"] = [];
  for (
    const [mealKey, meta] of Object.entries(before.menuPlanMeta || {}).sort((
      [a],
      [b],
    ) => a.localeCompare(b))
  ) {
    const [date] = mealKey.split("|");
    validDate(date);
    if (date < options.today || meta.by !== "ai") continue;
    const contents = mealContents(before, mealKey);
    if (
      !menuManualViolations(
        contents.slots,
        contents.extras,
        recipeState,
        premium,
      ).length
    ) {
      skippedMeals.push({ meal: mealKey, reason: "manual policy compliant" });
      continue;
    }
    const keys = (ownership.runAdded[meta.runId] || []).filter((key) =>
      key.startsWith(`${mealKey}|`) && /^\d+$/.test(key.split("|")[2]) &&
      Number(key.split("|")[2]) > 0 && filled(cellValue(before, key))
    );
    if (!keys.length) {
      throw new Error(
        `Missing verified AI ownership for ${mealKey}; provide an audited --ownership-file`,
      );
    }
    targets.push(mealKey);
    for (const key of keys) {
      owned.add(key);
      allowed.add(key);
    }
  }
  const plan: MenuPlan = { days: [] };
  const byDay = new Map<string, MenuPlan["days"][number]>();
  let attempts = 0;
  for (const mealKey of targets) {
    const [date, meal] = mealKey.split("|");
    const contents = mealContents(after, mealKey);
    const slots = { ...contents.slots }, extras = [...contents.extras];
    const current: PlanMeal = { meal, slots, extras };
    const currentPlan: MenuPlan = { days: [{ date, meals: [current] }] };
    const context = clonedMenuContext(after);
    const replacements: string[] = [];
    for (const slot of ["2", "7"]) {
      if (slots[slot] && premium(slots[slot]).substantial) {
        continue;
      }
      const key = `${mealKey}|${slot}`;
      if (filled(slots[slot]) && !owned.has(key)) {
        throw new Error(
          `Manual main prevents policy repair at ${key}; manual cells were not changed`,
        );
      }
      replacements.push(slot);
    }
    if (
      !replacements.length &&
      ![slots["2"], slots["7"]].some((name) => premium(name).anchor)
    ) {
      const replaceable = ["7", "2"].find((slot) =>
        owned.has(`${mealKey}|${slot}`)
      );
      if (!replaceable) {
        throw new Error(
          `Manual anchors prevent policy repair at ${mealKey}; manual cells were not changed`,
        );
      }
      replacements.push(replaceable);
    }
    for (const slot of replacements) {
      delete slots[slot];
      setCell(context, `${mealKey}|${slot}`, undefined);
    }
    const changedSlots: Record<string, string> = {};
    const preservedContextCells = [...allMenuCells(context)];
    const nearbyDishes = new Set(
      preservedContextCells.filter(([key, value]) =>
        typeof value === "string" && /^\d+$/.test(key.split("|")[2]) &&
        Number(key.split("|")[2]) > 0 &&
        Math.abs(Date.parse(key.split("|")[0]) - Date.parse(date)) <=
          7 * 86400000
      ).map(([, value]) => canonicalDish(String(value))),
    );
    const sameDayProfileAllowed = (name: string): boolean => {
      const key = profileKey(name);
      if (!key) return true;
      const peers = preservedContextCells.filter(([cell, value]) =>
        cell.split("|")[0] === date && typeof value === "string" &&
        premium(value).substantial &&
        profileKey(value) === key
      );
      const staged = [
        ...Object.values(changedSlots),
        ...extras.filter((dish) => !contents.extras.includes(dish)),
      ];
      const matching = staged.filter((dish) => profileKey(dish) === key).length;
      return !peers.some(([cell]) => cell.startsWith(`${mealKey}|`)) &&
        !matching && peers.length + matching < 2;
    };
    const choices = (task: string) =>
      [...candidates].sort((a, b) => {
        const pa = premium(a),
          pb = premium(b);
        return Number(pb.anchor) - Number(pa.anchor) ||
          Number(familiar.has(canonicalDish(b))) -
            Number(familiar.has(canonicalDish(a))) ||
          (useCounts.get(canonicalDish(a)) || 0) -
            (useCounts.get(canonicalDish(b)) || 0) ||
          hash(`${mealKey}|${task}|${a}`) - hash(`${mealKey}|${task}|${b}`);
      });
    const validCandidate = (name: string): boolean => {
      if (++attempts > (options.maxSearch ?? 40000)) {
        throw new Error(
          `Bounded manual-policy repair exhausted at ${mealKey}; no state changed`,
        );
      }
      if (
        nearbyDishes.has(canonicalDish(name)) ||
        [...Object.values(slots), ...extras].some((dish) =>
          canonicalDish(dish) === canonicalDish(name)
        )
      ) return false;
      return sameDayProfileAllowed(name);
    };
    const search = (position: number): boolean => {
      if (position < replacements.length) {
        const slot = replacements[position];
        for (const name of choices(slot)) {
          if (!validCandidate(name)) continue;
          // A newly repaired primary dish should provide the real animal-protein
          // anchor when the other preserved main does not do so already.
          if (
            ![slots["2"], slots["7"]].filter(Boolean).some((dish) =>
              premium(dish).anchor
            ) && !premium(name).anchor
          ) continue;
          slots[slot] = name;
          changedSlots[slot] = name;
          try {
            validateMenuVariety(context, currentPlan);
            if (search(position + 1)) return true;
          } catch (error) {
            if (String(error).includes("Bounded manual-policy")) throw error;
          }
          delete slots[slot];
          delete changedSlots[slot];
        }
        return false;
      }
      if (!menuManualViolations(slots, extras, recipeState, premium).length) {
        try {
          validateMenuVariety(context, currentPlan);
          return true;
        } catch {
          return false;
        }
      }
      for (const name of choices("upgrade")) {
        if (!validCandidate(name)) continue;
        extras.push(name);
        try {
          if (
            !menuManualViolations(slots, extras, recipeState, premium).length
          ) {
            validateMenuVariety(context, currentPlan);
            return true;
          }
        } catch {
          /* Try the next actual registered main; keep preserved dishes. */
        }
        extras.pop();
      }
      return false;
    };
    if (!search(0)) {
      throw new Error(
        `No valid manual-policy repair for ${mealKey}; fixed cells kept intact`,
      );
    }
    for (const [slot, name] of Object.entries(changedSlots)) {
      const key = `${mealKey}|${slot}`;
      setCell(after, key, name);
      setCell(validationBase, key, undefined);
      allowed.add(key);
    }
    for (
      const name of extras.filter((dish) => !contents.extras.includes(dish))
    ) {
      let slot = 10;
      while (filled(cellValue(after, `${mealKey}|${slot}`))) slot++;
      const key = `${mealKey}|${slot}`;
      setCell(after, key, name);
      allowed.add(key);
      const canonical = canonicalDish(name);
      useCounts.set(canonical, (useCounts.get(canonical) || 0) + 1);
    }
    for (const name of Object.values(changedSlots)) {
      const canonical = canonicalDish(name);
      useCounts.set(canonical, (useCounts.get(canonical) || 0) + 1);
    }
    after.menuPlanMeta ||= {};
    after.menuPlanMeta[mealKey] = {
      by: "ai",
      updated: options.updated,
      model: MENU_MANUAL_VERSION,
      runId: options.runId,
    };
    const day = byDay.get(date) || { date, meals: [] };
    if (!byDay.has(date)) {
      byDay.set(date, day);
      plan.days.push(day);
    }
    day.meals.push(current);
  }
  validateMenuVariety(validationBase, plan);
  for (const mealKey of targets) {
    const contents = mealContents(after, mealKey);
    const errors = menuManualViolations(
      contents.slots,
      contents.extras,
      recipeState,
      premium,
    );
    if (errors.length) {
      throw new Error(
        `Manual-policy postcheck failed ${mealKey}: ${errors.join("; ")}`,
      );
    }
  }
  const protectedChanged = assertRefreshProtected(
    before,
    after,
    allowed,
    new Set(targets),
    new Set(),
  );
  const bCells = allMenuCells(before), aCells = allMenuCells(after);
  const changedCells = [...new Set([...bCells.keys(), ...aCells.keys()])]
    .filter((key) => !equal(bCells.get(key), aCells.get(key))).sort();
  const missingNewRecipes = [
    ...new Set(changedCells.map((key) => String(aCells.get(key)))),
  ]
    .filter((name) => !complete.has(name));
  if (missingNewRecipes.length) {
    throw new Error(
      `New menu recipe coverage failed: ${missingNewRecipes.join(", ")}`,
    );
  }
  if (changedCells.length) after.updatedAt = options.updated;
  return {
    after,
    plan,
    ownedCells: [...owned].sort(),
    changedCells,
    refreshedMeals: targets,
    skippedMeals,
    catalogAdded: [],
    catalogSkipped: [],
    protectedChanged,
    generatedOwnership: {
      runAdded: {
        [options.runId]: [...allowed].filter((key) =>
          filled(cellValue(after, key))
        ).sort(),
      },
    },
    missingNewRecipes,
  };
}

/** Pure planner: caller supplies audited ownership and an injectable dish bank. */
export function planInstitutionalRefresh(
  before: State,
  bank: readonly CatalogEntry[],
  ownership: OwnershipProofs,
  options: RefreshOptions,
): RefreshPlan {
  validDate(options.today);
  if (!options.runId || !Number.isFinite(Date.parse(options.updated))) {
    throw new Error("Refresh run/time are required");
  }
  validateOwnershipProofs(ownership);
  if (options.manualPolicy) {
    return planManualPolicyRefresh(before, bank, ownership, options);
  }
  const base = structuredClone(before), after = structuredClone(before);
  const catalog = appendCatalog(before, after, bank, options.today);
  // Newly appended, validated recipes are part of this refresh's prospective
  // state, so unfamiliar protein dishes receive the same variety classification
  // as recipes that were registered before the refresh.
  for (const field of ["recipes", "methods", "recipeAsk"]) {
    if (Object.hasOwn(after, field)) base[field] = after[field];
  }
  const completeRecipes = new Set<string>();
  for (
    const row of (after.recipes || []) as Array<
      { menu?: unknown; item?: unknown; qty?: unknown }
    >
  ) {
    if (
      typeof row.menu === "string" && typeof row.item === "string" &&
      row.item.trim() && row.item.trim() !== "물" && Number(row.qty) > 0 &&
      typeof (after.methods as Record<string, unknown> | undefined)
          ?.[row.menu] === "string" &&
      filled((after.methods as Record<string, unknown>)[row.menu])
    ) completeRecipes.add(row.menu);
  }
  const effectiveBank = bank.map((entry) => ({
    ...entry,
    recipe: {
      ...entry.recipe,
      menu: catalog.names.get(canonicalDish(entry.recipe.menu)) ||
        entry.recipe.menu,
    },
  })).filter((entry) => completeRecipes.has(entry.recipe.menu));
  const owned = new Set<string>(),
    targets: string[] = [],
    skippedMeals: RefreshPlan["skippedMeals"] = [];
  for (
    const [mealKey, meta] of Object.entries(before.menuPlanMeta || {}).sort((
      [a],
      [b],
    ) => a.localeCompare(b))
  ) {
    const [date, meal] = mealKey.split("|");
    validDate(date);
    if (date <= options.today || meta.by !== "ai") continue;
    if (!options.force && meta.model === REFRESH_MODEL) {
      skippedMeals.push({ meal: mealKey, reason: "already refreshed" });
      continue;
    }
    const keys = (ownership.runAdded[meta.runId] || []).filter((key) =>
      key.startsWith(`${mealKey}|`) && /^\d+$/.test(key.split("|")[2]) &&
      Number(key.split("|")[2]) > 0 && filled(cellValue(before, key))
    );
    if (!keys.length) {
      throw new Error(
        `Missing verified AI ownership for ${mealKey}; provide an audited --ownership-file`,
      );
    }
    targets.push(mealKey);
    for (const key of keys) {
      owned.add(key);
      setCell(base, key, undefined);
      setCell(after, key, undefined);
    }
  }
  const plan: MenuPlan = { days: [] }, allowed = new Set(owned);
  const generationContext = structuredClone(base);
  const useCounts = new Map<string, number>();
  for (const [, value] of allMenuCells(before)) {
    if (typeof value === "string") {
      const key = canonicalDish(value);
      useCounts.set(key, (useCounts.get(key) || 0) + 1);
    }
  }
  const byDay = new Map<string, MenuPlan["days"][number]>();
  let attempts = 0;
  const maxSearch = options.maxSearch ?? 40000;
  const roles: Record<string, CatalogEntry["role"]> = {
    "1": "soup",
    "2": "main",
    "7": "main",
    "3": "side",
    "4": "side",
    "8": "kimchi",
  };
  for (const mealKey of targets) {
    const [date, meal] = mealKey.split("|");
    const slots: Record<string, string> = {};
    for (const slot of SLOT_INDICES) {
      if (filled(cellValue(base, `${mealKey}|${slot}`))) {
        slots[slot] = String(cellValue(base, `${mealKey}|${slot}`));
      }
    }
    const chosen: Record<string, CatalogEntry> = {};
    const missing = SLOT_INDICES.filter((slot) => !slots[slot]);
    const current: PlanMeal = { meal, slots, extras: [] };
    const day = byDay.get(date) || { date, meals: [] };
    if (!byDay.has(date)) {
      byDay.set(date, day);
      plan.days.push(day);
    }
    day.meals.push(current);
    const currentPlan: MenuPlan = { days: [{ date, meals: [current] }] };
    const search = (position: number): boolean => {
      if (position === missing.length) {
        try {
          validateMenuVariety(generationContext, currentPlan);
          return true;
        } catch {
          return false;
        }
      }
      const slot = missing[position], role = roles[slot];
      const choices = effectiveBank.filter((entry) => entry.role === role).sort(
        (a, b) =>
          (useCounts.get(canonicalDish(a.recipe.menu)) || 0) -
            (useCounts.get(canonicalDish(b.recipe.menu)) || 0) ||
          hash(`${mealKey}|${slot}|${a.recipe.menu}`) -
            hash(`${mealKey}|${slot}|${b.recipe.menu}`),
      );
      for (const entry of choices) {
        if (++attempts > maxSearch) {
          throw new Error(
            `Bounded menu search exhausted at ${mealKey}; enlarge the bank or review fixed constraints`,
          );
        }
        const name = entry.recipe.menu;
        if (
          Object.values(slots).some((dish) =>
            canonicalDish(dish) === canonicalDish(name)
          )
        ) continue;
        if (role === "main") {
          if (
            missing.includes("2") && missing.includes("7") &&
            knownNonAnimalMain(entry.protein) &&
            Object.values(chosen).some((other) =>
              other.role === "main" && knownNonAnimalMain(other.protein)
            )
          ) continue;
          const profile = `${entry.protein}|${entry.method}|${entry.seasoning}`;
          // Only inspect staged meals on this date; future/past profile reuse is allowed.
          const todayPeers = day.meals.flatMap((
            item,
          ) => [item.slots["2"], item.slots["7"]]).filter(Boolean).map((dish) =>
            effectiveBank.find((e) =>
              canonicalDish(e.recipe.menu) === canonicalDish(dish)
            )
          ).filter((e) =>
            e && `${e.protein}|${e.method}|${e.seasoning}` === profile
          );
          const sameMealProfile = [slots["2"], slots["7"]].filter(Boolean)
            .map((dish) =>
              effectiveBank.find((e) =>
                canonicalDish(e.recipe.menu) === canonicalDish(dish)
              )
            )
            .some((e) =>
              e && `${e.protein}|${e.method}|${e.seasoning}` === profile
            );
          if (
            todayPeers.length >= 2 || sameMealProfile ||
            Object.values(chosen).some((e) =>
              e.role === "main" &&
              `${e.protein}|${e.method}|${e.seasoning}` === profile
            )
          ) continue;
        }
        slots[slot] = name;
        chosen[slot] = entry;
        try {
          validateMenuVariety(generationContext, currentPlan);
        } catch {
          delete slots[slot];
          delete chosen[slot];
          continue;
        }
        if (search(position + 1)) return true;
        delete slots[slot];
        delete chosen[slot];
      }
      return false;
    };
    if (!search(0)) {
      throw new Error(
        `No valid full institutional meal for ${mealKey}; fixed cells kept intact`,
      );
    }
    const extras = effectiveBank.filter((entry) => entry.role === "side").sort((
      a,
      b,
    ) =>
      (useCounts.get(canonicalDish(a.recipe.menu)) || 0) -
        (useCounts.get(canonicalDish(b.recipe.menu)) || 0) ||
      hash(`${mealKey}|bonus|${a.recipe.menu}`) -
        hash(`${mealKey}|bonus|${b.recipe.menu}`)
    );
    for (const entry of extras) {
      current.extras = [entry.recipe.menu];
      try {
        validateMenuVariety(generationContext, currentPlan);
        break;
      } catch {
        current.extras = [];
      }
    }
    for (const [slot, dish] of Object.entries(slots)) {
      const key = `${mealKey}|${slot}`;
      if (!filled(cellValue(base, key))) {
        setCell(after, key, dish);
        allowed.add(key);
      }
      const canonical = canonicalDish(dish);
      useCounts.set(canonical, (useCounts.get(canonical) || 0) + 1);
    }
    for (const extra of current.extras || []) {
      const existing = [...allMenuCells(after)].filter(([key]) =>
        key.startsWith(`${mealKey}|`)
      );
      if (
        existing.some(([, value]) =>
          typeof value === "string" &&
          canonicalDish(value) === canonicalDish(extra)
        )
      ) continue;
      let slot = 10;
      while (filled(cellValue(after, `${mealKey}|${slot}`))) slot++;
      const key = `${mealKey}|${slot}`;
      setCell(after, key, extra);
      allowed.add(key);
      const canonical = canonicalDish(extra);
      useCounts.set(canonical, (useCounts.get(canonical) || 0) + 1);
    }
    after.menuPlanMeta ||= {};
    after.menuPlanMeta[mealKey] = {
      by: "ai",
      updated: options.updated,
      model: REFRESH_MODEL,
      runId: options.runId,
    };
    for (const [key, value] of allMenuCells(after)) {
      if (key.startsWith(`${mealKey}|`)) setCell(generationContext, key, value);
    }
  }
  validateMenuVariety(base, plan);
  const missingNewRecipes = [
    ...new Set(plan.days.flatMap((day) =>
      day.meals.flatMap((meal) => [
        ...Object.entries(meal.slots).filter(([slot]) =>
          !filled(cellValue(base, `${day.date}|${meal.meal}|${slot}`))
        ).map(([, dish]) => dish),
        ...(meal.extras || []),
      ])
    )),
  ].filter((name) => !completeRecipes.has(name));
  if (missingNewRecipes.length) {
    throw new Error(
      `New menu recipe coverage failed: ${missingNewRecipes.join(", ")}`,
    );
  }
  const protectedChanged = assertRefreshProtected(
    before,
    after,
    allowed,
    new Set(targets),
    new Set(catalog.added),
  );
  const bCells = allMenuCells(before), aCells = allMenuCells(after);
  const changedCells = [...new Set([...bCells.keys(), ...aCells.keys()])]
    .filter((key) => !equal(bCells.get(key), aCells.get(key))).sort();
  if (changedCells.length || catalog.added.length) {
    after.updatedAt = options.updated;
  }
  return {
    after,
    plan,
    ownedCells: [...owned].sort(),
    changedCells,
    refreshedMeals: targets,
    skippedMeals,
    catalogAdded: catalog.added,
    catalogSkipped: catalog.skipped,
    protectedChanged,
    generatedOwnership: {
      runAdded: {
        [options.runId]: [...allowed].filter((key) =>
          /^\d+$/.test(key.split("|")[2]) && Number(key.split("|")[2]) > 0 &&
          filled(cellValue(after, key))
        ).sort(),
      },
    },
    missingNewRecipes,
  };
}

export async function applyInstitutionalRefresh(options: {
  password: string;
  today: string;
  bank: readonly CatalogEntry[];
  ownership?: OwnershipProofs;
  apply?: boolean;
  force?: boolean;
  manualPolicy?: boolean;
  storage: RefreshStorage;
  now?: () => string;
  uuid?: () => string;
}) {
  if (!options.password) throw new Error("NMF_PW required");
  validDate(options.today);
  const now = options.now || (() => new Date().toISOString()),
    uuid = options.uuid || (() => crypto.randomUUID());
  const backups: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const row = await options.storage.readCurrent();
    if (row.id !== "namofood" || !Number.isFinite(Date.parse(row.updated_at))) {
      throw new Error("Invalid current cloud row");
    }
    const before = JSON.parse(
      await decryptText(options.password, row.data),
    ) as State;
    const beforeRecipes = manualRecipeState(before);
    const beforeProfile = options.manualPolicy
      ? createPremiumDishProfiler(beforeRecipes)
      : undefined;
    const runIds = [
      ...new Set(
        Object.entries(before.menuPlanMeta || {}).filter(([key, meta]) =>
          (options.manualPolicy
            ? key.split("|")[0] >= options.today
            : key.split("|")[0] > options.today) &&
          meta.by === "ai" &&
          (options.manualPolicy
            ? (() => {
              const content = mealContents(before, key);
              return menuManualViolations(
                content.slots,
                content.extras,
                beforeRecipes,
                beforeProfile,
              )
                .length > 0;
            })()
            : options.force || meta.model !== REFRESH_MODEL)
        ).map(([, meta]) => meta.runId),
      ),
    ];
    let ownership = options.ownership
      ? validateOwnershipProofs(options.ownership)
      : { runAdded: {} };
    if (!options.ownership && runIds.some((id) => id !== RECOVERY_RUN_ID)) {
      try {
        const loaded = await options.storage.readRunAdded(
          runIds.filter((id) => id !== RECOVERY_RUN_ID),
        );
        ownership = { runAdded: loaded.runAdded };
      } catch {
        throw new Error(
          "Run ownership unavailable; provide an audited --ownership-file",
        );
      }
    }
    if (
      runIds.includes(RECOVERY_RUN_ID) && !ownership.runAdded[RECOVERY_RUN_ID]
    ) {
      const backup = await options.storage.readBackup(RECOVERY_BACKUP_ID);
      if (!backup) {
        throw new Error(
          "Retained recovery backup unavailable; audited ownership proof required",
        );
      }
      ownership.runAdded[RECOVERY_RUN_ID] = deriveRecoveryOwnedCells(
        JSON.parse(await decryptText(options.password, backup.data)),
        before,
      );
    }
    const at = now(), runId = uuid();
    const planned = planInstitutionalRefresh(before, options.bank, ownership, {
      today: options.today,
      updated: at,
      runId,
      force: options.force,
      manualPolicy: options.manualPolicy,
    });
    const report = {
      catalogAdded: planned.catalogAdded,
      catalogSkipped: planned.catalogSkipped.length,
      refreshedMeals: planned.refreshedMeals,
      skippedMeals: planned.skippedMeals,
      ownedCells: planned.ownedCells.length,
      changedCells: planned.changedCells.length,
      protectedChanged: planned.protectedChanged,
      generatedOwnership: planned.generatedOwnership,
      missingNewRecipes: planned.missingNewRecipes,
      plan: planned.plan,
    };
    if (
      !options.apply ||
      !planned.changedCells.length && !planned.catalogAdded.length
    ) {
      return {
        dry: !options.apply,
        saved: false,
        readBackVerified: false,
        attempt,
        backups,
        ...report,
      };
    }
    const backup: CloudRow = {
      id: `namofood@before-institutional-refresh-${
        at.replace(/[:.]/g, "-")
      }-${runId}-${attempt}`,
      data: row.data,
      updated_at: at,
    };
    const confirmed = await options.storage.createBackup(backup);
    if (
      confirmed.id !== backup.id || confirmed.data !== backup.data ||
      Date.parse(confirmed.updated_at) !== Date.parse(backup.updated_at)
    ) {
      throw new Error("Encrypted backup unconfirmed; state not written");
    }
    backups.push(backup.id);
    const next = {
      id: "namofood",
      data: await encryptText(options.password, JSON.stringify(planned.after)),
      updated_at: at,
    };
    const saved = await options.storage.compareAndSwap(row, next);
    if (!saved) continue;
    const written = JSON.parse(await decryptText(options.password, saved.data));
    if (!equal(written, planned.after)) {
      throw new Error(
        "Committed state verification failed; inspect encrypted backup",
      );
    }
    const readback = await options.storage.readCurrent();
    if (
      !equal(readback, saved) ||
      !equal(
        JSON.parse(await decryptText(options.password, readback.data)),
        planned.after,
      )
    ) {
      throw new Error(
        "Refresh committed but state changed concurrently during read-back; completion is unverified",
      );
    }
    return {
      dry: false,
      saved: true,
      readBackVerified: true,
      attempt,
      backups,
      ...report,
    };
  }
  throw new Error(
    "CAS conflict after 3 fresh attempts; no stale state overwritten",
  );
}

async function restStorage(): Promise<RefreshStorage> {
  const source = await Deno.readTextFile(
    new URL("../nmf_cloud.mjs", import.meta.url),
  );
  const key = source.match(/const KEY =\s*"([^"]+)"/)?.[1];
  const origin = source.match(/const URL_ =\s*"([^"]+)"/)?.[1];
  if (!key || !origin) throw new Error("Cloud configuration unavailable");
  const api = `${origin}/rest/v1/namofood_state`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const load = async (id: string) => {
    const r = await fetch(
      `${api}?id=eq.${encodeURIComponent(id)}&select=id,data,updated_at`,
      { headers },
    );
    if (!r.ok) throw new Error(`Cloud read failed ${r.status}`);
    return (await r.json())[0] as CloudRow | undefined;
  };
  return {
    readCurrent: async () => {
      const row = await load("namofood");
      if (!row) throw new Error("Current encrypted state missing");
      return row;
    },
    readBackup: load,
    readRunAdded: async (runIds) => {
      if (!runIds.length) return { runAdded: {} };
      const query = new URL(`${origin}/rest/v1/namofood_menu_runs`);
      query.searchParams.set("run_id", `in.(${runIds.join(",")})`);
      query.searchParams.set("select", "run_id,added");
      const r = await fetch(query, { headers });
      if (!r.ok) throw new Error(`Run provenance read failed ${r.status}`);
      const runAdded: Record<string, string[]> = {};
      for (const row of await r.json()) {
        const added = typeof row.added === "string"
          ? JSON.parse(row.added)
          : row.added;
        if (Array.isArray(added)) runAdded[row.run_id] = added;
      }
      return validateOwnershipProofs({ runAdded });
    },
    createBackup: async (row) => {
      const r = await fetch(api, {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`Encrypted backup failed ${r.status}`);
      const [saved] = await r.json();
      return saved;
    },
    compareAndSwap: async (before, next) => {
      const r = await fetch(
        `${api}?id=eq.namofood&updated_at=eq.${
          encodeURIComponent(before.updated_at)
        }`,
        {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=representation" },
          body: JSON.stringify({
            data: next.data,
            updated_at: next.updated_at,
          }),
        },
      );
      if (!r.ok) throw new Error(`Cloud CAS failed ${r.status}`);
      return (await r.json())[0];
    },
  };
}

async function main() {
  if (Deno.args.includes("--self-test")) {
    await import("./test_institutional_refresh.ts");
    return;
  }
  const allowed = new Set([
    "--today",
    "--ownership-file",
    "--apply",
    "--force",
    "--manual-policy",
  ]);
  for (let i = 0; i < Deno.args.length; i++) {
    if (!allowed.has(Deno.args[i])) {
      throw new Error(`Unknown argument ${Deno.args[i]}`);
    }
    if (["--today", "--ownership-file"].includes(Deno.args[i])) {
      if (!Deno.args[i + 1] || Deno.args[i + 1].startsWith("--")) {
        throw new Error(`${Deno.args[i]} requires a value`);
      }
      i++;
    }
  }
  const today = Deno.args[Deno.args.indexOf("--today") + 1];
  if (!Deno.args.includes("--today") || !today) {
    throw new Error("--today YYYY-MM-DD required");
  }
  validDate(today);
  const password = Deno.env.get("NMF_PW");
  if (!password) throw new Error("NMF_PW required");
  const ownershipPath = Deno.args.includes("--ownership-file")
    ? Deno.args[Deno.args.indexOf("--ownership-file") + 1]
    : undefined;
  const ownership = ownershipPath
    ? validateOwnershipProofs(
      JSON.parse(await Deno.readTextFile(ownershipPath)),
    )
    : undefined;
  // Dynamic import keeps synthetic self-tests independent of catalog development.
  const catalogUrl =
    new URL("./institutional_catalog.ts", import.meta.url).href;
  const { INSTITUTIONAL_CATALOG } = await import(catalogUrl);
  const result = await applyInstitutionalRefresh({
    password,
    today,
    bank: INSTITUTIONAL_CATALOG,
    ownership,
    apply: Deno.args.includes("--apply"),
    force: Deno.args.includes("--force"),
    manualPolicy: Deno.args.includes("--manual-policy"),
    storage: await restStorage(),
  });
  console.log(JSON.stringify(result, null, 2));
}
// A self-test imports this module back for its pure exports. Allow this module
// to finish evaluating before that import, avoiding a top-level-await cycle.
if (import.meta.main) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
