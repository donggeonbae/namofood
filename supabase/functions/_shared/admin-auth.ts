const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const equal = (a: string, b: string) => {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
};
export async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))),
  );
}
export async function passwordValid(password: string, hash: string) {
  try {
    const [iterations, salt, digest] = hash.split(":");
    if (Number(iterations) !== 600000) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: bytes(salt),
        iterations: 600000,
      },
      key,
      256,
    );
    return equal(b64(new Uint8Array(bits)), digest);
  } catch {
    return false;
  }
}
export async function issueAdmin(secret: string, now = Date.now()) {
  const payload = btoa(
    JSON.stringify({
      role: "admin",
      exp: now + 4 * 3600000,
      nonce: crypto.randomUUID(),
    }),
  );
  return {
    token: payload + "." + await hmac(secret, payload),
    expiresAt: now + 4 * 3600000,
  };
}
export async function adminAuthorized(
  request: Request,
  env = (k: string) => Deno.env.get(k) || "",
) {
  if (!env("NMF_ADMIN_HASH")) return false;
  const secret = env("NMF_ADMIN_TOKEN_SECRET");
  if (!secret) return false;
  try {
    const [payload, signature, ...extra] =
      (request.headers.get("x-nmf-admin-session") || "").split(".");
    if (
      extra.length || !payload || !signature ||
      !equal(signature, await hmac(secret, payload))
    ) return false;
    const data = JSON.parse(atob(payload));
    return data.role === "admin" && Number.isFinite(data.exp) &&
      data.exp > Date.now() && data.exp <= Date.now() + 4 * 3600000 + 300000;
  } catch {
    return false;
  }
}
