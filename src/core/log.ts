/**
 * Lightweight logging helpers for operator debugging.
 *
 * `logUpstreamResponse` — OpenAI / test-provider responses (stdout).
 * `maybeLogPaidHttpRequest` — inbound paid HTTP proxy requests when
 * `LOG_PAID_REQUESTS=true` (console, visible in Workers Observability).
 */

const PAID_REQUEST_BODY_MAX_CHARS = 2048;

const SENSITIVE_JSON_KEYS = new Set([
  "key",
  "verifycode",
  "password",
  "token",
  "secret",
  "authorization",
  "api_key",
  "apikey",
  "bearer",
  "access_token",
  "refresh_token"
]);

export function logUpstreamResponse(category: string, data: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test") return;
  if (process.env.LOG_UPSTREAM_RESPONSES === "false") return;
  try {
    process.stdout.write(`[upstream:${category}] ${JSON.stringify(data, jsonReplacer)}\n`);
  } catch {
    // Logging must never break a paid request.
  }
}

export function sanitizeImageResponseBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.data)) return body;
  const data = body.data.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const record = entry as Record<string, unknown>;
    const out: Record<string, unknown> = { ...record };
    if (typeof out.b64_json === "string") {
      out.b64_json = `<b64 ${out.b64_json.length} chars>`;
    }
    if (typeof out.url === "string" && out.url.length > 200) {
      out.url = `${out.url.slice(0, 200)}…<${out.url.length} chars>`;
    }
    return out;
  });
  return { ...body, data };
}

export async function maybeLogPaidHttpRequest(
  config: { nodeEnv: string; logPaidRequests: boolean },
  request: Request,
  context: { apiId: string }
): Promise<void> {
  if (!config.logPaidRequests || config.nodeEnv === "test") return;

  try {
    const url = new URL(request.url);
    const rawBody = await request.clone().text().catch(() => "");
    const entry = {
      event: "paid_request",
      apiId: context.apiId,
      method: request.method,
      path: url.pathname,
      search: url.search || undefined,
      body: redactRequestBodyForLog(rawBody)
    };
    console.log(`[paid-request] ${JSON.stringify(entry, jsonReplacer)}`);
  } catch {
    // Logging must never break a paid request.
  }
}

export function redactRequestBodyForLog(body: string, maxChars = PAID_REQUEST_BODY_MAX_CHARS): string {
  const trimmed = body.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return truncateForLog(JSON.stringify(redactJsonForLog(parsed)), maxChars);
    } catch {
      return truncateForLog(trimmed, maxChars);
    }
  }

  return truncateForLog(trimmed, maxChars);
}

function redactJsonForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonForLog);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_JSON_KEYS.has(key.toLowerCase()) ? "<redacted>" : redactJsonForLog(nested);
  }
  return out;
}

function truncateForLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…<${text.length} chars>`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
