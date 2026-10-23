// Explicitly requested rotation. Never generates dishes or changes non-main cells.
export const ROTATION_VERSION = "2026-10-24-two-week-methods-v1";
export const ROTATION_REFERENCE = ["2026-10-12", "2026-10-25"] as const;
export const MAIN_SLOTS = ["2", "7", "8"] as const;
export const MEALS = ["조식", "중식", "석식", "야식"] as const;
type Profile = { slotGroup: string; method: string };
export type RotationState = {
  menus?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};
export type Profiler = (name: string) => Profile;
export function referenceDishes(state: RotationState): Set<string> {
  const saved = state.menuRotationReference as {
    names?: unknown;
    version?: unknown;
  } | undefined;
  if (saved?.version === ROTATION_VERSION && Array.isArray(saved.names)) {
    return new Set(
      saved.names.filter((n): n is string =>
        typeof n === "string" && n.length > 0 && n.length <= 240
      ),
    );
  }
  const names = new Set<string>();
  for (const [month, cells] of Object.entries(state.menus || {})) {
    for (const [key, value] of Object.entries(cells)) {
      const [day, , slot] = key.split("|"),
        date = month + "-" + String(Number(day)).padStart(2, "0");
      if (
        date >= ROTATION_REFERENCE[0] && date <= ROTATION_REFERENCE[1] &&
        /^\d+$/.test(slot) && Number(slot) > 0 && typeof value === "string" &&
        value.trim()
      ) {
        names.add(value.trim());
      }
    }
  }
  return names;
}
export function methodConflict(
  a: Profile,
  b: Profile,
  sameMeal: boolean,
): boolean {
  return !!a.method && a.method === b.method &&
    (sameMeal || a.slotGroup === b.slotGroup);
}
export function rotateExistingMains(
  before: RotationState,
  profile: Profiler,
  from: string,
  to: string,
) {
  const after = structuredClone(before),
    pool = referenceDishes(before),
    changes: Array<
      {
        date: string;
        meal: string;
        slot: string;
        before: string;
        after: string;
      }
    > = [],
    blocked: Array<{ date: string; reason: string }> = [];
  const known = (p: Profile) =>
    !["국", "선택 제외"].includes(p.slotGroup) && !!p.method &&
    !/미분류|기타/.test(p.method);
  const mainNames = new Set<string>();
  for (const [month, cells] of Object.entries(before.menus || {})) {
    for (const [key, name] of Object.entries(cells)) {
      const [day, , slot] = key.split("|"),
        date = month + "-" + String(Number(day)).padStart(2, "0");
      if (
        date >= ROTATION_REFERENCE[0] && date <= ROTATION_REFERENCE[1] &&
        MAIN_SLOTS.includes(slot as typeof MAIN_SLOTS[number]) &&
        typeof name === "string"
      ) {
        mainNames.add(name);
      }
    }
  }
  const candidates = [...mainNames].map((name) => ({ name, ...profile(name) }))
    .filter((p) =>
      known(p) && !["김치", "샐러드", "밥·면", "국·찌개"].includes(p.method)
    );
  const dates = new Set<string>();
  for (const [month, cells] of Object.entries(before.menus || {})) {
    for (const key of Object.keys(cells)) {
      const [day, meal, slot] = key.split("|"),
        date = month + "-" + String(Number(day)).padStart(2, "0");
      if (
        date >= from && date <= to &&
        MEALS.includes(meal as typeof MEALS[number]) &&
        MAIN_SLOTS.includes(slot as typeof MAIN_SLOTS[number])
      ) {
        dates.add(date);
      }
    }
  }
  for (const date of [...dates].sort()) {
    const month = date.slice(0, 7),
      day = String(Number(date.slice(8))),
      cells = before.menus![month];
    const vars = MEALS.flatMap((meal) =>
      MAIN_SLOTS.flatMap((slot) => {
        const key = day + "|" + meal + "|" + slot, name = cells[key];
        return typeof name === "string" && name.trim()
          ? [{ key, meal, slot, name: name.trim(), ...profile(name.trim()) }]
          : [];
      })
    ).filter(known);
    const conflicts = vars.some((v, i) =>
      vars.slice(0, i).some((w) => methodConflict(v, w, v.meal === w.meal))
    );
    if (!conflicts) continue;
    let solution: typeof candidates | undefined, visits = 0;
    const picked: typeof candidates = [];
    // Iterative change budget keeps the largest possible number of original mains.
    // Preserve the current ingredient group first. If misfiled mains make
    // that impossible, use the slot's intended meat/fish/other group instead.
    for (const canonical of [false, true]) {
      if (solution) break;
      visits = 0;
      for (let budget = 1; budget <= vars.length && !solution; budget++) {
        const search = (i: number, changed: number): boolean => {
          if (++visits > 500000) return false;
          if (i === vars.length) {
            solution = [...picked];
            return true;
          }
          const offset = Number(date.replaceAll("-", "")) %
              Math.max(1, candidates.length),
            bank = [
              ...candidates.slice(offset),
              ...candidates.slice(0, offset),
            ];
          const v = vars[i],
            targetGroup = canonical
              ? ({ "2": "고기", "7": "생선", "8": "기타 주찬" }[v.slot] ||
                v.slotGroup)
              : v.slotGroup,
            methods = new Set([v.slotGroup + "|" + v.method]),
            options = [
              { name: v.name, ...profile(v.name) },
              ...bank.filter((c) => {
                const key = c.slotGroup + "|" + c.method;
                if (c.slotGroup !== targetGroup || methods.has(key)) {
                  return false;
                }
                methods.add(key);
                return true;
              }),
            ];
          for (const c of options) {
            const cost = c.name === v.name ? 0 : 1;
            if (
              changed + cost > budget ||
              picked.some((p, j) =>
                p.name === c.name ||
                methodConflict(c, p, v.meal === vars[j].meal)
              )
            ) continue;
            picked.push(c);
            if (search(i + 1, changed + cost)) return true;
            picked.pop();
          }
          return false;
        };
        search(0, 0);
      }
    }
    if (!solution) {
      blocked.push({
        date,
        reason: "기준 2주 메뉴만으로 조리방식 중복 없는 조합 부족",
      });
      continue;
    }
    vars.forEach((v, i) => {
      const name = solution![i].name;
      if (name !== v.name) {
        after.menus![month][v.key] = name;
        changes.push({
          date,
          meal: v.meal,
          slot: v.slot,
          before: v.name,
          after: name,
        });
      }
    });
  }
  after.menuRotationReference = {
    version: ROTATION_VERSION,
    from: ROTATION_REFERENCE[0],
    to: ROTATION_REFERENCE[1],
    names: [...pool],
  };
  return { after, changes, blocked, referenceCount: pool.size };
}
