import { createHandler } from "../supabase/functions/nmf-coupang/handler.ts";
import {
  issueDevice,
  verifyDevice,
} from "../supabase/functions/nmf-coupang/devices.ts";
import {
  seal,
  signature,
  unseal,
} from "../supabase/functions/nmf-coupang/protocol.mjs";
const assert = (ok: unknown, label: string) => {
  if (!ok) throw Error(label);
};
const workerKey = "isolated-test-worker-key", pw = "isolated-test-app-password";
const keys = await crypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" },
  false,
  ["deriveBits"],
);
const device = {
  id: crypto.randomUUID(),
  publicKey: await crypto.subtle.exportKey("jwk", keys.publicKey),
};
const cert = await issueDevice(workerKey, device);
assert(await verifyDevice(workerKey, cert), "issued certificate verifies");
assert(
  !await verifyDevice(workerKey, { ...cert, expires: cert.expires + 1 }),
  "certificate expiry cannot be changed",
);
assert(
  !await verifyDevice("wrong", cert),
  "certificate issuer is authenticated",
);
let queued: any = null, saved: any = null, kind = "pair";
const queue = {
  info: async () => ({ online: true }),
  enqueue: async (
    id: string,
    k: string,
    _f: null,
    _t: null,
    ciphertext: string,
  ) => {
    queued = { id, kind: k, payloadCiphertext: ciphertext };
    return id;
  },
  claim: async () => structuredClone(queued),
  beginFinish: async () => ({
    kind,
    payload_ciphertext: queued.payloadCiphertext,
  }),
  done: async (id: string, _lease: string, text: string) => {
    saved = await unseal(workerKey, id, text);
  },
  fail: async () => {},
};
const handler = createHandler({
  env: (key) => ({
    "NMF_PW": pw,
    "NMF_COUPANG_WORKER_TOKEN": workerKey,
    "SUPABASE_ANON_KEY": "test-public-key",
    "NMF_ADMIN_HASH": "configured-admin-hash-for-isolated-test",
  }[key] || ""),
  queue,
});
async function request(role: string, action: string, extra: any = {}) {
  const raw = JSON.stringify({
      role,
      action,
      room: "namostore",
      nonce: crypto.randomUUID(),
      ...extra,
    }),
    time = String(Date.now());
  return handler(
    new Request("https://example.test", {
      method: "POST",
      headers: {
        origin: "https://d-bae.com",
        "content-type": "application/json",
        "x-nmf-time": time,
        "x-nmf-signature": await signature(
          role === "app" ? pw : workerKey,
          role,
          time,
          raw,
        ),
      },
      body: raw,
    }),
  );
}
assert(
  (await request("app", "remote_login", { certificate: {} })).status === 403,
  "unpaired app users cannot remote-control",
);
assert(
  (await request("app", "pair", {
    device: {
      ...device,
      publicKey: { ...device.publicKey, d: "private-material" },
    },
  })).status === 400,
  "never accept a private key",
);
assert(
  (await request("app", "pair", { device })).status === 200,
  "public-key pairing can be requested",
);
let job = queued;
assert(
  !JSON.stringify(queued).includes(device.publicKey.x!),
  "device handshake encrypted at rest",
);
let claim = await (await request("worker", "claim")).json();
assert(
  claim.job.payload.device.id === device.id,
  "only signed worker receives pairing metadata",
);
await request("worker", "finish", {
  jobId: job.id,
  lease: crypto.randomUUID(),
  approved: false,
});
assert(
  saved.denied === true && !saved.certificate,
  "denial never issues a certificate",
);
await request("worker", "finish", {
  jobId: job.id,
  lease: crypto.randomUUID(),
  approved: true,
});
assert(
  await verifyDevice(workerKey, saved.certificate),
  "worker approval issues bound device certificate",
);
assert(
  (await request("app", "remote_login", {
    certificate: saved.certificate,
    width: 390,
  })).status === 200,
  "approved device may request login",
);
job = queued;
kind = "remote_login";
claim = await (await request("worker", "claim")).json();
assert(
  claim.job.relay.key === "test-public-key",
  "worker receives public realtime connection, not service role",
);
await request("worker", "finish", {
  jobId: job.id,
  lease: crypto.randomUUID(),
  session: {
    id: job.id,
    topic: "nmf-login-" + "a".repeat(64),
    publicKey: device.publicKey,
    expires: Date.now() + 290000,
    width: 390,
    height: 760,
  },
});
assert(
  saved.session?.id === job.id && saved.relay?.key === "test-public-key",
  "viewer receives only public handshake metadata",
);
console.log(
  "COUPANG_WEB_LOGIN_APPROVAL_CERT_BINDING_PRIVATE_KEY_REJECTION_HANDSHAKE_ENCRYPTION_OK",
);
