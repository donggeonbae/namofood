import {
  invoiceFileReferenced,
  operationalDocumentKind,
  ticketFiles,
  validateOperationalBlob,
} from "../supabase/functions/_shared/operational-documents.ts";
import { createHandler } from "../supabase/functions/nmf-invoice-ocr/index.ts";
const assert = (v: unknown) => {
  if (!v) throw Error("operational document/auth assertion");
};
const bytes = new TextEncoder().encode("%PDF-1.4 test"),
  hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join(""),
  file = {
    v: 1,
    mime: "application/pdf",
    bytes: btoa(String.fromCharCode(...bytes)),
  };
assert(
  operationalDocumentKind("namofood", "namofood#ticket-document#" + hash) ===
    "ticket-file",
);
assert(!operationalDocumentKind("namocafe", "namocafe#ticket-documents"));
assert(!operationalDocumentKind("namofood", "namofood#staff-a-documents"));
assert(!operationalDocumentKind("namofood", "namofood#fixed-documents"));
await validateOperationalBlob(
  file,
  "namofood#ticket-document#" + hash,
  "ticket-file",
);
let failed = false;
try {
  await validateOperationalBlob(
    file,
    "namofood#ticket-document#" + "a".repeat(64),
    "ticket-file",
  );
} catch {
  failed = true;
}
assert(failed);
const state = {
  orders: { "2026-10": [{ id: "a", invoicePhoto: { hash } }] },
  orderEdits: {},
};
assert(invoiceFileReferenced(state, "invoice-photo", hash));
assert(!invoiceFileReferenced(state, "invoice-file", hash));
const fixedState={orders:{},fixedPurchases:{"2026-10":[{id:"routed",invoicePhoto:{hash},ocrMeta:{purchaseRoute:{target:"fixed"}}}]}};
assert(invoiceFileReferenced(fixedState,"invoice-photo",hash));
assert(!invoiceFileReferenced({orders:{},fixedPurchases:{"2026-10":[{id:"private-contract",invoicePhoto:{hash}}]}},"invoice-photo",hash));
assert(!invoiceFileReferenced({orders:{},fixedDocuments:[{invoicePhoto:{hash}}]},"invoice-photo",hash));
assert(!invoiceFileReferenced({...fixedState,orderEdits:{routed:{deleted:true}}},"invoice-photo",hash));
assert(
  ticketFiles({
    v: 1,
    files: [{ hash, mime: file.mime, size: bytes.length, name: "식권.pdf" }],
  }).length === 1,
);
const pw = "test-only",
  env = (
    k: string,
  ) => ({
    NMF_PW: pw,
    NMF_ADMIN_HASH: "configured",
    OPENCODE_API_KEY: "test-only",
    NMF_INVOICE_LABEL_REVIEW: "0",
  }[k] || "");
let calls = 0;
const handler = createHandler({
  env,
  fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            date: "2026-10-19",
            vendor: "공급사",
            total: 1000,
            items: [{
              name: "양파",
              qty: 1,
              unit: "kg",
              price: 1000,
              amt: 1000,
            }],
            rawText: "양파 1000",
          }),
        }],
      }],
    }));
  },
});
async function request(
  action: string,
  documentType = "invoice",
  signed = true,
) {
  const raw = JSON.stringify({
      app: "food",
      action,
      documentType,
      nonce: crypto.randomUUID(),
      ...(action === "extract"
        ? {
          image: {
            mime: "image/png",
            data:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=",
          },
        }
        : {}),
    }),
    time = String(Date.now()),
    hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join(""),
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pw),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    sig = Array.from(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode("nmf-invoice:" + hash + ":" + time),
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  return new Request("https://test/nmf-invoice-ocr", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://d-bae.com",
      "x-nmf-time": time,
      "x-nmf-signature": signed ? sig : "0".repeat(64),
    },
    body: raw,
  });
}
assert((await handler(await request("status"))).status === 200);
assert(calls === 0);
assert((await handler(await request("status", "card"))).status === 403);
assert(
  (await handler(await request("status", "invoice", false))).status === 401,
);
const extracted = await handler(await request("extract"));
if (extracted.status !== 200) {
  throw Error(
    "fixture OCR " + extracted.status + ": " + await extracted.text(),
  );
}
assert(calls === 2); // Extraction and the existing separate label review.
console.log(
  "OPERATIONAL_DOCUMENT_NAMESPACES_HASH_LIMITS_PRIVATE_DENIAL_SIGNED_INVOICE_OCR_CARD_ADMIN_AUTH_OK",
);
