// Isolated transactional adapter: real encrypted serialization, no external DB.
import { handleInvoiceLedger } from "../supabase/functions/_shared/invoice-ledger-handler.ts";
import {
  decryptText,
  encryptText,
} from "../supabase/functions/nmf-recipe-fill/lib.ts";
const assert = (v: unknown, label: string) => {
  if (!v) throw Error(label);
};
const pw = "test-only-ledger-password",
  hash = "b".repeat(64),
  at = "2026-10-20T00:00:00Z";
let data = new Map<string, any>();
const blank = () =>
  ({ settings: {}, staff: [], orders: {}, orderEdits: {} }) as any;
const food = blank(), store = blank();
food.orders["2026-10"] = [{
  id: "new",
  date: "2026-10-03",
  vendor: "검증유통",
  total: 3300,
  subtotal: 3300,
  tax: null,
  items: [
    { id: "a", name: "양파", qty: 1, price: 1100, amt: 1100, tax: null },
    { id: "b", name: "콜라", qty: 1, price: 2200, amt: 2200, tax: null },
  ],
  invoiceFile: { hash, name: "test.xlsx" },
  ocrMeta: {
    sourceFileHash: hash,
    sourceKey: "test",
    referenceOnly: true,
    sourceAudit: { reconcilePending: true },
  },
}];
for (const [id, state] of [["namofood", food], ["namostore", store]] as const) {
  data.set(id, {
    id,
    data: await encryptText(pw, JSON.stringify(state)),
    updated_at: at,
  });
}
const db = {
  begin: async (fn: any) => {
    const working = structuredClone(data);
    const tx = async (strings: TemplateStringsArray, ...values: any[]) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      if (query.startsWith("select id,data,updated_at")) {
        return [working.get("namofood"), working.get("namostore")].filter(
          Boolean,
        );
      }
      if (query.startsWith("select data")) {
        const row = working.get(values[0]);
        return row ? [{ data: row.data }] : [];
      }
      if (query.startsWith("insert into")) {
        const [id, cipher, time] = values;
        if (!working.has(id)) {
          working.set(id, {
            id,
            data: cipher,
            updated_at: time,
          });
        }
        return [];
      }
      if (query.startsWith("update public.namofood_state")) {
        const [cipher, time, id] = values;
        working.set(id, { id, data: cipher, updated_at: time });
        return [];
      }
      throw Error("unexpected test SQL");
    };
    const result = await fn(tx);
    data = working;
    return result;
  },
} as any;
const preview = await handleInvoiceLedger(
  { room: "namofood", mode: "preview", id: "new" },
  pw,
  db,
);
assert(
  preview.status === 200 && (preview.data as any).automatic,
  "serialized source preview",
);
const body = {
  room: "namofood",
  mode: "apply",
  id: "new",
  fingerprint: (preview.data as any).fingerprint,
  replace: [],
  choices: {},
  confirmed: false,
};
const before = JSON.stringify([...data]),
  failed = await handleInvoiceLedger(body, pw, db);
assert(
  failed.status === 400 &&
    (failed.data as any).code === "purchase_original_missing",
  "missing blob explicitly rejected",
);
assert(
  JSON.stringify([...data]) === before,
  "missing original rolls back source archive, both roots and snapshots",
);
data.set("namofood#invoice-file#" + hash, {
  id: "namofood#invoice-file#" + hash,
  data: await encryptText(
    pw,
    JSON.stringify({
      v: 1,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: "eA==",
    }),
  ),
  updated_at: at,
});
const applied = await handleInvoiceLedger(body, pw, db);
assert(
  applied.status === 200 && (applied.data as any).routes.length === 2,
  "atomic balanced split across roots",
);
assert(
  data.get("namofood#invoice-file#" + hash).data ===
    data.get("namostore#invoice-file#" + hash).data,
  "identical encrypted original copied into destination authorized namespace",
);
const stored = JSON.parse(await decryptText(pw, data.get("namostore").data));
assert(
  stored.orders["2026-10"][0].total === 2200,
  "durable encrypted store amount",
);
const count = data.size;
assert(
  (await handleInvoiceLedger(body, pw, db)).status === 200 &&
    data.size === count,
  "retry adds no copies or snapshots",
);
assert(
  (await handleInvoiceLedger({ ...body, room: "private" }, pw, db)).status ===
    400,
  "room cannot widen scope",
);
assert(
  (await handleInvoiceLedger({ ...body, replace: [{}] }, pw, db)).status ===
    400,
  "selection validated before any DB access",
);
console.log(
  "LEDGER_HANDLER_ENCRYPTED_ROUNDTRIP_TWO_ROOT_LOCK_ORIGINAL_COPY_ROLLBACK_RETRY_SCOPE_VALIDATION_OK",
);
