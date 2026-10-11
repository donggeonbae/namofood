// One-shot, review-only invoice OCR. No database/storage writes or invoice logging.
// Secrets: NMF_PW, NMF_INVOICE_API_KEY or normal-Zen OPENCODE_API_KEY.
// OpenCode GO is coding-only, so its key/base are deliberately not reused.
import {
  imageBytes,
  INVOICE_PROMPT,
  OcrError,
  parseResponsesDocument,
  providerFailure,
  sha256,
} from "./lib.ts";
type Dependencies = {
  env?: (key: string) => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};
const ORIGINS = new Set(["https://d-bae.com", "https://donggeonbae.github.io"]);
const BODY_LIMIT = 12 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function createHandler(dependencies: Dependencies = {}) {
  const env = dependencies.env || ((key: string) => Deno.env.get(key) || "");
  const fetchImpl = dependencies.fetchImpl || fetch,
    now = dependencies.now || Date.now;
  const seen = new Map<string, number>();
  let active = 0;
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-nmf-time, x-nmf-signature",
    });
    if (origin && ORIGINS.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
    }
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    let claimed = false;
    try {
      if (origin && !ORIGINS.has(origin)) {
        throw new OcrError(
          "origin_not_allowed",
          403,
          "허용되지 않은 홈페이지 주소입니다.",
        );
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== "POST") {
        throw new OcrError(
          "method_not_allowed",
          405,
          "올바른 요청 방식이 아닙니다.",
        );
      }
      if (
        !request.headers.get("content-type")?.toLowerCase().startsWith(
          "application/json",
        )
      ) {
        throw new OcrError(
          "invalid_body",
          400,
          "사진 요청 형식이 올바르지 않습니다.",
        );
      }
      const declaredLength = request.headers.get("content-length");
      if (declaredLength && Number(declaredLength) > BODY_LIMIT) {
        throw new OcrError("body_too_large", 413, "사진 요청이 너무 큽니다.");
      }
      const password = env("NMF_PW").trim(),
        timestamp = request.headers.get("x-nmf-time") || "",
        signature = request.headers.get("x-nmf-signature") || "";
      if (
        !password || !/^\d{13}$/.test(timestamp) ||
        Math.abs(now() - Number(timestamp)) > 60000 ||
        !/^[a-f0-9]{64}$/.test(signature)
      ) {
        throw new OcrError(
          "unauthorized",
          401,
          "인증이 만료됐습니다. 다시 로그인하거나 요청해 주세요.",
        );
      }
      const reader = request.body?.getReader();
      if (!reader) {
        throw new OcrError("invalid_body", 400, "사진 요청이 비어 있습니다.");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > BODY_LIMIT) {
          await reader.cancel();
          throw new OcrError("body_too_large", 413, "사진 요청이 너무 큽니다.");
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let position = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, position);
        position += chunk.length;
      }
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const verified = await crypto.subtle.verify(
        "HMAC",
        key,
        Uint8Array.from(signature.match(/../g)!, (part) => parseInt(part, 16)),
        encoder.encode(`nmf-invoice:${await sha256(bytes)}:${timestamp}`),
      );
      if (!verified || Math.abs(now() - Number(timestamp)) > 60000) {
        throw new OcrError(
          "unauthorized",
          401,
          "요청 인증이 올바르지 않습니다. 다시 시도해 주세요.",
        );
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new OcrError(
          "invalid_body",
          400,
          "사진 요청 형식이 올바르지 않습니다.",
        );
      }
      if (
        !body || typeof body !== "object" || Array.isArray(body) ||
        !UUID.test(String(body.nonce)) ||
        !["food", "cafe"].includes(String(body.app)) ||
        !["status", "extract"].includes(String(body.action))
      ) {
        throw new OcrError(
          "invalid_body",
          400,
          "사진 요청 형식이 올바르지 않습니다.",
        );
      }
      for (const [nonce, expires] of seen) {
        if (expires <= now()) seen.delete(nonce);
      }
      const nonce = `${body.app}:${body.nonce}`;
      if (seen.has(nonce)) {
        throw new OcrError(
          "request_replayed",
          409,
          "이미 처리한 요청입니다. 새 요청으로 다시 시도해 주세요.",
        );
      }
      if (seen.size >= 2048) {
        throw new OcrError(
          "too_many_requests",
          429,
          "잠시 후 다시 요청해 주세요.",
        );
      }
      seen.set(nonce, now() + 120000);
      const apiKey = (env("NMF_INVOICE_API_KEY") || env("OPENCODE_API_KEY"))
        .trim();
      const base = (env("NMF_INVOICE_BASE_URL") || "https://opencode.ai/zen/v1")
        .trim().replace(/\/$/, "");
      const model = (env("NMF_INVOICE_MODEL") || "gpt-6-luna").trim();
      const configured = Boolean(
        apiKey && base === "https://opencode.ai/zen/v1" &&
          model === "gpt-6-luna",
      );
      if (body.action === "status") {
        return json({
          ok: true,
          configured,
          model: /^[a-zA-Z0-9._-]{1,100}$/.test(model) ? model : "",
          provider: "OpenCode",
          imageStored: false,
        });
      }
      if (!configured) {
        throw new OcrError(
          "ocr_not_configured",
          503,
          "명세서 OCR 서버의 일반 Zen API 키·모델 설정이 필요합니다.",
        );
      }
      if (active >= 2) {
        throw new OcrError(
          "ocr_busy",
          429,
          "다른 명세서를 읽는 중입니다. 잠시 후 다시 시도해 주세요.",
        );
      }
      active++;
      claimed = true;
      const image = imageBytes(body.image),
        imageSha256 = await sha256(image.bytes);
      const timeoutMs = dependencies.timeoutMs ??
        Math.min(
          120000,
          Math.max(10000, Number(env("NMF_INVOICE_TIMEOUT_MS")) || 100000),
        );
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = async () => {
        const upstream = await fetchImpl(`${base}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            reasoning: { effort: "none" },
            max_output_tokens: 8192,
            store: false,
            stream: false,
            text: { format: { type: "json_object" } },
            instructions: INVOICE_PROMPT,
            input: [{
              role: "user",
              content: [{
                type: "input_text",
                text:
                  "첨부한 한국 거래명세서를 한국어로 정확히 읽고 지정한 JSON 객체만 반환하세요.",
              }, {
                type: "input_image",
                image_url: `data:${image.mime};base64,${image.data}`,
                detail: "high",
              }],
            }],
          }),
        });
        if (!upstream.ok) {
          await upstream.body?.cancel().catch(() => {});
          throw providerFailure(upstream.status);
        }
        let answer;
        try {
          const reader = upstream.body?.getReader();
          if (!reader) throw new Error("empty");
          const parts: Uint8Array[] = [];
          let length = 0;
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.length;
            if (length > 256000) {
              await reader.cancel();
              throw new Error("too large");
            }
            parts.push(chunk.value);
          }
          const responseBytes = new Uint8Array(length);
          let offset = 0;
          for (const part of parts) {
            responseBytes.set(part, offset);
            offset += part.length;
          }
          answer = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
          );
        } catch {
          throw new OcrError(
            "invalid_model_response",
            502,
            "OCR 응답을 읽지 못했습니다. 다시 시도해 주세요.",
          );
        }
        return parseResponsesDocument(answer);
      };
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new OcrError(
                "ocr_timeout",
                504,
                "명세서 인식 시간이 초과됐습니다. 사진을 나누어 다시 시도해 주세요.",
              ),
            );
            controller.abort();
          }, timeoutMs);
        });
        const document = await Promise.race([operation(), timeout]);
        return json({
          ok: true,
          document,
          model,
          processedAt: new Date(now()).toISOString(),
          imageSha256,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const safe = error instanceof OcrError ? error : new OcrError(
        "ocr_failed",
        502,
        "명세서 인식에 실패했습니다. 잠시 후 다시 시도해 주세요.",
      );
      return json(
        {
          ok: false,
          code: safe.code,
          message: safe.message,
          ...(safe.providerStatus != null
            ? { providerStatus: safe.providerStatus }
            : {}),
        },
        safe.status,
      );
    } finally {
      if (claimed) active--;
    }
  };
}
if (import.meta.main) Deno.serve(createHandler());
