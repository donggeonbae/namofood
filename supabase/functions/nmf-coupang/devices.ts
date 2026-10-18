import { equal, signature } from "./protocol.mjs";
export function validDevice(value: any) {
  return !!value && /^[a-f0-9-]{36}$/.test(value.id || "") &&
    value.publicKey?.kty === "EC" && value.publicKey?.crv === "P-256" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.publicKey.x || "") &&
    /^[A-Za-z0-9_-]{43}$/.test(value.publicKey.y || "") && !value.publicKey.d;
}
const canonical = (device: any, expires: number) =>
  JSON.stringify({
    id: device.id,
    publicKey: {
      kty: "EC",
      crv: "P-256",
      x: device.publicKey.x,
      y: device.publicKey.y,
    },
    expires,
    room: "namostore",
    version: 1,
  });
export async function issueDevice(key: string, device: any, now = Date.now()) {
  if (!validDevice(device)) throw Error("invalid_device");
  const expires = now + 90 * 86400000;
  return {
    device: {
      id: device.id,
      publicKey: {
        kty: "EC",
        crv: "P-256",
        x: device.publicKey.x,
        y: device.publicKey.y,
        ext: true,
      },
    },
    expires,
    mac: await signature(key, "login-device", "v1", canonical(device, expires)),
  };
}
export async function verifyDevice(key: string, cert: any, now = Date.now()) {
  return validDevice(cert?.device) && Number.isSafeInteger(cert.expires) &&
    cert.expires > now && cert.expires <= now + 91 * 86400000 &&
    equal(
      cert.mac,
      await signature(
        key,
        "login-device",
        "v1",
        canonical(cert.device, cert.expires),
      ),
    );
}
