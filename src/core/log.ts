/**
 * Lightweight stdout logger for upstream-provider responses (OpenAI calls and
 * deterministic test providers). Writes one JSON line per call, prefixed with
 * `[upstream:<category>]`, so it interleaves cleanly with Fastify's pino logs
 * in the dev console and is easy to grep in production aggregators.
 *
 * Disabled under NODE_ENV=test (vitest sets this automatically) so the test
 * suite stays quiet. Operators can also opt out at runtime with
 * `LOG_UPSTREAM_RESPONSES=false`.
 */
export function logUpstreamResponse(category: string, data: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test") return;
  if (process.env.LOG_UPSTREAM_RESPONSES === "false") return;
  try {
    process.stdout.write(`[upstream:${category}] ${JSON.stringify(data, jsonReplacer)}\n`);
  } catch {
    // Logging must never break a paid request. Swallow JSON.stringify failures
    // (e.g. circular refs) silently.
  }
}

/**
 * Trims fields that would otherwise blow up the log line. The b64_json payload
 * for a single 1024x1024 image is ~1.7 MB; preserving its length is useful for
 * sanity, the payload itself is not.
 */
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

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
