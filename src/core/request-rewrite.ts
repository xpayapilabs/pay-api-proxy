export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RequestRewriteJsonTemplate =
  | JsonPrimitive
  | RequestRewriteJsonTemplate[]
  | { [key: string]: RequestRewriteJsonTemplate };

export interface RequestRewriteBodyConfig {
  mode: "mergeJson" | "replaceJson";
  json: Record<string, RequestRewriteJsonTemplate>;
}

export interface RequestRewriteConfig {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: RequestRewriteBodyConfig;
}

export class RequestRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestRewriteError";
  }
}

type EnvResolver = (name: string) => string | undefined;

const REWRITE_BODY_MODES = new Set(["mergeJson", "replaceJson"]);

export function parseRequestRewriteConfig(
  value: unknown,
  name: string,
  resolveEnv: EnvResolver
): RequestRewriteConfig | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new Error(`${name} must be an object`);
  const record = value as Record<string, unknown>;
  const result: RequestRewriteConfig = {};

  if (record.method !== undefined) {
    if (typeof record.method !== "string" || record.method.length === 0) {
      throw new Error(`${name}.method must be a non-empty string`);
    }
    result.method = record.method.toUpperCase();
  }

  if (record.path !== undefined) {
    if (typeof record.path !== "string" || !record.path.startsWith("/")) {
      throw new Error(`${name}.path must start with "/"`);
    }
    result.path = record.path;
  }

  if (record.headers !== undefined) {
    if (!isPlainObject(record.headers)) throw new Error(`${name}.headers must be an object`);
    const headers: Record<string, string> = {};
    for (const [key, entry] of Object.entries(record.headers)) {
      if (key.length === 0) throw new Error(`${name}.headers names must be non-empty strings`);
      if (typeof entry !== "string") throw new Error(`${name}.headers.${key} must be a string`);
      headers[key] = entry;
    }
    result.headers = headers;
  }

  if (record.body !== undefined) {
    if (!isPlainObject(record.body)) throw new Error(`${name}.body must be an object`);
    const body = record.body as Record<string, unknown>;
    if (typeof body.mode !== "string" || !REWRITE_BODY_MODES.has(body.mode)) {
      throw new Error(`${name}.body.mode must be "mergeJson" or "replaceJson"`);
    }
    if (!isPlainObject(body.json)) throw new Error(`${name}.body.json must be an object`);
    result.body = {
      mode: body.mode as RequestRewriteBodyConfig["mode"],
      json: parseTemplateObject(body.json as Record<string, unknown>, `${name}.body.json`, resolveEnv)
    };
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

export async function applyRequestRewrite(request: Request, rewrite: RequestRewriteConfig | undefined): Promise<Request> {
  if (!rewrite) return request;

  const url = new URL(request.url);
  if (rewrite.path) {
    const replacement = new URL(rewrite.path, url.origin);
    url.pathname = replacement.pathname;
    url.search = replacement.search;
  }

  const method = rewrite.method ?? request.method;
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(rewrite.headers ?? {})) headers.set(name, value);

  if (!rewrite.body || method === "GET" || method === "HEAD") {
    if (url.href === request.url) {
      return new Request(request, {
        headers,
        method
      });
    }
    return new Request(url, {
      body: method === "GET" || method === "HEAD" ? undefined : await request.clone().arrayBuffer(),
      headers,
      method
    });
  }

  const originalJson = await readJsonObject(request);
  const resolved = resolveTemplateObject(rewrite.body.json, {
    headers: request.headers,
    json: originalJson,
    url: new URL(request.url)
  });
  const body = rewrite.body.mode === "mergeJson"
    ? { ...originalJson, ...resolved }
    : resolved;

  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  return new Request(url, {
    body: JSON.stringify(body),
    headers,
    method
  });
}

function parseTemplateObject(
  record: Record<string, unknown>,
  name: string,
  resolveEnv: EnvResolver
): Record<string, RequestRewriteJsonTemplate> {
  const result: Record<string, RequestRewriteJsonTemplate> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.length === 0) throw new Error(`${name} field names must be non-empty strings`);
    result[key] = parseTemplateValue(value, `${name}.${key}`, resolveEnv);
  }
  return result;
}

function parseTemplateValue(value: unknown, name: string, resolveEnv: EnvResolver): RequestRewriteJsonTemplate {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${name} must be finite`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => parseTemplateValue(entry, `${name}[${index}]`, resolveEnv));
  if (!isPlainObject(value)) throw new Error(`${name} must be JSON-compatible`);

  const record = value as Record<string, unknown>;
  if ("env" in record) {
    if (typeof record.env !== "string" || record.env.length === 0) throw new Error(`${name}.env must be a string`);
    const resolved = resolveEnv(record.env);
    if (resolved !== undefined) return resolved;
    if ("default" in record) return parseTemplateValue(record.default, `${name}.default`, resolveEnv);
    throw new Error(`${name}.env references missing environment variable ${record.env}`);
  }
  if ("value" in record) return parseTemplateValue(record.value, `${name}.value`, resolveEnv);
  if ("fromJson" in record) {
    if (typeof record.fromJson !== "string" || !isJsonPath(record.fromJson)) {
      throw new Error(`${name}.fromJson must be "$" or a dotted path like "$.verifycode"`);
    }
    return parseSourceTemplate(record, name, "fromJson", resolveEnv);
  }
  if ("fromHeader" in record) {
    if (typeof record.fromHeader !== "string" || record.fromHeader.length === 0) {
      throw new Error(`${name}.fromHeader must be a string`);
    }
    return parseSourceTemplate(record, name, "fromHeader", resolveEnv);
  }
  if ("fromQuery" in record) {
    if (typeof record.fromQuery !== "string" || record.fromQuery.length === 0) {
      throw new Error(`${name}.fromQuery must be a string`);
    }
    return parseSourceTemplate(record, name, "fromQuery", resolveEnv);
  }

  return parseTemplateObject(record, name, resolveEnv);
}

function parseSourceTemplate(
  record: Record<string, unknown>,
  name: string,
  sourceKey: "fromJson" | "fromHeader" | "fromQuery",
  resolveEnv: EnvResolver
): RequestRewriteJsonTemplate {
  const result: Record<string, RequestRewriteJsonTemplate> = {
    [sourceKey]: record[sourceKey] as string
  };
  if ("default" in record) {
    result.default = parseTemplateValue(record.default, `${name}.default`, resolveEnv);
  }
  return result;
}

function resolveTemplateObject(
  record: Record<string, RequestRewriteJsonTemplate>,
  context: { headers: Headers; json: Record<string, JsonValue>; url: URL }
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) result[key] = resolveTemplateValue(value, context);
  return result;
}

function resolveTemplateValue(
  value: RequestRewriteJsonTemplate,
  context: { headers: Headers; json: Record<string, JsonValue>; url: URL }
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveTemplateValue(entry, context));

  const objectValue = value as Record<string, unknown>;
  if (isSource(objectValue, "fromJson")) {
    const resolved = readJsonPath(context.json, objectValue.fromJson);
    if (resolved !== undefined) return resolved;
    if ("default" in objectValue) return resolveTemplateValue(objectValue.default as RequestRewriteJsonTemplate, context);
    throw new RequestRewriteError(`requestRewrite missing JSON value at ${objectValue.fromJson}`);
  }
  if (isSource(objectValue, "fromHeader")) {
    const resolved = context.headers.get(objectValue.fromHeader);
    if (resolved !== null) return resolved;
    if ("default" in objectValue) return resolveTemplateValue(objectValue.default as RequestRewriteJsonTemplate, context);
    throw new RequestRewriteError(`requestRewrite missing header ${objectValue.fromHeader}`);
  }
  if (isSource(objectValue, "fromQuery")) {
    const resolved = context.url.searchParams.get(objectValue.fromQuery);
    if (resolved !== null) return resolved;
    if ("default" in objectValue) return resolveTemplateValue(objectValue.default as RequestRewriteJsonTemplate, context);
    throw new RequestRewriteError(`requestRewrite missing query parameter ${objectValue.fromQuery}`);
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(objectValue)) {
    result[key] = resolveTemplateValue(entry as RequestRewriteJsonTemplate, context);
  }
  return result;
}

async function readJsonObject(request: Request): Promise<Record<string, JsonValue>> {
  const text = await request.clone().text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestRewriteError("requestRewrite body requires a valid JSON request body");
  }
  if (!isPlainObject(parsed)) {
    throw new RequestRewriteError("requestRewrite body requires a JSON object request body");
  }
  return parsed as Record<string, JsonValue>;
}

function readJsonPath(source: Record<string, JsonValue>, path: string): JsonValue | undefined {
  if (path === "$") return source;
  const segments = path.slice(2).split(".");
  let current: JsonValue | undefined = source;
  for (const segment of segments) {
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
    } else {
      current = current[segment];
    }
  }
  return current;
}

function isJsonPath(value: string): boolean {
  return value === "$" || /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\.\d+)+$/.test(value);
}

function isSource(
  value: Record<string, unknown>,
  key: "fromJson" | "fromHeader" | "fromQuery"
): value is Record<string, unknown> & Record<typeof key, string> {
  return key in value && typeof value[key] === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
