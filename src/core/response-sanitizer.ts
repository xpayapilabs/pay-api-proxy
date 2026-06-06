export const DEFAULT_RESPONSE_SANITIZER_REMOVE_JSON_KEYS = ["cost", "remain_money"] as const;

export interface ResponseSanitizerConfig {
  removeJsonKeys: string[];
}

const BODYLESS_STATUSES = new Set([204, 205, 304]);

export async function sanitizeJsonResponse(
  response: Response,
  sanitizer: ResponseSanitizerConfig | undefined
): Promise<Response> {
  const removeJsonKeys = sanitizer?.removeJsonKeys ?? [...DEFAULT_RESPONSE_SANITIZER_REMOVE_JSON_KEYS];
  if (removeJsonKeys.length === 0 || response.status === 402 || BODYLESS_STATUSES.has(response.status)) {
    return response;
  }
  if (!isJsonContentType(response.headers.get("content-type")) || response.body === null) return response;

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return responseFromBody(response, body);
  }

  return responseFromBody(
    response,
    JSON.stringify(removeJsonKeysFromValue(parsed, new Set(removeJsonKeys)))
  );
}

export function removeJsonKeysFromValue(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => removeJsonKeysFromValue(entry, keys));
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key)) continue;
    output[key] = removeJsonKeysFromValue(entry, keys);
  }
  return output;
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function responseFromBody(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
