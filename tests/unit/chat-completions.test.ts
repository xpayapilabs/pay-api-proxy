import { createChatCompletionsEndpoint } from "../../src/endpoints/chat-completions.js";
import { isEndpointError } from "../../src/endpoints/types.js";

describe("chat completions endpoint", () => {
  const endpoint = createChatCompletionsEndpoint(() => undefined);

  it("accepts plain-text chat messages", () => {
    const body = endpoint.validateBody({
      model: "test-chat",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hello" }
      ],
      max_completion_tokens: 32
    });

    expect(isEndpointError(body)).toBe(false);
  });

  it("rejects tool payloads until they have explicit pricing support", () => {
    const body = endpoint.validateBody({
      model: "test-chat",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object", properties: {} }
        }
      }]
    });

    expect(isEndpointError(body)).toBe(true);
    expect((body as ReturnType<typeof isError>).code).toBe("unsupported_chat_feature");
  });

  it("rejects multimodal content until it has explicit pricing support", () => {
    const body = endpoint.validateBody({
      model: "test-chat",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "https://example.com/image.png" } }
        ]
      }]
    });

    expect(isEndpointError(body)).toBe(true);
    expect((body as ReturnType<typeof isError>).code).toBe("unsupported_chat_feature");
  });

  it("rejects multiple choices because the quote reserves one output", () => {
    const body = endpoint.validateBody({
      model: "test-chat",
      messages: [{ role: "user", content: "hello" }],
      n: 2
    });

    expect(isEndpointError(body)).toBe(true);
    expect((body as ReturnType<typeof isError>).code).toBe("unsupported_chat_feature");
  });
});

function isError(value: unknown): { code: string } {
  return value as { code: string };
}
