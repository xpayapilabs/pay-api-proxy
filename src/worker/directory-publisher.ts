import type { DirectoryPublishConfig } from "../core/config.js";
import { isIP } from "node:net";

const DIRECTORY_REQUEST_TIMEOUT_MS = 10_000;

export interface DirectoryImportResult {
  apiIds: string[];
  approvalStatus?: string;
}

export async function registerDirectoryNode(config: DirectoryPublishConfig): Promise<DirectoryImportResult> {
  assertPublishablePublicBaseUrl(config.publicBaseUrl);
  const response = await fetchDirectory(`${config.directoryUrl.replace(/\/+$/, "")}/api/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ publicBaseUrl: config.publicBaseUrl })
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`directory import failed (${response.status}): ${errorDetail(body)}`);
  }
  const apiIds = Array.isArray(body.apiIds)
    ? body.apiIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    apiIds,
    approvalStatus: typeof body.approvalStatus === "string" ? body.approvalStatus : undefined
  };
}

async function fetchDirectory(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIRECTORY_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`directory request timed out after ${DIRECTORY_REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assertPublishablePublicBaseUrl(publicBaseUrl: string): void {
  const skipReason = directoryPublishSkipReason(publicBaseUrl);
  if (skipReason) throw new Error(skipReason);
}

export function directoryPublishSkipReason(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!["http:", "https:"].includes(parsed.protocol)) return "PUBLIC_BASE_URL must be an http(s) URL";
    if (parsed.username || parsed.password) return "PUBLIC_BASE_URL must not include credentials";
    if (parsed.search || parsed.hash) return "PUBLIC_BASE_URL must not include a query string or fragment";
    if (parsed.pathname !== "/" && parsed.pathname !== "") return "PUBLIC_BASE_URL must be the base URL, without a path";
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".local")) {
      return "PUBLIC_BASE_URL must be a real public domain name";
    }
    if (isIP(host)) return "PUBLIC_BASE_URL must be a domain name, not an IP address";
    if (!host.includes(".")) return "PUBLIC_BASE_URL must be a real public domain name";
    return undefined;
  } catch {
    return "PUBLIC_BASE_URL must be a valid URL";
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function errorDetail(body: Record<string, unknown>): string {
  const detail = body.detail;
  if (typeof detail === "string") return detail;
  return JSON.stringify(body);
}
