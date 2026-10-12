// Retired: event-based tax_auto_queue supersedes the nightly scheduler.
import { equal } from "./auth.ts";
Deno.serve((request) => {
  const secret = (Deno.env.get("NMF_CRON_SECRET") || "").trim();
  if (
    !secret ||
    !equal(request.headers.get("authorization") || "", "Bearer " + secret)
  ) {
    return Response.json({ ok: false, reason: "unauthorized" }, {
      status: 401,
    });
  }
  return Response.json({
    ok: false,
    reason: "nightly_retired",
    replacement: "nmf-tax-auto",
  }, { status: 410 });
});
