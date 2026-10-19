import { sql } from "./database.ts";
import { decryptText, encryptText } from "../nmf-recipe-fill/lib.ts";
import { applyInvoiceLedger, invoiceLedgerPlan } from "./invoice-ledger.ts";
import { purchaseRooms } from "./purchase-routing.ts";

const messages: Record<string, string> = {
  ledger_changed: "검토 중 발주가 변경됐습니다. 다시 대조해 주세요.",
  ledger_source_required: "엑셀 원본을 보관한 뒤 다시 대조해 주세요.",
  ledger_missing: "검토할 엑셀 발주가 없습니다.",
  ledger_amount_review:
    "업체·날짜·품목 합계를 확인해 주세요. 기존 발주는 변경하지 않았습니다.",
  ledger_confirmation_required: "일부 중복·불확실한 거래는 확인 후 반영합니다.",
  purchase_original_missing:
    "연결된 원본을 찾지 못했습니다. 기존 발주를 유지합니다.",
  purchase_destination_missing: "받을 사업장 서버를 먼저 연결해 주세요.",
};
export async function handleInvoiceLedger(
  body: any,
  pw: string,
  db: Pick<typeof sql, "begin"> = sql,
) {
  if (
    !purchaseRooms.includes(body.room) ||
    !["preview", "apply"].includes(body.mode) || typeof body.id !== "string" ||
    !body.id || body.id.length > 200 ||
    body.choices != null &&
      (typeof body.choices !== "object" || Array.isArray(body.choices) ||
        Object.keys(body.choices).length > 1000) ||
    body.mode === "apply" &&
      (!/^[a-f0-9]{64}$/.test(body.fingerprint || "") ||
        !Array.isArray(body.replace) || body.replace.length > 1000 ||
        body.replace.some((k: any) => typeof k !== "string" || k.length > 450))
  ) return { status: 400, data: { error: "invalid_ledger_request" } };
  try {
    // Same lock order as purchase-route; preview is consistent across both rooms.
    const result = await db.begin(async (tx) => {
      const rows =
        await tx`select id,data,updated_at from public.namofood_state where id in ('namofood','namostore') order by id for update`;
      const states: Record<string, any> = {};
      for (const row of rows) {
        states[String(row.id)] = JSON.parse(
          await decryptText(pw, String(row.data)),
        );
      }
      if (!states[body.room]) throw Error("ledger_missing");
      if (body.mode === "preview") {
        return await invoiceLedgerPlan(
          states,
          body.room,
          body.id,
          body.choices || {},
        );
      }
      const original =
        (Object.values(states[body.room].orders || {}).flat() as any[]).find(
          (o) => o.id === body.id,
        );
      const at = new Date(
        Math.max(
          Date.now(),
          ...rows.map((row) => Date.parse(String(row.updated_at)) + 1),
        ),
      ).toISOString();
      const outcome = await applyInvoiceLedger(
        states,
        body.room,
        body.id,
        body.fingerprint,
        body.replace,
        body.choices || {},
        body.confirmed === true,
        at,
      );
      if (outcome.already) return outcome;
      for (const room of outcome.touched) {
        const before = rows.find((row) => row.id === room);
        if (!before) throw Error("purchase_destination_missing");
        await tx`insert into public.namofood_state(id,data,updated_at) values(${
          room + "@ledger-" + body.fingerprint.slice(0, 32)
        },${String(before.data)},${at}) on conflict(id)do nothing`;
      }
      for (
        const room of new Set<string>(outcome.routes!.map((r: any) => r.room))
      ) {
        if (room === body.room) continue;
        for (
          const [field, tag] of [["invoiceFile", "invoice-file"], [
            "invoicePhoto",
            "invoice-photo",
          ]]
        ) {
          const meta = original?.[field];
          if (!meta || meta.deleted) continue;
          if (!/^[a-f0-9]{64}$/.test(meta.hash || "")) {
            throw Error("purchase_original_missing");
          }
          const [blob] =
            await tx`select data from public.namofood_state where id=${
              body.room + "#" + tag + "#" + meta.hash
            }`;
          if (!blob) throw Error("purchase_original_missing");
          await tx`insert into public.namofood_state(id,data,updated_at) values(${
            room + "#" + tag + "#" + meta.hash
          },${String(blob.data)},${at}) on conflict(id)do nothing`;
        }
      }
      for (const room of outcome.touched) {
        states[room].updatedAt = at;
        const cipher = await encryptText(pw, JSON.stringify(states[room]));
        await tx`update public.namofood_state set data=${cipher},updated_at=${at} where id=${room}`;
      }
      return outcome;
    });
    return { status: 200, data: { ok: true, ...result } };
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    return {
      status: code === "ledger_changed" ? 409 : 400,
      data: {
        error: messages[code] ||
          "원본과 기존 발주는 유지됩니다. 다시 확인해 주세요.",
        code: Object.hasOwn(messages, code) ? code : "ledger_failed",
      },
    };
  }
}
