import {
  applyPurchaseRouting,
  classifyPurchaseItem,
  purchaseRooms,
  purchaseRoutingPlan,
  type PurchaseState,
  type PurchaseTarget,
} from "./purchase-routing.ts";

const clone = <T>(v: T): T => structuredClone(v);
const key = (v: unknown) =>
  String(v ?? "").normalize("NFKC").toLowerCase().replace(
    /주식회사|\(주\)|㈜|[^a-z0-9가-힣]/g,
    "",
  );
const label = (v: unknown) =>
  String(v ?? "").normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
const num = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12;
const digest = async (v: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(v)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const orders = (s: PurchaseState, field = "orders"): any[] =>
  Object.values(s?.[field] || {}).filter(Array.isArray).flat();
const active = (s: PurchaseState, o: any) =>
  !s.orderEdits?.[o.id]?.deleted && !o.ocrMeta?.referenceOnly &&
  !o.ocrMeta?.duplicateReviewPending;
const cell = (v: any) =>
  v == null || v === "" ? null : typeof v === "number" ? v : label(v);
const rowKey = (i: any) =>
  JSON.stringify([
    label(i.name),
    label(i.spec),
    label(i.unit),
    ...["qty", "price", "supplyAmount", "tax", "amt"].map((f) => cell(i[f])),
  ]);
const bag = (items: any[]) => items.map(rowKey).sort();
const equalRows = (a: any[], b: any[]) =>
  JSON.stringify(bag(a)) === JSON.stringify(bag(b));
const total = (items: any[]) =>
  items.every((i) => num(i.amt)) ? items.reduce((n, i) => n + i.amt, 0) : null;
const knownVendor = (v: any) =>
  !!key(v) && !/미입력|미확인|나모푸드|namofood/.test(key(v));
const validDate = (v: any) => {
  const d = new Date(v + "T12:00Z");
  return typeof v === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(+d) && d.toISOString().slice(0, 10) === v;
};
type Ref = { room: string; field: string; order: any };

// Follow routed leaves back to one physical invoice, including re-routing a child.
function originalKey(ref: Ref, all: Map<string, Ref>) {
  let current = ref, id = ref.room + "|" + ref.order.id;
  const seen = new Set<string>();
  while (current.order.ocrMeta?.purchaseRoute?.sourceId && !seen.has(id)) {
    seen.add(id);
    const route = current.order.ocrMeta.purchaseRoute;
    const parent = route.sourceRoom + "|" + route.sourceId;
    if (parent === id) break;
    id = parent;
    const next = all.get(id);
    if (!next) break;
    current = next;
  }
  return id;
}
export async function invoiceLedgerPlan(
  states: Record<string, PurchaseState>,
  room: string,
  id: string,
  choices: Record<string, PurchaseTarget> = {},
) {
  if (!purchaseRooms.includes(room as any)) throw Error("invalid_ledger_room");
  const source = orders(states[room]).find((o) => o.id === id);
  if (!source || states[room].orderEdits?.[id]?.deleted) {
    throw Error("ledger_missing");
  }
  const journal = states[room].ledgerImports?.[id];
  if (journal) return { already: true, id, routes: journal.routes };
  if (
    !source.ocrMeta?.sourceFileHash || !source.ocrMeta?.sourceKey ||
    !source.ocrMeta?.referenceOnly || !source.invoiceFile ||
    source.invoiceFile.deleted
  ) throw Error("ledger_source_required");
  const refs: Ref[] = [];
  for (const r of purchaseRooms) {
    for (const field of ["orders", "fixedPurchases"]) {
      for (const order of orders(states[r], field)) {
        refs.push({ room: r, field, order });
      }
    }
  }
  const all = new Map(refs.map((ref) => [ref.room + "|" + ref.order.id, ref]));
  const groups = new Map<string, Ref[]>();
  for (const ref of refs) {
    if (
      ref.room === room && ref.order.id === id ||
      !active(states[ref.room], ref.order)
    ) continue;
    const root = originalKey(ref, all);
    (groups.get(root) || groups.set(root, []).get(root)!).push(ref);
  }
  const names = new Set((source.items || []).map((i: any) => key(i.name)));
  const candidates = [];
  for (const [group, members] of groups) {
    const root = all.get(group)?.order || members[0].order;
    if (
      root.date !== source.date ||
      knownVendor(source.vendor) && knownVendor(root.vendor) &&
        key(root.vendor) !== key(source.vendor)
    ) continue;
    const items = members.flatMap((m) => m.order.items || []);
    const overlap = items.filter((i) => names.has(key(i.name))).length;
    const sameNo = !!key(source.invoiceNo) &&
      key(source.invoiceNo) === key(root.invoiceNo);
    if (
      !overlap && !sameNo && knownVendor(root.vendor) &&
      knownVendor(source.vendor)
    ) continue;
    const sum = total(items),
      exact = equalRows(source.items, items) && sum !== null &&
        sum === source.total;
    const headerOK = members.length > 1 ||
      ["subtotal", "tax", "total"].every((f) =>
        cell(source[f]) === cell(root[f])
      );
    const invoiceOK = !key(source.invoiceNo) || !key(root.invoiceNo) || sameNo;
    const newer = Date.parse(root.ocrMeta?.registeredAt || "") >
      Date.parse(source.ocrMeta?.registeredAt || "");
    candidates.push({
      key: group,
      date: root.date,
      vendor: String(root.vendor || ""),
      invoiceNo: String(root.invoiceNo || ""),
      items: clone(items),
      total: sum,
      overlap,
      exact,
      newer,
      automatic: exact && headerOK && invoiceOK && knownVendor(root.vendor) &&
        !newer,
      members: members.map((m) => ({
        room: m.room,
        field: m.field,
        id: m.order.id,
      })),
    });
  }
  // Classification is per line; all resulting portions retain the same original.
  const prepared = clone(states[room]);
  const temp = orders(prepared).find((o) => o.id === id);
  temp.ocrMeta.referenceOnly = false;
  const defaults: Record<string, PurchaseTarget> = {};
  for (const [index, item] of source.items.entries()) {
    const c = classifyPurchaseItem(item, room);
    defaults[item.id || String(index)] = c.kind === "ingredient"
      ? "food"
      : c.target;
  }
  const routing = await purchaseRoutingPlan(prepared, room, id, {
    ...defaults,
    ...choices,
  });
  const sourceSound = validDate(source.date) && knownVendor(source.vendor) &&
    source.ocrMeta.sourceAudit?.dateUncertain !== true && num(source.total) &&
    total(source.items) === source.total;
  const exactAll = candidates.length > 0 &&
    candidates.every((c) => c.automatic);
  const union = candidates.flatMap((c) => c.items);
  const unionExact = candidates.length > 1 && equalRows(source.items, union) &&
    total(union) === source.total &&
    candidates.every((c) => knownVendor(c.vendor) && !c.newer);
  const automatic = sourceSound &&
    (candidates.length === 0 || exactAll || unionExact);
  const splitOK = routing.targets.length === 1 ||
    total(source.items) === source.total &&
      source.items.every((i: any) => num(i.amt));
  const fingerprint = await digest({
    source,
    edit: states[room].orderEdits?.[id],
    candidates: candidates.map((c) => ({
      key: c.key,
      root: all.get(c.key)?.order,
      members: c.members.map((m) => ({
        ...m,
        order: all.get(m.room + "|" + m.id)?.order,
        edit: states[m.room].orderEdits?.[m.id],
      })),
    })),
  });
  return {
    already: false,
    id,
    room,
    date: source.date,
    vendor: String(source.vendor || ""),
    invoiceNo: String(source.invoiceNo || ""),
    items: clone(source.items),
    total: source.total ?? null,
    fingerprint,
    candidates,
    routing,
    choices: { ...defaults, ...choices },
    automatic,
    autoReplace: automatic ? candidates.map((c) => c.key) : [],
    canApply: validDate(source.date) && knownVendor(source.vendor) && splitOK,
    reason: !knownVendor(source.vendor)
      ? "공급업체 확인 필요"
      : !splitOK
      ? "품목 금액 합계와 총액을 확인해야 사업장별로 분리할 수 있습니다."
      : !sourceSound
      ? "거래일·수량·금액 확인 필요"
      : !automatic
      ? "일부 중복·다른 명세서 번호·분류를 확인해 주세요."
      : "품목·금액 대조 완료",
  };
}

export async function applyInvoiceLedger(
  states: Record<string, PurchaseState>,
  room: string,
  id: string,
  expected: string,
  selection: string[],
  choices: Record<string, PurchaseTarget>,
  confirmed: boolean,
  at: string,
) {
  const plan = await invoiceLedgerPlan(states, room, id, choices);
  if (plan.already) {
    return { already: true, routes: plan.routes, touched: [] as string[] };
  }
  if (plan.fingerprint !== expected) throw Error("ledger_changed");
  if (!plan.canApply) throw Error("ledger_amount_review");
  if (
    !confirmed &&
    (!plan.automatic ||
      JSON.stringify([...selection].sort()) !==
        JSON.stringify([...plan.autoReplace!].sort()))
  ) throw Error("ledger_confirmation_required");
  if (
    new Set(selection).size !== selection.length ||
    selection.some((k) => !plan.candidates!.some((c) => c.key === k))
  ) throw Error("invalid_ledger_selection");
  // Work on a copy so validation failure cannot leak a partial archive to callers.
  const work = clone(states),
    source = orders(work[room]).find((o) => o.id === id),
    archived = [],
    rootRooms = new Set<string>();
  const metadata = {
    at,
    sourceRoom: room,
    sourceId: id,
    fingerprint: expected,
  };
  for (
    const candidate of plan.candidates!.filter((c) => selection.includes(c.key))
  ) {
    for (const member of candidate.members) {
      const old = orders(work[member.room], member.field).find((o) =>
        o.id === member.id
      );
      Object.assign(old.ocrMeta ||= {}, {
        referenceOnly: true,
        referenceAt: at,
        referenceReason:
          "최신 원장으로 대체 · 이전 발주와 원본 보관 / 중복 합산 제외",
        balanceEvidence: false,
        supersededById: id,
        ledgerImport: { ...metadata, role: "archived" },
      });
      (work[member.room].orderEdits ||= {})[old.id] = {
        at,
        origin: "manual",
        deleted: false,
      };
      archived.push(member);
    }
  }
  for (
    const candidate of plan.candidates!.filter((c) => selection.includes(c.key))
  ) {
    const separator = candidate.key.indexOf("|"),
      rootRoom = candidate.key.slice(0, separator),
      rootId = candidate.key.slice(separator + 1);
    const root = orders(work[rootRoom]).find((o) => o.id === rootId);
    if (root?.ocrMeta?.referenceOnly) {
      Object.assign(root.ocrMeta, {
        balanceEvidence: false,
        supersededById: id,
        ledgerImport: { ...metadata, role: "archived" },
      });
      rootRooms.add(rootRoom);
      (work[rootRoom].orderEdits ||= {})[rootId] = {
        at,
        origin: "manual",
        deleted: false,
      };
    }
  }
  for (const member of archived.filter((m) => m.room === "namostore")) {
    const state = work.namostore,
      old = orders(state, member.field).find((o) => o.id === member.id);
    for (const [index, item] of old.items.entries()) {
      const identity = JSON.stringify([
        "purchase-line-v2",
        old.id,
        String(item.id || "row-" + index),
      ]);
      const product = state.storeProducts?.[item.storeProductId] ||
        Object.values(state.storeProducts || {}).find((p: any) =>
          p.sourceIdentity === identity
        ) as any;
      if (
        product && !orders(state).some((o) =>
          active(state, o) &&
          (o.items || []).some((i: any) => i.storeProductId === product.id)
        )
      ) state.storeProducts[product.id] = { ...product, deleted: true, at };
    }
  }
  Object.assign(source.ocrMeta, {
    referenceOnly: false,
    referenceAt: at,
    referenceReason: "최신 엑셀 품목 대조 완료",
    ledgerImport: { ...metadata, role: "current" },
    supersedesIds: archived.map((m) => m.id),
  });
  for (const row of plan.routing!.rows.filter((r: any) => !r.certain)) {
    const item = source.items[row.index];
    item.warnings = [
      ...new Set([
        ...(item.warnings || []),
        "사업장 자동 분류 확인 필요 · 사업장 변경으로 수정 가능",
      ]),
    ];
  }
  source.ocrMeta.sourceAudit = {
    ...(source.ocrMeta.sourceAudit || {}),
    reconcilePending: false,
  };
  (work[room].orderEdits ||= {})[id] = { at, origin: "manual", deleted: false };
  const routing = await purchaseRoutingPlan(work[room], room, id, plan.choices);
  let routes: any[], touched: string[];
  if (routing.moved) {
    const outcome = await applyPurchaseRouting(
      work,
      room,
      id,
      routing.fingerprint,
      plan.choices!,
      true,
      at,
    );
    routes = outcome.routes;
    touched = outcome.touched;
  } else {
    routes = [{
      room,
      target: room === "namostore" ? "store" : "food",
      id,
      total: source.total ?? null,
    }];
    touched = [room];
  }
  (work[room].ledgerImports ||= {})[id] = { ...metadata, routes, archived };
  touched = [
    ...new Set([...touched, ...archived.map((m) => m.room), ...rootRooms]),
  ];
  for (const r of touched) states[r] = work[r];
  return { already: false, routes, archived: archived.length, touched };
}

// Server decisions survive both old admin clients and projected public saves.
export function preserveInvoiceLedgers(
  full: PurchaseState,
  incoming: PurchaseState,
) {
  if (full.ledgerImports) incoming.ledgerImports = clone(full.ledgerImports);
  else delete incoming.ledgerImports;
  const previous = new Map(orders(full).map((o) => [o.id, o]));
  const seen = new Set<string>();
  for (const order of orders(incoming)) {
    seen.add(order.id);
    const old = previous.get(order.id);
    if (!old?.ocrMeta?.ledgerImport) {
      if (order.ocrMeta) delete order.ocrMeta.ledgerImport;
      continue;
    }
    Object.assign(order.ocrMeta ||= {}, {
      ledgerImport: clone(old.ocrMeta.ledgerImport),
    });
    const newerReference = (Date.parse(order.ocrMeta.referenceAt) || 0) >
      (Date.parse(old.ocrMeta.referenceAt) || 0);
    for (
      const f of [
        "referenceOnly",
        "referenceAt",
        "referenceReason",
        "supersededById",
        "supersedesIds",
        "balanceEvidence",
        "sourceAudit",
      ]
    ) {
      // A later, explicit photo-duplicate archive is legitimate. Protect server
      // archives from resurrection, not current invoices from future archiving.
      if (
        f !== "sourceAudit" && old.ocrMeta.ledgerImport.role !== "archived" &&
        newerReference
      ) continue;
      if (Object.hasOwn(old.ocrMeta, f)) {
        order.ocrMeta[f] = clone(old.ocrMeta[f]);
      } else delete order.ocrMeta[f];
    }
  }
  for (const old of previous.values()) {
    if (
      old.ocrMeta?.ledgerImport && !seen.has(old.id) &&
      !incoming.orderEdits?.[old.id]?.deleted
    ) ((incoming.orders ||= {})[old.date.slice(0, 7)] ||= []).push(clone(old));
  }
  return incoming;
}
