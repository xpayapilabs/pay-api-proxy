import { testConfig } from "../../src/core/config.js";
import {
  OpenAiCompatibleProvider,
  buildOpenAiChatRequest,
  listOpenAiModels,
  probeOpenAiEndpoints
} from "../../src/providers/openai.js";

describe("OpenAI provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps client max_tokens to upstream max_completion_tokens", () => {
    const request = buildOpenAiChatRequest({
      model: "public-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 32
    }, "gpt-4.1-nano");

    expect(request.model).toBe("gpt-4.1-nano");
    expect(request.max_tokens).toBeUndefined();
    expect(request.max_completion_tokens).toBe(32);
  });

  it("normalizes explicit max_completion_tokens without forwarding legacy max_tokens", () => {
    const request = buildOpenAiChatRequest({
      model: "public-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 32,
      max_completion_tokens: 64
    }, "gpt-4.1-nano");

    expect(request.max_tokens).toBeUndefined();
    expect(request.max_completion_tokens).toBe(64);
  });

  it("lists upstream OpenAI models available to the API key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "gpt-4.1-mini", object: "model", owned_by: "openai" },
        { id: "gpt-4.1", object: "model", owned_by: "openai" }
      ]
    }), { status: 200 }));

    const models = await listOpenAiModels({
      openaiApiKey: "sk-test",
      openaiBaseUrl: "https://api.openai.com/v1"
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        authorization: "Bearer sk-test"
      }
    });
    expect(models.map((model) => model.id)).toEqual(["gpt-4.1", "gpt-4.1-mini"]);
  });

  it("surfaces upstream errors when listing OpenAI models", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { message: "invalid api key" }
    }), { status: 401 }));

    await expect(listOpenAiModels({
      openaiApiKey: "sk-test",
      openaiBaseUrl: "https://api.openai.com/v1"
    })).rejects.toThrow(/invalid api key/);
  });

  it("omits image usage details when upstream does not return per-modality fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      created: 0,
      data: [{ b64_json: "abc" }],
      usage: {
        input_tokens: 12,
        output_tokens: 123,
        total_tokens: 135
      }
    }), { status: 200 }));

    const provider = new OpenAiCompatibleProvider(testConfig({
      openaiApiKey: "sk-test",
      upstreamProvider: "openai"
    }));
    const result = await provider.images({
      model: "gpt-image-2",
      prompt: "a small cube",
      size: "1024x1024",
      quality: "low",
      n: 1
    }, "gpt-image-2");

    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(123);
    expect(result.usage.details).toBeUndefined();
  });

  it("probes safe OpenAI endpoints without live POST requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }));

    const probes = await probeOpenAiEndpoints({
      openaiApiKey: "sk-test",
      openaiBaseUrl: "https://api.openai.com/v1"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        authorization: "Bearer sk-test"
      },
      body: undefined
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://api.openai.com/v1/files", {
      method: "GET",
      headers: {
        authorization: "Bearer sk-test"
      },
      body: undefined
    });
    expect(probes.map((probe) => [probe.name, probe.status])).toEqual([
      ["models", "available"],
      ["files", "available"]
    ]);
  });

  it("adds live OpenAI endpoint probes when requested", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "probe" }), { status: 200 })
    );

    const probes = await probeOpenAiEndpoints({
      openaiApiKey: "sk-test",
      openaiBaseUrl: "https://api.openai.com/v1"
    }, {
      live: true,
      chatModel: "gpt-4.1-mini",
      responsesModel: "gpt-4.1-mini",
      embeddingModel: "text-embedding-3-small"
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(probes.map((probe) => probe.name)).toEqual([
      "models",
      "files",
      "responses",
      "chat_completions",
      "embeddings"
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://api.openai.com/v1/responses", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: "ping",
        max_output_tokens: 1,
        store: false
      })
    }));
  });
});
