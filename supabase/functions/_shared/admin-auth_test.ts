import { adminAuthorized, issueAdmin, passwordValid } from "./admin-auth.ts";
const assert = (v: unknown) => {
  if (!v) throw Error("assertion failed");
};
Deno.test("admin token rejects guest, tampering, expiry, missing configuration", async () => {
  const env = (
    k: string,
  ) => ({
    NMF_ADMIN_HASH: "configured",
    NMF_ADMIN_TOKEN_SECRET: "unit-secret",
  }[k] || "");
  assert(!await adminAuthorized(new Request("https://example.test"), env));
  const { token } = await issueAdmin("unit-secret"),
    request = (t: string) =>
      new Request("https://example.test", {
        headers: { "x-nmf-admin-session": t },
      });
  assert(await adminAuthorized(request(token), env));
  assert(!await adminAuthorized(request(token + "x"), env));
  assert(
    !await adminAuthorized(
      request(
        (await issueAdmin("unit-secret", Date.now() - 5 * 3600000)).token,
      ),
      env,
    ),
  );
  assert(!await adminAuthorized(request(token), () => ""));
});
Deno.test("PBKDF2 verifier checks hash without storing raw password", async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode("test-only"),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 },
    key,
    256,
  );
  const b64 = (v: Uint8Array) => btoa(String.fromCharCode(...v));
  const hash = "600000:" + b64(salt) + ":" + b64(new Uint8Array(bits));
  assert(await passwordValid("test-only", hash));
  assert(!await passwordValid("wrong", hash));
  assert(!await passwordValid("test-only", "malformed"));
});
