import { sanitizeJsonResponse } from "../../src/core/response-sanitizer.js";

describe("response sanitizer", () => {
  it("removes configured JSON keys recursively", async () => {
    const response = await sanitizeJsonResponse(
      Response.json({
        ok: true,
        cost: 1,
        remain_money: 2,
        data: [
          { id: "a", cost: 3, value: "kept" },
          { nested: { remain_money: 4, value: "also-kept" } }
        ]
      }),
      { removeJsonKeys: ["cost", "remain_money"] }
    );

    expect(await response.json()).toEqual({
      ok: true,
      data: [
        { id: "a", value: "kept" },
        { nested: { value: "also-kept" } }
      ]
    });
  });

  it("does not sanitize payment challenge responses", async () => {
    const response = await sanitizeJsonResponse(
      Response.json({ cost: 1, remain_money: 2 }, { status: 402 }),
      { removeJsonKeys: ["cost", "remain_money"] }
    );

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ cost: 1, remain_money: 2 });
  });

  it("passes non-JSON responses through unchanged", async () => {
    const original = new Response("cost=1&remain_money=2", {
      headers: { "content-type": "text/plain" }
    });

    const response = await sanitizeJsonResponse(original, { removeJsonKeys: ["cost", "remain_money"] });

    expect(response).toBe(original);
    expect(await response.text()).toBe("cost=1&remain_money=2");
  });
});
