import { equal, seal, signature, unseal, validRange } from "./protocol.mjs";
import { organize } from "./ai.ts";
import { issueDevice, validDevice, verifyDevice } from "./devices.ts";
type Dependencies = {
  env: (key: string) => string;
  queue: any;
  fetcher?: typeof fetch;
  now?: () => number;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const origins = new Set(["https://d-bae.com", "https://donggeonbae.github.io"]);
const codes = new Set([
  "login_required",
  "blocked",
  "no_order_evidence",
  "browser_read_failed",
  "worker_timeout",
  "ai_not_configured",
  "ai_incomplete",
  "ai_invalid_response",
  "invalid_snapshot",
  "snapshot_too_large",
  "invalid_orders",
  "invalid_order_identity",
  "ungrounded_order",
  "ungrounded_order_date",
  "ineligible_order",
  "invalid_order_items",
  "ungrounded_item",
  "invalid_order_amount",
  "invalid_order_quantity",
  "rate_limited",
]);
export function createHandler(
  { env, queue, fetcher = fetch, now = Date.now }: Dependencies,
) {
  return async (request: Request) => {
    const origin = request.headers.get("origin") || "",
      headers = new Headers({
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "apikey,content-type,x-nmf-time,x-nmf-signature",
      });
    if (origins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { headers, status });
    if (origin && !origins.has(origin)) {
      return json({ ok: false, error: "허용되지 않은 홈페이지입니다." }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { headers, status: 204 });
    }
    if (request.method !== "POST") return json({ ok: false }, 405);
    let raw = "", size = 0;
    const reader = request.body?.getReader();
    if (!reader) return json({ ok: false }, 400);
    const chunks: Uint8Array[] = [];
    while (true) {
      const v = await reader.read();
      if (v.done) break;
      size += v.value.length;
      if (size > 180000) {
        await reader.cancel();
        return json({ ok: false }, 413);
      }
      chunks.push(v.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    raw = new TextDecoder().decode(bytes);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false }, 400);
    }
    const role = body?.role,
      time = request.headers.get("x-nmf-time") || "",
      workerKey = env("NMF_COUPANG_WORKER_TOKEN"),
      secret = role === "worker"
        ? workerKey
        : role === "app"
        ? env("NMF_PW")
        : "";
    if (
      !secret || !/^\d{13}$/.test(time) ||
      Math.abs(now() - Number(time)) > 60000 || !UUID.test(body.nonce || "") ||
      !equal(
        request.headers.get("x-nmf-signature") || "",
        await signature(secret, role, time, raw),
      )
    ) return json({ ok: false, error: "요청 인증을 확인해 주세요." }, 401);
    if (!workerKey) {
      return json(
        { ok: false, error: "맥미니 연결 서버 설정이 필요합니다." },
        503,
      );
    }
    try {
      if (role === "app") {
        if (body.room !== "namostore") return json({ ok: false }, 403);
        if (body.action === "pair" || body.action === "remote_login") {
          if (env("NMF_COUPANG_WEB_LOGIN_DISABLED") === "1") {
            return json({
              ok: false,
              error: "웹앱 쿠팡 로그인이 관리자 설정으로 중지됐습니다.",
            }, 503);
          }
          if (!(await queue.info()).online) {
            return json({
              ok: false,
              error: "맥미니 연결 프로그램을 확인해 주세요.",
            }, 409);
          }
          if (!env("SUPABASE_ANON_KEY")) {
            return json({
              ok: false,
              error: "실시간 로그인 서버 설정이 필요합니다.",
            }, 503);
          }
          if (body.action === "pair" && !validDevice(body.device)) {
            return json({ ok: false }, 400);
          }
          if (
            body.action === "remote_login" &&
            !await verifyDevice(workerKey, body.certificate, now())
          ) {
            return json({
              ok: false,
              error: "이 기기는 아직 승인되지 않았거나 승인이 만료됐습니다.",
            }, 403);
          }
          const width = body.width === 390 ? 390 : 980;
          const original = body.action === "pair"
            ? body.device
            : body.certificate.device;
          const device = {
            id: original.id,
            publicKey: {
              kty: "EC",
              crv: "P-256",
              x: original.publicKey.x,
              y: original.publicKey.y,
              ext: true,
            },
          };
          const payload = body.action === "pair" ? { device } : {
            certificate: {
              device,
              expires: body.certificate.expires,
              mac: body.certificate.mac,
            },
            width,
          };
          const jobId = await queue.enqueue(
            body.nonce,
            body.action,
            null,
            null,
            await seal(workerKey, body.nonce, payload),
          );
          return json({ ok: true, jobId });
        }
        if (body.action === "status" || body.action === "result") {
          const worker = await queue.info();
          let job = null;
          if (body.jobId && !UUID.test(body.jobId)) {
            return json({ ok: false }, 400);
          }
          {
            const row = body.jobId
              ? await queue.get(body.jobId)
              : body.action === "status"
              ? await queue.latest()
              : null;
            if (row) {
              job = {
                id: row.id,
                status: row.status,
                stage: row.stage,
                progress: row.progress,
                code: row.error_code,
                createdAt: row.created_at,
                completedAt: row.completed_at,
                ...(row.status === "done" && row.result_ciphertext
                  ? {
                    result: await unseal(
                      workerKey,
                      row.id,
                      row.result_ciphertext,
                    ),
                  }
                  : {}),
              };
            }
          }
          return json({ ok: true, worker, job });
        }
        if (
          !["start", "login"].includes(body.action) ||
          body.action === "start" && !validRange(body.from, body.to)
        ) {
          return json(
            { ok: false, error: "조회 기간은 최대 93일입니다." },
            400,
          );
        }
        if (!(await queue.info()).online) {
          return json({
            ok: false,
            error:
              "맥미니 연결 프로그램이 꺼져 있습니다. 맥미니의 전원·연결 상태를 확인해 주세요.",
          }, 409);
        }
        const jobId = await queue.enqueue(
          body.nonce,
          body.action === "login" ? "login" : "import",
          body.action === "start" ? body.from : null,
          body.action === "start" ? body.to : null,
        );
        return json({ ok: true, jobId });
      }
      if (body.action === "heartbeat") {
        if (
          !["ready", "login_required", "blocked", "error"].includes(
            body.state,
          ) || body.jobId && (!UUID.test(body.jobId) || !UUID.test(body.lease))
        ) return json({ ok: false }, 400);
        await queue.heartbeat(body.state, body.jobId, body.lease);
        return json({ ok: true });
      }
      if (body.action === "claim") {
        const job = await queue.claim();
        if (job?.payloadCiphertext) {
          job.payload = await unseal(workerKey, job.id, job.payloadCiphertext);
          delete job.payloadCiphertext;
        }
        if (job?.kind === "remote_login") {
          job.relay = {
            url: "wss://rycibsczsgbkgtwfxyim.supabase.co/realtime/v1/websocket",
            key: env("SUPABASE_ANON_KEY"),
          };
        }
        return json({ ok: true, job });
      }
      if (body.action === "status") {
        return json({
          ok: true,
          worker: await queue.info(),
          webLogin: !!env("SUPABASE_ANON_KEY"),
        });
      }
      if (!UUID.test(body.jobId || "") || !UUID.test(body.lease || "")) {
        return json({ ok: false }, 400);
      }
      if (body.action === "progress") {
        if (
          !["opening", "reading"].includes(body.stage) ||
          !Number.isInteger(body.progress) || body.progress < 0 ||
          body.progress > 75
        ) return json({ ok: false }, 400);
        await queue.progress(body.jobId, body.lease, body.stage, body.progress);
        return json({ ok: true });
      }
      if (body.action === "fail") {
        if (
          ![
            "login_required",
            "blocked",
            "no_order_evidence",
            "browser_read_failed",
          ].includes(body.code)
        ) return json({ ok: false }, 400);
        await queue.fail(body.jobId, body.lease, body.code);
        return json({ ok: true });
      }
      if (body.action !== "finish") return json({ ok: false }, 400);
      const job = await queue.beginFinish(body.jobId, body.lease);
      if (!job) {
        return json(
          { ok: false, error: "이미 처리됐거나 만료된 작업입니다." },
          409,
        );
      }
      try {
        const payload = job.payload_ciphertext
          ? await unseal(workerKey, body.jobId, job.payload_ciphertext)
          : null;
        let remoteResult;
        if (job.kind === "pair") {
          remoteResult = body.approved === true
            ? {
              certificate: await issueDevice(workerKey, payload.device, now()),
            }
            : { denied: true };
        }
        if (job.kind === "remote_login") {
          const s = body.session;
          if (
            !s || s.id !== body.jobId ||
            !/^nmf-login-[a-f0-9]{64}$/.test(s.topic || "") ||
            !validDevice({ id: s.id, publicKey: s.publicKey }) ||
            !Number.isSafeInteger(s.expires) || s.expires <= now() ||
            s.expires > now() + 301000 || ![390, 980].includes(s.width) ||
            s.height !== 760
          ) throw Error("invalid_session");
          remoteResult = {
            session: {
              id: s.id,
              topic: s.topic,
              publicKey: s.publicKey,
              expires: s.expires,
              width: s.width,
              height: s.height,
            },
            relay: {
              url:
                "wss://rycibsczsgbkgtwfxyim.supabase.co/realtime/v1/websocket",
              key: env("SUPABASE_ANON_KEY"),
            },
          };
        }
        const result = remoteResult || (job.kind === "login"
          ? {
            state: ["ready", "login_required", "blocked"].includes(body.state)
              ? body.state
              : "login_required",
          }
          : await organize(
            body.snapshot,
            {
              from: String(job.from_date).slice(0, 10),
              to: String(job.to_date).slice(0, 10),
            },
            env("NMF_INVOICE_API_KEY") || env("OPENCODE_GO_API_KEY") ||
              env("OPENCODE_API_KEY"),
            fetcher,
          ));
        await queue.done(
          body.jobId,
          body.lease,
          await seal(workerKey, body.jobId, result),
        );
        return json({ ok: true });
      } catch (error) {
        const message = error instanceof Error
            ? error.message
            : "import_failed",
          code = codes.has(message) ||
              /^ai_http_\d+(?:_(?:x_opencode_session|max_output_tokens|reasoning|store|stream|text|model|input|instructions))?$/
                .test(message)
            ? message
            : "import_failed";
        await queue.fail(body.jobId, body.lease, code);
        return json({ ok: false, error: "주문 정리 실패 · " + code }, 503);
      }
    } catch (error) {
      const code = error instanceof Error && error.message === "rate_limited"
        ? "rate_limited"
        : "connector_unavailable";
      return json({
        ok: false,
        error: code === "rate_limited"
          ? "요청이 많습니다. 기존 작업이 끝난 뒤 다시 시도해 주세요."
          : "연결 서버 응답을 확인하지 못했습니다.",
      }, code === "rate_limited" ? 429 : 503);
    }
  };
}
