import {
  financeHash,
  inspectFinance,
} from "../supabase/functions/nmf-tax-auto/debounce.ts";
import type { TaxState } from "../supabase/functions/nmf-tax-nightly/lib.ts";
const assert = (ok: boolean, message: string) => {
  if (!ok) throw Error(message);
};
const orderPhotoBase = {
  orders: {
    "2026-10": [{
      id: "photo-fixture",
      date: "2026-10-03",
      total: 11400,
      items: [],
    }],
  },
} as unknown as TaxState;
const orderWithPhoto = {
  orders: {
    "2026-10": [{
      id: "photo-fixture",
      date: "2026-10-03",
      total: 11400,
      items: [],
      invoicePhoto: { hash: "a".repeat(64), updatedAt: "2026-10-15T00:00:00Z" },
    }],
  },
} as unknown as TaxState;
assert(
  await financeHash(orderPhotoBase) === await financeHash(orderWithPhoto),
  "photo attachment is not a financial change or an extra AI tax call",
);
const hash = await financeHash(
  {
    sales: { "2026-10": { "12": { a: 3, b: 4 } } },
    orders: {},
  } as unknown as TaxState,
);
assert(
  hash ===
    await financeHash(
      {
        orders: {},
        sales: { "2026-10": { "12": { b: 4, a: 3 } } },
        settings: { wage: 3 },
        menus: { a: 1 },
      } as unknown as TaxState,
    ),
  "key order and unrelated edits do not trigger",
);
assert(
  inspectFinance(null, hash, "2026-10-13T00:00:00Z", null).dueAt === null,
  "initial baseline never invokes AI",
);
assert(
  hash !==
    await financeHash(
      {
        sales: { "2026-10": { "12": { a: 3, b: 4 } } },
        orders: {},
        settings: { tickets: { 중식: 12000 } },
      } as unknown as TaxState,
    ),
  "sales ticket price edits trigger recalculation",
);
let result = inspectFinance("old", hash, "2026-10-13T00:00:00Z", null);
assert(
  result.dueAt === "2026-10-13T00:01:00.000Z",
  "last financial save + 60 seconds",
);
result = inspectFinance(hash, hash, "2026-10-13T00:00:30Z", result.dueAt);
assert(
  result.dueAt === "2026-10-13T00:01:00.000Z",
  "unrelated edits do not reset financial quiet timer",
);
const changed = await financeHash(
  { sales: { a: 1 }, orders: {} } as unknown as TaxState,
);
result = inspectFinance(hash, changed, "2026-10-13T00:00:50Z", result.dueAt);
assert(
  result.dueAt === "2026-10-13T00:01:50.000Z",
  "new finance edit resets timer across devices",
);
assert(
  inspectFinance(changed, changed, "2026-10-13T00:02:00Z", null).dueAt === null,
  "same version never retries after success or failure",
);
console.log(
  "FINANCIAL_HASH_BASELINE_QUIET_60_SECONDS_RESET_UNRELATED_EDITS_NO_RETRY_OK",
);
