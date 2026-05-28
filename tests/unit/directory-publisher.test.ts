import { afterEach, expect, vi } from "vitest";
import { directoryPublishSkipReason, registerDirectoryNode } from "../../src/worker/directory-publisher.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("directory publisher", () => {
  it("submits only publicBaseUrl to the public registration endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ apiIds: ["api_123"], approvalStatus: "approved" }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await registerDirectoryNode({
      enabled: true,
      directoryUrl: "https://api.xpayapi.com",
      publicBaseUrl: "https://api.example.com"
    });

    expect(result).toEqual({ apiIds: ["api_123"], approvalStatus: "approved" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.xpayapi.com/api/register",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicBaseUrl: "https://api.example.com" })
      })
    );
  });

  it("skips localhost, IP, and non-base URLs", () => {
    expect(directoryPublishSkipReason("http://localhost:8080")).toMatch(/real public domain/);
    expect(directoryPublishSkipReason("https://203.0.113.10")).toMatch(/domain name/);
    expect(directoryPublishSkipReason("https://api.example.com/proxy")).toMatch(/base URL/);
    expect(directoryPublishSkipReason("https://api.example.com/")).toBeUndefined();
    expect(directoryPublishSkipReason("https://api.example.com")).toBeUndefined();
    expect(directoryPublishSkipReason("https://[2001:db8::1]")).toMatch(/domain name/);
    expect(directoryPublishSkipReason("https://xn--bcher-kva.example")).toBeUndefined();
  });
});
