import type { AppConfig } from "../core/config.js";
import { DisabledAiProvider } from "./disabled.js";
import { OpenAiCompatibleProvider } from "./openai.js";
import type { AiProvider } from "./types.js";

export function createAiProvider(config: AppConfig): AiProvider {
  if (config.upstreamProvider === "openai") return new OpenAiCompatibleProvider(config);
  return new DisabledAiProvider();
}
