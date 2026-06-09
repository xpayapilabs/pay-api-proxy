export const DEFAULT_FAVICON_CONTENT_TYPE = "image/x-icon";
export const DEFAULT_FAVICON_CACHE_CONTROL = "public, max-age=86400";

export interface FaviconConfig {
  contentType: string;
  dataBase64: string;
  cacheControl: string;
}

export function normalizeFaviconBase64(name: string, value: string): string {
  const compact = value.replace(/\s+/g, "");
  if (!compact) {
    throw new Error(`${name} must be non-empty base64 data`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error(`${name} must be standard base64 data`);
  }

  const unpadded = compact.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) {
    throw new Error(`${name} must be standard base64 data`);
  }

  const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  if (decodeBase64(padded).byteLength === 0) {
    throw new Error(`${name} must decode to at least one byte`);
  }
  return padded;
}

export function faviconResponse(config: { favicon?: FaviconConfig }): Response | undefined {
  const favicon = config.favicon;
  if (!favicon) return undefined;

  return new Response(decodeBase64(favicon.dataBase64), {
    status: 200,
    headers: {
      "cache-control": favicon.cacheControl,
      "content-type": favicon.contentType
    }
  });
}

function decodeBase64(value: string): Uint8Array {
  const atobFn = (globalThis as typeof globalThis & {
    atob?: (data: string) => string;
  }).atob;
  if (typeof atobFn === "function") {
    const binary = atobFn(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  return Uint8Array.from(Buffer.from(value, "base64"));
}
