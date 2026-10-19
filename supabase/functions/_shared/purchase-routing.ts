// Source amounts are authoritative. Classification cannot create prices or VAT.
export type PurchaseState = Record<string, any>;
export type PurchaseTarget = "food" | "store" | "fixed";
export const purchaseRooms = ["namofood", "namostore"] as const;
const clone = <T>(v: T): T => structuredClone(v);
const numeric = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12;
const hash = async (v: unknown) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(v)),
    )),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
export function classifyPurchaseItem(item: any, room: string) {
  const name = String(item.name || "").normalize("NFKC").toLowerCase();
  const nonfood =
    /세제|세정제|세척제|린스|락스|수세미|행주|페이퍼\s*타올|키친\s*타[올월]|물티슈|위생\s*장갑|고무\s*장갑|니트릴|라텍스|쓰레기\s*봉투|비닐\s*봉투|종이\s*컵|일회용|호일|포일|랩\s*(?:필름|[0-9])|청소|휴지|화장지|케이블|건전지|배터리|유니폼|소화기|식기\s*세척기|프린터|토너|세탁|방역|출장비|설치비|배송비|택배비|스케일\s*(?:제거제)?$|오븐\s*(?:크리너|클리너|세제)?$|에벌\s*(?:\(|세제)/;
  const ingredient =
    /소고기|돼지|닭고기|오리고기|앞다리|목살|삼겹|다짐육|양파|대파|당근|양배추|콩나물|숙주|감자|고구마|마늘|청양고추|고춧가루|고추장|된장|간장|식용유|참기름|물엿|굴소스|맛술|우스타|밀가루|부침가루|튀김가루|쌀|찹쌀|두부|계란|달걀|특란|대란|어묵|오징어|고등어|갈치|명태|원두|시럽|농축액|분말|파우더|소스|엑기스|다시다|티백/;
  const beverage =
    /코카\s*콜라|펩시|콜라|사이다|스프라이트|환타|생수|먹는\s*샘물|삼다수|백산수|아이시스|칠성|밀키스|포카리|게토레이|토레타|이온\s*음료|탄산수|탄산\s*음료|음료|주스|쥬스|식혜|수정과|캔\s*커피|레쓰비|조지아\s*커피|몬스터\s*에너지|핫식스|에너지\s*드링크|초코\s*우유|바나나\s*우유/;
  const snack = /과자|쿠크다스|초코하임|화이트하임|버터링|초코파이|몽쉘|오예스|비스킷|크래커|초콜릿|사탕|젤리|껌/;
  const keep: PurchaseTarget = room === "namostore" ? "store" : "food";
  if (nonfood.test(name)) return { target: "fixed" as const, kind: "nonfood", certain: true, reason: "세제·비품·비식재료" };
  if (ingredient.test(name)) return { target: keep, kind: "ingredient", certain: true, reason: "식재료 · 현재 사업장 유지" };
  if (beverage.test(name)) return { target: "store" as const, kind: "beverage", certain: true, reason: "판매용 음료 → 매점" };
  if (snack.test(name)) return { target: keep, kind: "snack", certain: true, reason: "과자·간식 · 현재 사업장 유지" };
  return { target: keep, kind: "unknown", certain: false, reason: "자동 판단 보류 · 현재 위치 유지" };
}
export async function purchaseRoutingPlan(
  state: PurchaseState,
  room: string,
  id: string,
  choices: Record<string, PurchaseTarget> = {},
) {
  if (!purchaseRooms.includes(room as any)) throw Error("invalid_purchase_room");
  const order = Object.values(state.orders || {}).filter(Array.isArray).flat()
    .find((o: any) => o.id === id) as any;
  if (!order || state.orderEdits?.[id]?.deleted) throw Error("purchase_missing");
  if (order.ocrMeta?.referenceOnly || order.ocrMeta?.duplicateReviewPending ||
      order.ocrMeta?.purchaseRoute?.routes) throw Error("purchase_not_active");
  const rows = (order.items || []).map((item: any, index: number) => {
    const key = item.id || String(index), suggested = classifyPurchaseItem(item, room);
    const target = choices[key] ?? suggested.target;
    if (!["food", "store", "fixed"].includes(target)) throw Error("invalid_purchase_target");
    return { key, index, name: String(item.name || ""), spec: String(item.spec || ""), qty: item.qty ?? null, amount: numeric(item.amt) ? item.amt : null, ...suggested, target, overridden: target !== suggested.target };
  });
  if (!rows.length || rows.length > 10000) throw Error("invalid_purchase_rows");
  if (Object.keys(choices).some((key) => !rows.some((r: any) => r.key === key))) throw Error("unknown_purchase_line");
  const targets = [...new Set<PurchaseTarget>(rows.map((r: any) => r.target))];
  const total = numeric(order.total)
    ? order.total
    : rows.every((r: any) => r.amount !== null)
    ? rows.reduce((n: number, r: any) => n + r.amount, 0) + (!order.ocrMeta && !(order.items || []).some((i: any) => Object.hasOwn(i, "supplyAmount")) && numeric(order.tax) ? order.tax : 0)
    : null;
  const splitKnown = total !== null && rows.every((r: any) => r.amount !== null) &&
    rows.reduce((n: number, r: any) => n + r.amount, 0) === total;
  const keep: PurchaseTarget = room === "namostore" ? "store" : "food";
  const moved = rows.some((r: any) => r.target !== keep);
  const parsedDate = typeof order.date === "string" ? new Date(order.date + "T12:00:00Z") : null;
  const validDate = typeof order.date === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(order.date) &&
    parsedDate && Number.isFinite(+parsedDate) && parsedDate.toISOString().slice(0, 10) === order.date;
  const requiresReview = rows.some((r: any) => !r.certain || r.overridden) ||
    !!order.coupang && targets.includes("fixed");
  return {
    room, id, vendor: String(order.vendor || ""), date: order.date,
    fingerprint: await hash({ order, edit: state.orderEdits?.[id] }),
    rows, targets, total, moved, requiresReview,
    canApply: moved && total !== null && validDate && !!String(order.vendor || "").trim() && !/업체\s*미입력|업체\s*미확인|공급업체\s*미확인/.test(order.vendor) &&
      (targets.length === 1 || splitKnown),
    reason: !validDate || !String(order.vendor || "").trim()
      ? "거래일·공급업체 확인 필요"
      : total === null ? "명세서 총액 확인 필요"
      : targets.length > 1 && !splitKnown
      ? "혼합 명세서의 품목 금액 합계가 총액과 일치해야 분리할 수 있습니다."
      : !moved ? "현재 사업장 유지" : requiresReview ? "확인 후 이동" : "자동 분류 가능",
  };
}
// Older admin clients must not drop server-created fixed-cost purchases.
export function preservePurchaseRouting(full: PurchaseState, incoming: PurchaseState) {
  for (const field of ["fixedPurchases", "purchaseRoutes"]) {
    if (full[field]) incoming[field] = clone(full[field]);
    else delete incoming[field];
  }
  const previous = new Map(Object.values(full.orders || {}).flat().map((o: any) => [o.id, o]));
  const seen = new Set();
  for (const order of Object.values(incoming.orders || {}).flat() as any[]) {
    seen.add(order.id);
    const old = previous.get(order.id) as any;
    if (!old?.ocrMeta?.purchaseRoute) {
      if (order.ocrMeta) delete order.ocrMeta.purchaseRoute;
      continue;
    }
    order.ocrMeta ||= {};
    order.ocrMeta.purchaseRoute = clone(old.ocrMeta.purchaseRoute);
    if (old.ocrMeta.purchaseRoute.routes) {
      for (const key of ["referenceOnly", "referenceAt", "referenceReason", "balanceEvidence"]) {
        if (Object.hasOwn(old.ocrMeta, key)) order.ocrMeta[key] = clone(old.ocrMeta[key]);
      }
    }
  }
  for (const [id, old] of previous) {
    if ((old as any).ocrMeta?.purchaseRoute && !seen.has(id) && !incoming.orderEdits?.[id]?.deleted) {
      ((incoming.orders ||= {})[(old as any).date.slice(0, 7)] ||= []).push(clone(old));
    }
  }
  return incoming;
}
export async function applyPurchaseRouting(
  states: Record<string, PurchaseState>,
  room: string,
  id: string,
  expected: string,
  choices: Record<string, PurchaseTarget>,
  confirmed: boolean,
  at: string,
) {
  const source = states[room];
  if (source.purchaseRoutes?.[id]) return { already: true, routes: source.purchaseRoutes[id].routes, touched: [] as string[] };
  const plan = await purchaseRoutingPlan(source, room, id, choices);
  if (plan.fingerprint !== expected) throw Error("purchase_changed");
  if (!plan.canApply) throw Error("purchase_amount_review_required");
  if (plan.requiresReview && !confirmed) throw Error("purchase_confirmation_required");
  const sourceOrder = Object.values(source.orders).flat().find((o: any) => o.id === id) as any;
  const operationId = await hash([room, id, plan.fingerprint]);
  const routes: { room: string; target: PurchaseTarget; id: string; total: number }[] = [];
  // Validate/build every child before mutating any state.
  const built = [];
  for (const target of plan.targets) {
    const targetRoom = target === "store" ? "namostore" : "namofood";
    if (!states[targetRoom]) throw Error("purchase_destination_missing");
    const childId = "routed-" + await hash([room, id, target]);
    const items = plan.rows.filter((r: any) => r.target === target).map((r: any) => clone(sourceOrder.items[r.index]));
    const whole = plan.targets.length === 1;
    const sum = (field: string) => items.every((i: any) => numeric(i[field]))
      ? items.reduce((n: number, i: any) => n + i[field], 0) : null;
    const total = whole ? plan.total! : sum("amt")!;
    const child = {
      ...clone(sourceOrder), id: childId, items,
      total, subtotal: whole ? sourceOrder.subtotal ?? null : sum("supplyAmount"),
      tax: whole ? sourceOrder.tax ?? null : sum("tax"),
      previousBalance: null, balanceTotal: null,
      ocrMeta: {
        ...(clone(sourceOrder.ocrMeta || {})), referenceOnly: false,
        registeredAt: at,
        purchaseRoute: { operationId, sourceRoom: room, sourceId: id, target, at },
      },
    };
    // Split receipts cannot guess how a payment covers separate business costs.
    if (!whole) for (const key of ["paymentCardId", "paymentMatchManualAt", "paymentMatchMeta"]) delete (child as any)[key];
    if (Object.values(states[targetRoom].orders || {}).flat().some((o: any) => o.id === childId) ||
        Object.values(states[targetRoom].fixedPurchases || {}).flat().some((o: any) => o.id === childId) ||
        states[targetRoom].orderEdits?.[childId]?.deleted) throw Error("purchase_destination_exists");
    routes.push({ room: targetRoom, target, id: childId, total });
    built.push({ targetRoom, target, child });
  }
  for (const { targetRoom, target, child } of built) {
    const dest = states[targetRoom], month = plan.date.slice(0, 7);
    if (target === "fixed") ((dest.fixedPurchases ||= {})[month] ||= []).push(child);
    else {
      ((dest.orders ||= {})[month] ||= []).push(child);
      (dest.orderEdits ||= {})[child.id] = { at, origin: "manual", deleted: false };
    }
  }
  sourceOrder.ocrMeta ||= {};
  Object.assign(sourceOrder.ocrMeta, {
    referenceOnly: true, referenceAt: at,
    referenceReason: "품목별 사업장·고정비 분류 완료 · 원본 보관 / 중복 합산 제외",
    balanceEvidence: sourceOrder.balanceTotal != null,
    purchaseRoute: { operationId, sourceRoom: room, sourceId: id, routes, at },
  });
  (source.orderEdits ||= {})[id] = { at, origin: "manual", deleted: false };
  (source.purchaseRoutes ||= {})[id] = { operationId, fingerprint: expected, routes, at };
  if(room === "namostore") for(const row of plan.rows.filter((r:any)=>r.target!=="store")) {
    const item=sourceOrder.items[row.index],identity=JSON.stringify(["purchase-line-v2",id,String(item?.id||"row-"+row.index)]);
    const linked=Object.values(source.storeProducts||{}).find((p:any)=>p.sourceIdentity===identity) as any;
    const productId=item?.storeProductId||linked?.id,product=source.storeProducts?.[productId];
    const stillStocked=Object.values(source.orders||{}).flat().some((o:any)=>o.id!==id&&!o.ocrMeta?.referenceOnly&&!source.orderEdits?.[o.id]?.deleted&&(o.items||[]).some((i:any)=>i.storeProductId===productId));
    if(product&&!stillStocked)source.storeProducts[productId]={...product,deleted:true,at};
  }
  return { already: false, routes, touched: [...new Set([room, ...routes.map((r) => r.room)])] };
}
