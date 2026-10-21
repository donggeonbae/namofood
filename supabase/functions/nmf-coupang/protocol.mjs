// Shared, dependency-free protocol. Never include credentials or browser cookies here.
const enc = new TextEncoder();
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0"))
    .join("");
export async function sha(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
export async function signature(secret, role, time, raw) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`nmf-coupang:${role}:${time}:${await sha(raw)}`),
    ),
  );
}
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let n = 0;
  for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return n === 0;
}
export function validDate(value) {
  if (typeof value !== "string" || !/^20\d\d-\d\d-\d\d$/.test(value)) {
    return false;
  }
  const n = Date.parse(value + "T12:00:00Z");
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value;
}
export function validRange(from, to) {
  return validDate(from) && validDate(to) && from <= to &&
    Date.parse(to) - Date.parse(from) <= 92 * 86400000;
}
export function cleanText(value, max = 40000) {
  return String(value ?? "").replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    "",
  )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[이메일 제외]")
    .replace(/\b01[016789][ -]?\d{3,4}[ -]?\d{4}\b/g, "[연락처 제외]")
    .split("\n").filter((line) =>
      !/(?:배송지|받는\s*사람|수령인|연락처|휴대폰|비밀번호|계좌번호|카드번호)\s*[:：]/
        .test(line)
    ).join("\n").slice(0, max).trim();
}
const squash = (value) =>
  String(value ?? "").normalize("NFKC").replace(/\s/g, "");
function money(value, evidence) {
  if (value == null || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1e10) {
    throw Error("invalid_order_amount");
  }
  return evidence.replace(/,/g, "").match(/\d+(?:\.\d+)?/g)?.includes(
      String(value),
    )
    ? value
    : null;
}
export function validateOrders(value, source, range) {
  if (
    !validRange(range.from, range.to) || !Array.isArray(value?.orders) ||
    value.orders.length > 100
  ) throw Error("invalid_orders");
  const text = squash(source), seen = new Set();
  return value.orders.map((order) => {
    if (
      !order || !/^\d{6,30}$/.test(order.orderNo || "") ||
      seen.has(order.orderNo) || !validDate(order.date) ||
      order.date < range.from || order.date > range.to
    ) throw Error("invalid_order_identity");
    if (
      typeof order.evidence !== "string" || order.evidence.length < 8 ||
      order.evidence.length > 20000 || !text.includes(squash(order.evidence))
    ) throw Error("ungrounded_order");
    const evidence = order.evidence;
    const [year, month, day] = order.date.split("-").map(Number);
    if (
      !new RegExp(`${year}\\D{0,4}0?${month}\\D{0,4}0?${day}(?!\\d)`).test(
        evidence,
      )
    ) throw Error("ungrounded_order_date");
    if (
      !text.includes(order.orderNo) ||
      !/배송\s*완료|구매\s*확정/.test(order.status || "") ||
      !squash(evidence).includes(squash(order.status)) ||
      /취소|반품|환불/.test(order.status)
    ) throw Error("ineligible_order");
    if (
      !Array.isArray(order.items) || !order.items.length ||
      order.items.length > 80
    ) throw Error("invalid_order_items");
    seen.add(order.orderNo);
    const items = order.items.map((item) => {
      const name = cleanText(item?.name, 240),
        spec = cleanText(item?.spec, 160),
        unit = cleanText(item?.unit, 20);
      if (!name || !squash(evidence).includes(squash(name))) {
        throw Error("ungrounded_item");
      }
      const qty = item.qty == null ? null : money(item.qty, evidence);
      if (qty !== null && qty <= 0) throw Error("invalid_order_quantity");
      return {
        name,
        spec: spec && squash(evidence).includes(squash(spec)) ? spec : "",
        qty,
        unit: unit && squash(evidence).includes(squash(unit)) ? unit : "",
        price: money(item.price, evidence),
        amt: money(item.amt, evidence),
      };
    });
    return {
      orderNo: order.orderNo,
      date: order.date,
      status: order.status,
      total: money(order.total, evidence),
      items,
    };
  });
}
async function cipherKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      enc.encode("nmf-coupang-result-v1:" + secret),
    ),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
const to64 = (bytes) =>
  btoa(
    Array.from(new Uint8Array(bytes), (b) => String.fromCharCode(b)).join(""),
  );
const from64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export async function seal(secret, jobId, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(jobId) },
    await cipherKey(secret),
    enc.encode(JSON.stringify(data)),
  );
  return to64(iv) + "." + to64(ciphertext);
}
export async function unseal(secret, jobId, value) {
  const [iv, ciphertext] = String(value).split(".");
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: from64(iv), additionalData: enc.encode(jobId) },
        await cipherKey(secret),
        from64(ciphertext),
      ),
    ),
  );
}
