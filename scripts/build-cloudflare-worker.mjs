import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "dist/cloudflare-worker/worker.js");
const embeddedOpenApi = readEmbeddedOpenApiDocuments();
const embeddedFavicon = readEmbeddedFavicon();
const footer = embeddedFooter(embeddedOpenApi, embeddedFavicon);

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, "src/adapters/cloudflare-worker/worker.ts")],
  outfile,
  bundle: true,
  format: "esm",
  // Target the Cloudflare Workers runtime (workerd), not Node. This makes esbuild pick
  // the worker/browser export conditions of dependencies (viem, ox, mppx) instead of their
  // Node builds, so we don't accidentally bundle Node-only code paths.
  platform: "browser",
  conditions: ["workerd", "worker", "browser", "import", "module", "default"],
  mainFields: ["module", "browser", "main"],
  // Any residual `node:*` import is left for the runtime to resolve via the
  // `nodejs_compat` compatibility flag (set on the Worker version in Terraform).
  external: ["node:*", "cloudflare:*"],
  ...(footer ? { footer: { js: footer } } : {}),
  target: "es2022",
  sourcemap: true,
  legalComments: "eof",
  logLevel: "info"
});

console.log(`Cloudflare Worker bundle written to ${outfile}`);
if (Object.keys(embeddedOpenApi.documents).length > 0) {
  console.log(`Embedded OpenAPI documents: ${Object.keys(embeddedOpenApi.documents).join(", ")}`);
}
if (embeddedFavicon) {
  console.log(`Embedded favicon: ${embeddedFavicon.path}`);
}

function readEmbeddedOpenApiDocuments() {
  const paths = readEmbeddedOpenApiDocumentPaths();
  const documents = {};
  const hashes = {};
  for (const [apiId, documentPath] of Object.entries(paths)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(apiId)) {
      throw new Error(`OpenAPI document key "${apiId}" must be a URL-safe lowercase API id`);
    }
    const absolutePath = resolve(process.cwd(), documentPath);
    const content = readFileSync(absolutePath, "utf8");
    documents[apiId] = content;
    hashes[apiId] = createHash("sha256").update(content).digest("hex");
  }
  return { documents, hashes };
}

function embeddedFooter(openApi, favicon) {
  const lines = [""];
  if (Object.keys(openApi.documents).length > 0) {
    lines.push(
      "globalThis.__PAY_API_PROXY_OPENAPI_DOCUMENTS = " + JSON.stringify(openApi.documents) + ";",
      "globalThis.__PAY_API_PROXY_EMBEDDED_OPENAPI_DOCUMENT_HASHES = " + JSON.stringify(openApi.hashes) + ";"
    );
  }
  if (favicon) {
    lines.push(
      "globalThis.__PAY_API_PROXY_FAVICON = " + JSON.stringify({
        contentType: favicon.contentType,
        dataBase64: favicon.dataBase64,
        cacheControl: favicon.cacheControl
      }) + ";",
      "globalThis.__PAY_API_PROXY_EMBEDDED_FAVICON_HASH = " + JSON.stringify(favicon.hash) + ";"
    );
  }
  lines.push("");
  return lines.length > 2 ? lines.join("\n") : "";
}

function readEmbeddedOpenApiDocumentPaths() {
  const configured = process.env.PAY_API_PROXY_OPENAPI_DOCUMENT_PATHS?.trim();
  const paths = configured ? parseJsonPathMap(configured, "PAY_API_PROXY_OPENAPI_DOCUMENT_PATHS") : {};

  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--openapi") {
      index += 1;
      if (index >= args.length) throw new Error("--openapi requires apiId=path");
      addOpenApiPath(paths, args[index]);
      continue;
    }
    if (arg.startsWith("--openapi=")) {
      addOpenApiPath(paths, arg.slice("--openapi=".length));
      continue;
    }
    if (arg === "--favicon") {
      index += 1;
      if (index >= args.length) throw new Error("--favicon requires a file path");
      process.env.PAY_API_PROXY_FAVICON_PATH = args[index];
      continue;
    }
    if (arg.startsWith("--favicon=")) {
      process.env.PAY_API_PROXY_FAVICON_PATH = arg.slice("--favicon=".length);
      continue;
    }
    throw new Error(`Unknown build argument: ${arg}`);
  }

  return paths;
}

function readEmbeddedFavicon() {
  const configuredPath = process.env.PAY_API_PROXY_FAVICON_PATH?.trim();
  if (!configuredPath) return undefined;

  const absolutePath = resolve(process.cwd(), configuredPath);
  const bytes = readFileSync(absolutePath);
  if (bytes.byteLength === 0) {
    throw new Error(`PAY_API_PROXY_FAVICON_PATH points to an empty file: ${configuredPath}`);
  }

  return {
    path: configuredPath,
    contentType: process.env.PAY_API_PROXY_FAVICON_CONTENT_TYPE?.trim() || faviconContentType(configuredPath),
    dataBase64: bytes.toString("base64"),
    cacheControl: process.env.PAY_API_PROXY_FAVICON_CACHE_CONTROL?.trim() || "public, max-age=86400",
    hash: createHash("sha256").update(bytes).digest("hex")
  };
}

function faviconContentType(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/x-icon";
}

function parseJsonPathMap(value, name) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON object mapping api id to OpenAPI file path`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object mapping api id to OpenAPI file path`);
  }
  const paths = {};
  for (const [apiId, documentPath] of Object.entries(parsed)) {
    if (typeof documentPath !== "string" || documentPath.length === 0) {
      throw new Error(`${name}.${apiId} must be a non-empty string path`);
    }
    paths[apiId] = documentPath;
  }
  return paths;
}

function addOpenApiPath(paths, value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("--openapi must use apiId=path");
  }
  paths[value.slice(0, separator)] = value.slice(separator + 1);
}
