import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
  source: "upstream" | "estimate";
  /**
   * Optional per-modality breakdown. Populated by endpoints whose pricing depends
   * on more than a single input/output token category (e.g. images bill text
   * tokens, image input tokens, and image output tokens separately). Endpoints
   * that don't need this can leave it undefined.
   */
  details?: {
    textInputTokens?: number;
    imageInputTokens?: number;
    imageOutputTokens?: number;
  };
}

// All currently-supported OpenAI models (gpt-4o, gpt-4.1, gpt-image-*) tokenize
// with the o200k_base encoding. Import the single rank table through
// js-tiktoken/lite so we do not pull every encoding into the bundle.
let cachedEncoding: Tiktoken | undefined;

function getEncoding(): Tiktoken {
  if (!cachedEncoding) {
    cachedEncoding = new Tiktoken(o200kBase);
  }
  return cachedEncoding;
}

/**
 * Exact BPE token count for a plain-text input, using OpenAI's o200k_base
 * encoding via js-tiktoken. Use this for any quote/settlement math against
 * gpt-4o, gpt-4.1, or gpt-image-* models. For everything else this is still a
 * very close approximation.
 *
 * Falls back to the chars/4 heuristic if tiktoken throws for any reason
 * (corrupt input, etc.) so a tokenizer error never breaks a paid request.
 */
export function countTextTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  try {
    return getEncoding().encode(text).length;
  } catch {
    return estimateTokensFromText(text);
  }
}

/**
 * Legacy chars/4 heuristic. Kept as the fallback for `countTextTokens` and for
 * callers that don't need exactness (test providers, low-stakes estimation).
 * Production billing paths should prefer `countTextTokens`.
 */
export function estimateTokensFromText(text: string): number {
  if (text.trim().length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateChatInputTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;

  return messages.reduce((total, message) => {
    if (!message || typeof message !== "object") return total;
    return total + countTextTokens(JSON.stringify(message)) + 8;
  }, 0);
}
