import type { AppConfig, TraditionalApiConfig } from "./config.js";
import { rawAmountToDecimalString } from "./money.js";
import { enabledTraditionalApis, traditionalApiPublicPathPrefix } from "./paid-http/proxy.js";

export function effectiveTraditionalApiRateLimit(
  config: AppConfig,
  api: TraditionalApiConfig
): { max: number; timeWindowMs: number } {
  return {
    max: api.rateLimit?.max ?? config.rateLimit.max,
    timeWindowMs: api.rateLimit?.timeWindowMs ?? config.rateLimit.timeWindowMs
  };
}

export function buildPricingPayload(config: AppConfig): Record<string, unknown> {
  const httpApis = enabledTraditionalApis(config);
  const payload: Record<string, unknown> = {
    upstream_provider: config.upstreamProvider,
    apis: httpApis.map((api) => ({
      id: api.id,
      charging_method: "per-request",
      request_price: api.requestPrice.toString(),
      request_price_decimal: rawAmountToDecimalString(api.requestPrice, config.tempo.assetDecimals),
      methods: api.methods,
      path_prefix: traditionalApiPublicPathPrefix(config, api),
      allow_unmatched_routes: api.allowUnmatchedRoutes !== false,
      rate_limit: effectiveTraditionalApiRateLimit(config, api),
      routes: api.routes.map((route) => ({
        id: route.id,
        path: route.path,
        methods: route.methods,
        request_price: route.requestPrice.toString(),
        request_price_decimal: rawAmountToDecimalString(route.requestPrice, config.tempo.assetDecimals)
      })),
      asset_symbol: api.assetSymbol,
      asset_address: api.assetAddress,
      asset_decimals: config.tempo.assetDecimals,
      chain_id: api.chainId
    }))
  };

  if (config.upstreamProvider !== "openai") {
    return payload;
  }

  return {
    ...payload,
    openai_endpoints: config.openaiEndpointWhitelist,
    session_billing: {
      reserve_mode: config.sessionBilling.reserveMode,
      settlement_mode: config.sessionBilling.settlementMode,
      unit_amount: config.sessionBilling.unitAmount.toString(),
      unit_type: config.sessionBilling.unitType
    },
    models: config.models.filter((model) => model.enabled).map((model) => ({
      model: model.modelName,
      charging_method: config.chargingMethod,
      input_price_per_million: model.inputPricePerMillion.toString(),
      cached_input_price_per_million: model.cachedInputPricePerMillion?.toString(),
      output_price_per_million: model.outputPricePerMillion.toString(),
      image_text_input_price_per_million: model.imageTextInputPricePerMillion?.toString(),
      image_input_price_per_million: model.imageInputPricePerMillion?.toString(),
      image_output_price_per_million: model.imageOutputPricePerMillion?.toString(),
      image_max_output_tokens: model.imageMaxOutputTokens,
      request_price: (model.requestPrice ?? model.minimumCharge).toString(),
      minimum_charge: model.minimumCharge.toString(),
      default_max_tokens: model.defaultMaxTokens,
      max_tokens_limit: model.maxTokensLimit,
      context_window: model.contextWindow,
      knowledge_cutoff: model.knowledgeCutoff,
      asset_symbol: model.assetSymbol,
      asset_address: model.assetAddress,
      asset_decimals: config.tempo.assetDecimals,
      chain_id: model.chainId
    }))
  };
}
