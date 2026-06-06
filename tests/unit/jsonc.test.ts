import { parseJsoncObject, stripJsonTrailingCommas } from "../../src/core/jsonc.js";

describe("jsonc parser", () => {
  it("accepts comments and trailing commas in objects and arrays", () => {
    expect(parseJsoncObject(`{
      // Operators often leave trailing commas while editing JSONC config.
      "responseSanitizer": {
        "removeJsonKeys": ["cost", "remain_money",],
      },
      "apis": [
        { "id": "wechat", },
      ],
    }`, "test config")).toEqual({
      responseSanitizer: {
        removeJsonKeys: ["cost", "remain_money"]
      },
      apis: [
        { id: "wechat" }
      ]
    });
  });

  it("does not strip commas inside string values", () => {
    expect(stripJsonTrailingCommas(`{ "text": "keep this comma,]", "items": ["a",] }`)).toBe(
      `{ "text": "keep this comma,]", "items": ["a"] }`
    );
  });
});
