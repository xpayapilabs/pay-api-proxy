import { prepareTraditionalUpstreamRequest } from "../../src/api/traditional-mppx.js";

describe("traditional mppx upstream requests", () => {
  it("injects configured bearer and headers after filtering client headers", async () => {
    const request = new Request("https://paid.example.com/v1/quote", {
      headers: {
        accept: "application/json",
        authorization: "Payment client-credential",
        "x-client-id": "client-123",
        "x-not-forwarded": "drop-me"
      }
    });

    const upstream = await prepareTraditionalUpstreamRequest(request, {
      bearer: "service-token",
      forwardedHeaders: ["accept", "x-client-id"],
      headers: { "x-api-key": "service-key" }
    });

    expect(upstream.headers.get("accept")).toBe("application/json");
    expect(upstream.headers.get("x-client-id")).toBe("client-123");
    expect(upstream.headers.get("x-not-forwarded")).toBeNull();
    expect(upstream.headers.get("authorization")).toBe("Bearer service-token");
    expect(upstream.headers.get("x-api-key")).toBe("service-key");
  });

  it("uses route-level upstream auth overrides like mppx endpoint options", async () => {
    const request = new Request("https://paid.example.com/v1/live/EURUSD", {
      headers: { accept: "application/json" }
    });

    const upstream = await prepareTraditionalUpstreamRequest(
      request,
      {
        bearer: "service-token",
        forwardedHeaders: ["accept"],
        headers: {
          "x-api-key": "service-key",
          "x-service-header": "service"
        }
      },
      {
        bearer: "route-token",
        headers: { "x-api-key": "route-key" }
      }
    );

    expect(upstream.headers.get("authorization")).toBe("Bearer route-token");
    expect(upstream.headers.get("x-api-key")).toBe("route-key");
    expect(upstream.headers.get("x-service-header")).toBe("service");
  });

  it("applies upstream-level JSON request rewrite for every route", async () => {
    const request = new Request("https://paid.example.com/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verifycode: "123456" })
    });

    const upstream = await prepareTraditionalUpstreamRequest(request, {
      forwardedHeaders: ["content-type"],
      requestRewrite: {
        headers: { "content-type": "application/json" },
        body: {
          mode: "mergeJson",
          json: {
            key: "service-key"
          }
        }
      }
    });

    expect(upstream.headers.get("content-type")).toBe("application/json");
    await expect(upstream.json()).resolves.toEqual({
      key: "service-key",
      verifycode: "123456"
    });
  });

  it("can replace upstream JSON body from client JSON fields", async () => {
    const request = new Request("https://paid.example.com/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "abc", nested: { verifycode: "654321" } })
    });

    const upstream = await prepareTraditionalUpstreamRequest(request, {
      forwardedHeaders: ["content-type"],
      requestRewrite: {
        body: {
          mode: "replaceJson",
          json: {
            key: "service-key",
            verifycode: { fromJson: "$.nested.verifycode" }
          }
        }
      }
    });

    await expect(upstream.json()).resolves.toEqual({
      key: "service-key",
      verifycode: "654321"
    });
  });
});
