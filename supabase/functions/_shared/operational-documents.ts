// Shared procurement/ticket files only. Never authorize payroll or fixed-cost files.
export function operationalDocumentKind(root: string, id: string) {
  const part = id.slice(root.length);
  if (/^#invoice-photo#[a-f0-9]{64}$/.test(part)) return "invoice-photo";
  if (/^#invoice-file#[a-f0-9]{64}$/.test(part)) return "invoice-file";
  if (root === "namofood" && part === "#ticket-documents") {
    return "ticket-index";
  }
  if (root === "namofood" && /^#ticket-document#[a-f0-9]{64}$/.test(part)) {
    return "ticket-file";
  }
  if (root === "namofood" && /^#fixed-document#[a-f0-9]{64}$/.test(part)) {
    return "legacy-ticket-file";
  }
  return "";
}
const mimes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
export function ticketFiles(payload: any): any[] {
  if (
    payload?.v !== 1 || !Array.isArray(payload.files) ||
    payload.files.length > 10000 ||
    payload.files.some((f: any) =>
      !f || !/^[a-f0-9]{64}$/.test(f.hash) || typeof f.name !== "string" ||
      f.name.length > 200 || !mimes.has(f.mime) || !Number.isInteger(f.size) ||
      f.size <= 0 || f.size > 8 * 1024 * 1024
    )
  ) throw Error("invalid_ticket_documents");
  return payload.files;
}
export function invoiceFileReferenced(state: any, kind: string, hash: string) {
  const field = kind === "invoice-photo" ? "invoicePhoto" : "invoiceFile";
  const purchases = Object.values(state.orders || {}).filter(Array.isArray).flat();
  const classified = Object.values(state.fixedPurchases || {}).filter(Array.isArray).flat().filter((o:any)=>o?.ocrMeta?.purchaseRoute?.target==="fixed");
  return [...purchases,...classified].some((
    o: any,
  ) =>
    !state.orderEdits?.[o.id]?.deleted && o[field]?.hash === hash &&
    !o[field]?.deleted
  );
}
// Only unlinked Store invoice originals may be purged. Never accept arbitrary
// database row IDs, private files, other rooms or a partially valid batch.
export function storeInvoicePurgePlan(room: unknown, state: any, files: unknown) {
  if (room !== 'namostore' || !Array.isArray(files) || !files.length || files.length > 200 || files.some(f => !f || !['invoice-photo','invoice-file'].includes(f.kind) || typeof f.hash !== 'string' || !/^[a-f0-9]{64}$/.test(f.hash))) throw Error('invalid_invoice_purge');
  const unique = [...new Map(files.map(f=>[f.kind+'#'+f.hash,{kind:f.kind,hash:f.hash}])).values()];
  return {remove:unique.filter(f=>!invoiceFileReferenced(state,f.kind,f.hash)),retained:unique.filter(f=>invoiceFileReferenced(state,f.kind,f.hash))};
}
export async function validateOperationalBlob(
  payload: any,
  id: string,
  kind: string,
) {
  const allowed = kind === "invoice-photo"
    ? new Set(["image/jpeg"])
    : kind === "invoice-file"
    ? new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
      "text/tab-separated-values",
    ])
    : mimes;
  if (
    payload?.v !== 1 || !allowed.has(payload.mime) ||
    typeof payload.bytes !== "string" ||
    payload.bytes.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.bytes)
  ) throw Error("invalid_document");
  const bytes = Uint8Array.from(atob(payload.bytes), (c) => c.charCodeAt(0));
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (
    !bytes.length || bytes.length > 8 * 1024 * 1024 || !id.endsWith("#" + hash)
  ) throw Error("invalid_document_hash");
}
