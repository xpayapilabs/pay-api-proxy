import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseJsoncObject } from "../../src/core/jsonc.js";

interface RawLocalPaidApiFixture {
  apiId?: unknown;
  routeId?: unknown;
  routePath?: unknown;
  method?: unknown;
  publicBaseUrl?: unknown;
  upstreamBaseUrl?: unknown;
  defaultRequestPrice?: unknown;
  routeRequestPrice?: unknown;
  assetSymbol?: unknown;
  assetAddress?: unknown;
  assetDecimals?: unknown;
  chainId?: unknown;
}

export interface LocalPaidApiFixture {
  apiId: string;
  routeId: string;
  routePath: string;
  method: string;
  publicBaseUrl: string;
  upstreamBaseUrl: string;
  defaultRequestPrice: bigint;
  routeRequestPrice: bigint;
  routeRequestPriceText: string;
  assetSymbol: string;
  assetAddress: string;
  assetDecimals: number;
  chainId: number;
  externalId: string;
}

const localFixturePath = fileURLToPath(new URL("../fixtures/local-paid-api.fixture.jsonc", import.meta.url));

const defaultFixture: RawLocalPaidApiFixture = {
  apiId: "sample-api",
  routeId: "sample-route",
  routePath: "/v1/example",
  method: "POST",
  publicBaseUrl: "https://api.example.com",
  upstreamBaseUrl: "https://upstream.example.com",
  defaultRequestPrice: "500",
  routeRequestPrice: "25000",
  assetSymbol: "pathUSD",
  assetAddress: "0x20c0000000000000000000000000000000000000",
  assetDecimals: 6,
  chainId: 42431
};

export function loadLocalPaidApiFixture(): LocalPaidApiFixture {
  const raw = existsSync(localFixturePath)
    ? parseJsoncObject(readFileSync(localFixturePath, "utf8"), localFixturePath)
    : defaultFixture;

  const apiId = readString(raw, "apiId");
  const routeId = readString(raw, "routeId");
  const routePath = readRoutePath(raw, "routePath");
  const method = readString(raw, "method").toUpperCase();
  const defaultRequestPrice = readBigInt(raw, "defaultRequestPrice");
  const routeRequestPrice = readBigInt(raw, "routeRequestPrice");

  return {
    apiId,
    routeId,
    routePath,
    method,
    publicBaseUrl: readString(raw, "publicBaseUrl"),
    upstreamBaseUrl: readString(raw, "upstreamBaseUrl"),
    defaultRequestPrice,
    routeRequestPrice,
    routeRequestPriceText: routeRequestPrice.toString(),
    assetSymbol: readString(raw, "assetSymbol"),
    assetAddress: readString(raw, "assetAddress"),
    assetDecimals: readInteger(raw, "assetDecimals"),
    chainId: readInteger(raw, "chainId"),
    externalId: `api:${apiId}:${routeId}`
  };
}

export function localPaidApiRequestUrl(fixture: LocalPaidApiFixture): string {
  return new URL(fixture.routePath, fixture.publicBaseUrl).toString();
}

function readString(raw: RawLocalPaidApiFixture, field: keyof RawLocalPaidApiFixture): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${localFixturePath}.${String(field)} must be a non-empty string`);
  }
  return value;
}

function readRoutePath(raw: RawLocalPaidApiFixture, field: keyof RawLocalPaidApiFixture): string {
  const value = readString(raw, field);
  if (!value.startsWith("/")) {
    throw new Error(`${localFixturePath}.${String(field)} must start with /`);
  }
  return value;
}

function readBigInt(raw: RawLocalPaidApiFixture, field: keyof RawLocalPaidApiFixture): bigint {
  const value = raw[field];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${localFixturePath}.${String(field)} must be a numeric string or number`);
  }
  return BigInt(value);
}

function readInteger(raw: RawLocalPaidApiFixture, field: keyof RawLocalPaidApiFixture): number {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${localFixturePath}.${String(field)} must be an integer`);
  }
  return value;
}
