import {
  candidatesFrom,
  reviewPayments,
  sha,
  signature,
  validateMatches,
} from "../supabase/functions/nmf-payment-match/lib.ts";
const assert = (value: boolean, message: string) => {
  if (!value) throw Error(message);
};
const candidate = {
  invoiceId: "i1",
  cardId: "c1",
  invoiceDate: "2026-10-12",
  cardDate: "2026-10-12",
  vendor: "검증푸드",
  merchant: "검증푸드",
  amount: 11000,
};
const c = candidatesFrom([candidate]);
const decision = {
  matches: [{
    invoiceId: "i1",
    cardId: "c1",
    confidence: "high",
    reason: "업체·날짜·금액 일치",
  }],
};
assert(validateMatches(decision, c)[0].automatic, "unique candidate auto");
assert(
  !validateMatches(
    decision,
    candidatesFrom([candidate, { ...candidate, cardId: "c2" }]),
  )[0].automatic,
  "multiple cards manual review",
);
assert(
  !validateMatches(
    decision,
    candidatesFrom([candidate, { ...candidate, invoiceId: "i2" }]),
  )[0].automatic,
  "multiple invoices manual review",
);
let rejected = 0;
for (
  const bad of [{ matches: [{ ...decision.matches[0], cardId: "unknown" }] }, {
    matches: [decision.matches[0], decision.matches[0]],
  }]
) {
  try {
    validateMatches(bad, c);
  } catch {
    rejected++;
  }
}
assert(rejected === 2, "unknown IDs and one-to-many rejected");
assert(
  await signature("pw", "namofood", "123", await sha("a")) !==
    await signature("pw", "namofood", "123", await sha("b")),
  "full body authenticated",
);
let calls = 0;
const fake = ((_url: unknown, options: RequestInit) => {
  calls++;
  const request = JSON.parse(String(options.body));
  assert(
    /JSON/.test(request.messages[0].content[0].text),
    "JSON mode input requirement",
  );
  assert(
    !String(options.body).includes("approvalNo"),
    "approval/card numbers excluded",
  );
  return Promise.resolve(
    new Response(
      JSON.stringify({
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(decision) }],
        }],
      }),
    ),
  );
}) as typeof fetch;
assert(
  (await reviewPayments(c, "test", fake))[0].automatic && calls === 1,
  "one provider request and validated decision",
);
console.log(
  "PAYMENT_AI_UNIQUE_VS_AMBIGUOUS_ONE_TO_ONE_HMAC_NO_CARD_NUMBERS_SINGLE_PROVIDER_OK",
);
