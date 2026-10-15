import type { TaxState } from "../nmf-tax-nightly/lib.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, item],
      ) => [key, canonical(item)]),
    );
  }
  return value;
}

// Ignore UI state, staff, menus and unrelated settings; only persisted sales/orders trigger AI.
export async function financeHash(state: TaxState): Promise<string> {
  const meals = (state.settings?.meals || {}) as Record<
    string,
    { price?: unknown }
  >;
  const pricing = {
    tickets: state.settings?.tickets || {},
    mealPrices: Object.fromEntries(
      ["조식", "중식", "석식", "야식"].map(
        (meal) => [meal, meals[meal]?.price ?? null],
      ),
    ),
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      canonical({
        sales: state.sales || {},
        // Evidence attachments do not change any tax input. Preserve the existing
        // fingerprint exactly for orders without this new nonfinancial field.
        orders: Object.fromEntries(
          Object.entries(state.orders || {}).map((
            [month, rows],
          ) => [
            month,
            rows.map((row) =>
              Object.fromEntries(
                Object.entries(row).filter(([key]) => key !== "invoicePhoto"),
              )
            ),
          ]),
        ),
        pricing,
      }),
    ),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export function inspectFinance(
  previous: string | null,
  next: string,
  changedAt: string,
  dueAt: string | null,
) {
  if (previous === null) {
    return { hash: next, dueAt: null, changed: false, baseline: true };
  }
  const changed = previous !== next;
  return {
    hash: next,
    dueAt: changed
      ? new Date(Date.parse(changedAt) + 60000).toISOString()
      : dueAt,
    changed,
    baseline: false,
  };
}
