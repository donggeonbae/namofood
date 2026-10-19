import { readState, sql } from "./database.ts";
import { decryptText, encryptText } from "../nmf-recipe-fill/lib.ts";
import { applyPurchaseRouting, purchaseRooms, purchaseRoutingPlan } from "./purchase-routing.ts";
const messages: Record<string, string> = {
  purchase_changed: "발주가 수정됐습니다. 분류 제안을 새로 불러와 확인해 주세요.",
  purchase_amount_review_required: "거래일·업체·품목 합계와 총액을 확인한 뒤 분리해 주세요.",
  purchase_confirmation_required: "기존 발주·쿠팡 비식재료·판단이 애매한 품목은 확인 후 이동합니다.",
  purchase_destination_missing: "받을 사업장의 서버 자료를 먼저 연결해 주세요.",
  purchase_destination_exists: "이미 이동된 품목이 있거나 삭제됐습니다. 중복 생성하지 않았습니다.",
  purchase_not_active: "보관용·중복 확인 중인 명세서는 이동하지 않습니다. 현재 집계 중인 발주를 선택해 주세요.",
  purchase_original_missing: "연결된 원본을 찾지 못했습니다. 이동하지 않았습니다.",
};
export async function handlePurchaseRouting(body: any, pw: string) {
  try {
    if (!purchaseRooms.includes(body.room) || !["preview", "apply"].includes(body.mode)) {
      return { status: 400, data: { error: "invalid_purchase_routing" } };
    }
    if (body.choices != null && (typeof body.choices !== "object" || Array.isArray(body.choices) || Object.keys(body.choices).length > 10000)) {
      return { status: 400, data: { error: "invalid_purchase_selection" } };
    }
    if (body.mode === "preview") {
      if (typeof body.month !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(body.month)) {
        return { status: 400, data: { error: "invalid_month" } };
      }
      const [row] = await readState("namofood_state", body.room);
      if (!row) return { status: 200, data: { plans: [], more: false } };
      const state = JSON.parse(await decryptText(pw, String(row.data)));
      const candidates = (state.orders?.[body.month] || []).filter((o: any) =>
        (!body.orderId || o.id === body.orderId) &&
        !state.orderEdits?.[o.id]?.deleted && !o.ocrMeta?.referenceOnly &&
        !o.ocrMeta?.duplicateReviewPending && !o.ocrMeta?.purchaseRoute?.routes
      );
      const offset = body.cursor ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return {status:400,data:{error:"invalid_cursor"}};
      const plans = [];
      for (const order of candidates.slice(offset, offset + 40)) plans.push(await purchaseRoutingPlan(state, body.room, order.id, body.orderId ? body.choices || {} : {}));
      return { status: 200, data: { plans, more: candidates.length > offset + 40, nextCursor: offset + 40 } };
    }
    if (typeof body.id !== "string" || body.id.length > 200 ||
        !/^[a-f0-9]{64}$/.test(body.fingerprint || "") ||
        body.choices != null && (typeof body.choices !== "object" || Array.isArray(body.choices) || Object.keys(body.choices).length > 10000)) {
      return { status: 400, data: { error: "invalid_purchase_selection" } };
    }
    const result = await sql.begin(async (tx) => {
      // Every cross-business move acquires the same two row locks in order.
      const rows = await tx`select id,data,updated_at from public.namofood_state
        where id in ('namofood','namostore') order by id for update`;
      const states: Record<string, any> = {};
      for (const row of rows) states[String(row.id)] = JSON.parse(await decryptText(pw, String(row.data)));
      if (!states[body.room]) throw Error("purchase_missing");
      const original = Object.values(states[body.room].orders || {}).flat().find((o: any) => o.id === body.id) as any;
      if (!original) throw Error("purchase_missing");
      if (!body.auto && body.confirmed !== true) throw Error("purchase_confirmation_required");
      if (body.auto && !states[body.room].purchaseRoutes?.[body.id]) {
        const age = Date.now() - Date.parse(original.ocrMeta?.registeredAt || original.coupang?.importedAt || "");
        if (!Number.isFinite(age) || age < 0 || age > 300000) throw Error("purchase_confirmation_required");
      }
      const at = new Date(Math.max(Date.now(), ...rows.map((row) => Date.parse(String(row.updated_at)) + 1))).toISOString();
      const outcome = await applyPurchaseRouting(states, body.room, body.id, body.fingerprint, body.choices || {}, body.confirmed === true, at);
      if (outcome.already) return outcome;
      const operationId = states[body.room].purchaseRoutes[body.id].operationId;
      for (const room of outcome.touched) {
        const before = rows.find((r) => r.id === room)!;
        await tx`insert into public.namofood_state(id,data,updated_at)
          values(${room + "@purchase-route-" + operationId},${String(before.data)},${at})
          on conflict(id)do nothing`;
      }
      // Preserve encrypted originals in every destination namespace. No public
      // storage, unlinked-file read permission, or plaintext upload is introduced.
      for (const room of new Set<string>(outcome.routes.map((r: { room: string }) => r.room))) {
        if (room === body.room) continue;
        for (const [field, tag] of [["invoiceFile", "invoice-file"], ["invoicePhoto", "invoice-photo"]]) {
          const meta = original[field];
          if (!meta || meta.deleted) continue;
          if (!/^[a-f0-9]{64}$/.test(meta.hash || "")) throw Error("purchase_original_missing");
          const [blob] = await tx`select data from public.namofood_state where id=${body.room + "#" + tag + "#" + meta.hash}`;
          if (!blob) throw Error("purchase_original_missing");
          await tx`insert into public.namofood_state(id,data,updated_at)
            values(${room + "#" + tag + "#" + meta.hash},${String(blob.data)},${at})
            on conflict(id)do nothing`;
        }
      }
      for (const room of outcome.touched) {
        states[room].updatedAt = at;
        const data = await encryptText(pw, JSON.stringify(states[room]));
        await tx`update public.namofood_state set data=${data},updated_at=${at} where id=${room}`;
      }
      return outcome;
    });
    return { status: 200, data: { ok: true, ...result } };
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    return { status: code === "purchase_changed" ? 409 : 400, data: {
      error: messages[code] || "분류 저장을 완료하지 못했습니다. 원본과 기존 발주는 유지됩니다.",
      code: Object.hasOwn(messages, code) ? code : "purchase_routing_failed",
    } };
  }
}
