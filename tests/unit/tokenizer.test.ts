import { countTextTokens, estimateChatInputTokens } from "../../src/core/tokenizer.js";

describe("tokenizer", () => {
  it("counts plain text with the o200k_base encoder", () => {
    expect(countTextTokens("a small cube")).toBe(3);
    expect(countTextTokens("what is Chengdu")).toBe(4);
  });

  it("uses a conservative serialized-message count inside chat input estimates", () => {
    expect(estimateChatInputTokens([{ role: "user", content: "a small cube" }])).toBe(19);
  });
});
