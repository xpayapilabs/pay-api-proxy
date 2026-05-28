import type { AppConfig } from "../core/config.js";
import { TempoPaymentProvider } from "./tempo.js";
import type { PaymentProvider } from "./types.js";

export function createPaymentProvider(config: AppConfig): PaymentProvider {
  return new TempoPaymentProvider(config);
}
