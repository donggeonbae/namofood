export function equal(a: string, b: string) {
  const enc = new TextEncoder(), x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] || 0) ^ (y[i] || 0);
  }
  return diff === 0;
}
export async function statusSignature(
  password: string,
  year: string,
  time: string,
) {
  const enc = new TextEncoder(),
    key = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        enc.encode(`nmf-tax-status:${year}:${time}`),
      ),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
export async function statusAuthorized(
  request: Request,
  password: string,
  year: string,
  now = Date.now(),
) {
  const time = request.headers.get("x-nmf-time") || "",
    signature = request.headers.get("x-nmf-signature") || "";
  if (
    !password || !/^\d{13}$/.test(time) ||
    Math.abs(now - Number(time)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)
  ) return false;
  return equal(signature, await statusSignature(password, year, time));
}
