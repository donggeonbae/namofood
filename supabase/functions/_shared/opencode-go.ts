// One user-selected Go model. Never redirect credentials to paid Zen or retry
// against another provider. Existing validation consumes a Responses envelope;
// only the transport representation is normalized here, not business data.
export const GO_MODEL = "claude-haiku-5-5";
export const GO_BASE = "https://opencode.ai/inference/go/anthropic/v1";
export function goEndpoint(base: string, model: string, path: string): string {
  const normalized = base.replace(/\/$/, "");
  if (model !== GO_MODEL) return `${normalized}/${path}`;
  if (![GO_BASE, "https://opencode.ai/zen/go/v1"].includes(normalized)) {
    throw Error("opencode_go_endpoint_not_allowed");
  }
  return `${GO_BASE}/messages`;
}
export function goMessages(body: {
  instructions: string;
  input: { role: string; content: unknown[] }[];
  max_output_tokens: number;
}) {
  return {
    model: GO_MODEL,
    max_tokens: body.max_output_tokens,
    stream: false,
    system: body.instructions +
      "\nReturn only the requested JSON object, without markdown fences.",
    messages: body.input.map((message) => ({
      role: message.role,
      content: message.content.map((entry) => {
        const part = entry as Record<string, unknown>;
        if (part.type === "input_text" && typeof part.text === "string") {
          return { type: "text", text: part.text };
        }
        if (part.type === "input_image" && typeof part.image_url === "string") {
          const match = part.image_url.match(
            /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/,
          );
          if (match) {
            return {
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            };
          }
        }
        throw Error("opencode_go_invalid_content");
      }),
    })),
  };
}
export function goHeaders(headers: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("anthropic-version", "2023-06-01");
  return result;
}
export function responsesEnvelope(value: unknown): any {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  // Keep the existing strict parser useful for historical Responses fixtures.
  if (v.type !== "message") return value;
  const valid = v.role === "assistant" && v.stop_reason === "end_turn" &&
    (!v.model || String(v.model).startsWith(GO_MODEL)) &&
    Array.isArray(v.content) && v.content.length > 0 &&
    v.content.every((c) =>
      c && (
        c.type === "text" && typeof c.text === "string" ||
        c.type === "thinking" || c.type === "redacted_thinking"
      )
    ) && v.content.some((c) => c.type === "text" && c.text.trim());
  return {
    status: valid ? "completed" : "incomplete",
    output: valid
      ? [{
        type: "message",
        role: "assistant",
        status: "completed",
        content: (v.content as { type: string; text: string }[]).filter((c) =>
          c.type === "text"
        ).map((c) => ({
          type: "output_text",
          text: c.text,
        })),
      }]
      : [],
  };
}
