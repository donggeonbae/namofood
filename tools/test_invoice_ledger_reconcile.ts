import {
  applyInvoiceLedger,
  invoiceLedgerPlan,
  preserveInvoiceLedgers,
} from "../supabase/functions/_shared/invoice-ledger.ts";
import {
  applyPurchaseRouting,
  preservePurchaseRouting,
  purchaseRoutingPlan,
} from "../supabase/functions/_shared/purchase-routing.ts";
const assert = (v: unknown, label: string) => {
  if (!v) throw Error(label);
};
const blank = () => ({ orders: {}, orderEdits: {}, fixedPurchases: {} }) as any;
const at = "2026-10-20T10:00:00Z";
const item = (name: string, amt: number, id: string) => ({
  id,
  name,
  spec: "1kg",
  unit: "개",
  qty: 1,
  price: amt,
  supplyAmount: amt,
  tax: null,
  amt,
});
const mixed = {
  id: "old",
  date: "2026-10-03",
  vendor: "검증유통",
  total: 6600,
  subtotal: 6600,
  tax: null,
  items: [
    item("양파", 1100, "a"),
    item("콜라", 2200, "b"),
    item("세제", 3300, "c"),
  ],
  invoiceFile: { hash: "a".repeat(64) },
  note: "원본 메모",
};
const incoming = (old: any, id = "new") => ({
  ...structuredClone(old),
  id,
  invoiceFile: { hash: "b".repeat(64) },
  ocrMeta: {
    referenceOnly: true,
    sourceFileHash: "b".repeat(64),
    sourceKey: id,
    sourceAudit: { sourceType: "period-ledger", reconcilePending: true },
  },
});
const fresh = () => {
  const states = { namofood: blank(), namostore: blank() };
  states.namofood.orders["2026-10"] = [structuredClone(mixed)];
  return states;
};
const live = (states: any) =>
  Object.values(states).flatMap((s: any) =>
    [
      ...Object.values(s.orders || {}).flat(),
      ...Object.values(s.fixedPurchases || {}).flat(),
    ].filter((o: any) =>
      !o.ocrMeta?.referenceOnly && !s.orderEdits?.[o.id]?.deleted
    )
  ) as any[];

const states = fresh(),
  route = await purchaseRoutingPlan(states.namofood, "namofood", "old");
await applyPurchaseRouting(
  states,
  "namofood",
  "old",
  route.fingerprint,
  {},
  true,
  at,
);
states.namofood.orders["2026-10"].push(incoming(mixed));
let plan = await invoiceLedgerPlan(states, "namofood", "new");
assert(
  plan.candidates?.length === 1 && plan.candidates[0].members.length === 3,
  "one source groups food+store+fixed leaves",
);
assert(
  plan.automatic && plan.autoReplace?.length === 1,
  "exact multiset including blank VAT auto replaces",
);
const result = await applyInvoiceLedger(
  states,
  "namofood",
  "new",
  plan.fingerprint!,
  plan.autoReplace!,
  {},
  false,
  at,
);
assert(
  result.archived === 3 &&
    live(states).reduce((n, o) => n + o.total, 0) === 6600,
  "old portions excluded, new portions count once",
);
assert(
  live(states).length === 3 &&
    live(states).every((o) => o.invoiceFile.hash === "b".repeat(64)),
  "all new portions share newest original",
);
assert(
  live(states).find((o) => o.ocrMeta.purchaseRoute.target === "store").total ===
    2200,
  "drinks in store",
);
assert(
  states.namofood.fixedPurchases["2026-10"].filter((o: any) =>
    !o.ocrMeta.referenceOnly
  ).length === 1,
  "fixed newest only",
);
assert(
  (await applyInvoiceLedger(
    states,
    "namofood",
    "new",
    "0".repeat(64),
    [],
    {},
    false,
    at,
  )).already,
  "retry idempotent without writes",
);
const stale = fresh().namofood;
preserveInvoiceLedgers(
  states.namofood,
  preservePurchaseRouting(states.namofood, stale),
);
assert(
  stale.orders["2026-10"].some((o: any) => o.id === "new"),
  "stale omitted new source retained",
);
assert(
  stale.orders["2026-10"].filter((o: any) =>
    o.ocrMeta?.ledgerImport?.role === "archived"
  ).every((o: any) => o.ocrMeta.referenceOnly),
  "stale clients cannot resurrect archived leaves",
);

const partial = fresh();
const next = incoming({
  ...mixed,
  items: [mixed.items[0], item("감자", 1000, "d")],
  total: 2100,
  subtotal: 2100,
});
partial.namofood.orders["2026-10"].push(next);
plan = await invoiceLedgerPlan(partial, "namofood", "new");
assert(
  !plan.automatic && plan.candidates?.length === 1,
  "partial overlap requires explicit selection",
);
const before = JSON.stringify(partial);
let rejected = false;
try {
  await applyInvoiceLedger(
    partial,
    "namofood",
    "new",
    plan.fingerprint!,
    [],
    {},
    false,
    at,
  );
} catch {
  rejected = true;
}
assert(
  rejected && JSON.stringify(partial) === before,
  "unconfirmed plan cannot archive or count new rows",
);
await applyInvoiceLedger(
  partial,
  "namofood",
  "new",
  plan.fingerprint!,
  [],
  {},
  true,
  at,
);
assert(
  live(partial).reduce((n, o) => n + o.total, 0) === 8700,
  "explicit separate transaction preserves existing invoice",
);

const changed = fresh();
changed.namofood.orders["2026-10"].push(incoming(mixed));
plan = await invoiceLedgerPlan(changed, "namofood", "new");
changed.namofood.orders["2026-10"][0].items[0].name = "수정 양파";
rejected = false;
try {
  await applyInvoiceLedger(
    changed,
    "namofood",
    "new",
    plan.fingerprint!,
    plan.autoReplace!,
    {},
    true,
    at,
  );
} catch {
  rejected = true;
}
assert(
  rejected && !changed.namofood.orders["2026-10"][0].ocrMeta,
  "stale fingerprint rejects manual changes",
);

const dates = fresh();
dates.namofood.orders["2026-10"].push({
  ...structuredClone(mixed),
  id: "different-vendor",
  vendor: "다른유통",
}, { ...structuredClone(mixed), id: "different-date", date: "2026-10-06" });
dates.namofood.orders["2026-10"].push(incoming(mixed));
plan = await invoiceLedgerPlan(dates, "namofood", "new");
assert(
  plan.candidates?.length === 1,
  "date and supplier scoped, never whole-day overwrite",
);
const repeats = fresh();
repeats.namofood.orders["2026-10"][0].items = [
  item("양파", 1100, "a"),
  item("양파", 1100, "b"),
];
repeats.namofood.orders["2026-10"][0].total = 2200;
repeats.namofood.orders["2026-10"].push(
  incoming({
    ...mixed,
    items: [item("양파", 1100, "a"), item("감자", 1100, "b")],
    total: 2200,
  }),
);
plan = await invoiceLedgerPlan(repeats, "namofood", "new");
assert(!plan.automatic, "multiset counts duplicate names, not set comparison");
const missing = fresh();
missing.namofood.orders["2026-10"].push(
  incoming({
    ...mixed,
    total: 6600,
    items: [mixed.items[0], { ...mixed.items[1], amt: null }],
  }),
);
plan = await invoiceLedgerPlan(missing, "namofood", "new");
assert(!plan.canApply, "mixed missing amounts cannot silently allocate money");
const decimal = fresh();
decimal.namofood.orders["2026-10"][0].items[0].spec = "1.5kg";
const decimalNew = incoming(mixed);
decimalNew.items[0].spec = "15kg";
decimal.namofood.orders["2026-10"].push(decimalNew);
plan = await invoiceLedgerPlan(decimal, "namofood", "new");
assert(
  !plan.automatic,
  "decimal punctuation in specifications must not collapse into a different pack size",
);
const store = { namofood: blank(), namostore: blank() };
store.namostore.orders["2026-10"] = [incoming({ ...mixed, id: "x" })];
plan = await invoiceLedgerPlan(store, "namostore", "new");
await applyInvoiceLedger(
  store,
  "namostore",
  "new",
  plan.fingerprint!,
  [],
  {},
  false,
  at,
);
assert(
  live(store).find((o) => o.ocrMeta.purchaseRoute.target === "food").items[0]
    .name === "양파",
  "ingredients imported in store go to food",
);
console.log(
  "LEDGER_RECONCILE_CROSS_ROOM_SHARED_ORIGINAL_EXACT_LATEST_PARTIAL_CONFIRM_STALE_MULTISET_BLANK_VAT_IDEMPOTENT_OK",
);
const current = {
  orders: {
    "2026-10": [{
      id: "current",
      date: "2026-10-03",
      ocrMeta: {
        ledgerImport: { role: "current" },
        referenceOnly: false,
        referenceAt: at,
        sourceAudit: { reconcilePending: false },
      },
    }],
  },
} as any;
const photoArchived = structuredClone(current);
Object.assign(photoArchived.orders["2026-10"][0].ocrMeta, {
  referenceOnly: true,
  referenceAt: "2026-10-21T10:00:00Z",
  supersededById: "new-photo",
});
preserveInvoiceLedgers(current, photoArchived);
assert(
  photoArchived.orders["2026-10"][0].ocrMeta.referenceOnly,
  "later explicit photo-duplicate archive cannot resurrect a ledger invoice",
);
const oldDraft = structuredClone(current);
oldDraft.orders["2026-10"][0].ocrMeta.referenceOnly = true;
oldDraft.orders["2026-10"][0].ocrMeta.referenceAt = "2026-10-01T00:00:00Z";
preserveInvoiceLedgers(current, oldDraft);
assert(
  !oldDraft.orders["2026-10"][0].ocrMeta.referenceOnly,
  "stale pre-reconciliation pending copy cannot hide a current invoice",
);
