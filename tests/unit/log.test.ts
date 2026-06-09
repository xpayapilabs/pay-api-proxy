import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maybeLogPaidHttpRequest,
  redactRequestBodyForLog
} from "../../src/core/log.js";

describe("paid request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts sensitive JSON keys and truncates long bodies", () => {
    const body = JSON.stringify({
      keyword: "weather",
      key: "secret-key",
      verifycode: "123456"
    });
    expect(redactRequestBodyForLog(body)).toBe(
      JSON.stringify({
        keyword: "weather",
        key: "<redacted>",
        verifycode: "<redacted>"
      })
    );

    const long = "x".repeat(3000);
    expect(redactRequestBodyForLog(long)).toBe(`${"x".repeat(2048)}…<3000 chars>`);
  });

  it("logs paid requests when enabled", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const request = new Request("https://api.example.com/v1/search?q=wx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "wx", key: "hidden" })
    });

    await maybeLogPaidHttpRequest(
      { nodeEnv: "development", logPaidRequests: true },
      request,
      { apiId: "wechat-jzl" }
    );

    expect(logSpy).toHaveBeenCalledOnce();
    const line = String(logSpy.mock.calls[0]?.[0]);
    expect(line).toContain("[paid-request]");
    expect(line).toContain('"apiId":"wechat-jzl"');
    expect(line).toContain('"path":"/v1/search"');
    expect(line).toContain('"search":"?q=wx"');
    expect(line).toContain(String.raw`\"keyword\":\"wx\"`);
    expect(line).toContain(String.raw`\"key\":\"<redacted>\"`);
    expect(line).not.toContain("hidden");
  });

  it("skips logging in test mode and when disabled", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const request = new Request("https://api.example.com/v1/search", {
      method: "POST",
      body: "{}"
    });

    await maybeLogPaidHttpRequest(
      { nodeEnv: "test", logPaidRequests: true },
      request,
      { apiId: "wechat-jzl" }
    );
    await maybeLogPaidHttpRequest(
      { nodeEnv: "development", logPaidRequests: false },
      request,
      { apiId: "wechat-jzl" }
    );

    expect(logSpy).not.toHaveBeenCalled();
  });
});
