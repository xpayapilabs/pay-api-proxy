import type { OpenAiCompatibleEndpoint } from "./config.js";

export const DEFAULT_APP_SETTINGS = {
  nodeEnv: "development",
  host: "0.0.0.0",
  port: 8080,
  databasePath: "./data/pay-api-proxy.sqlite",
  paymentProvider: "tempo-testnet",
  publicBaseUrl: "http://localhost",
  corsAllowOrigin: "*",
  maxRequestBodyBytes: 1_048_576,
  upstreamProvider: "http",
  chargingMethod: "ai-token",
  sessionBilling: {
    reserveMode: "max-quote",
    settlementMode: "actual-usage",
    unitAmount: "1",
    unitType: "asset-smallest-unit"
  },
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiEndpointWhitelist: ["models", "chat_completions", "images"] satisfies OpenAiCompatibleEndpoint[],
  tempo: {
    rpcUrl: "https://rpc.moderato.tempo.xyz",
    chainId: 42431,
    settlementAddress: "0x0000000000000000000000000000000000000000",
    acceptedAsset: "0x20c0000000000000000000000000000000000000",
    assetDecimals: 6
  }
} as const;
