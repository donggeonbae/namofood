import {
  statusAuthorized,
  statusSignature,
} from "../supabase/functions/nmf-tax-nightly/auth.ts";
const time = Date.now(),
  year = "2026",
  signature = await statusSignature("fixture", year, String(time)),
  request = (sig = signature, t = time) =>
    new Request("https://example.test", {
      headers: { "x-nmf-time": String(t), "x-nmf-signature": sig },
    });
if (!await statusAuthorized(request(), "fixture", year, time)) {
  throw Error("signed read denied");
}
if (
  await statusAuthorized(request(), "wrong", year, time) ||
  await statusAuthorized(request(), "fixture", "2027", time) ||
  await statusAuthorized(request(), "fixture", year, time + 60001) ||
  await statusAuthorized(request("0".repeat(64)), "fixture", year, time)
) throw Error("forged/stale status read allowed");
console.log("TAX_STATUS_AUTH_PASSWORD_YEAR_TIMESTAMP_SIGNATURE_FAIL_CLOSED_OK");
