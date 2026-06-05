import type { FastifyRequest } from "fastify";
import { Credential } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { Session as MppxTempoSession } from "mppx/tempo";
import { privateKeyToAccount } from "viem/accounts";
import { createSqliteMppxStore } from "../adapters/node-container/mppx-store-sqlite.js";
import type { AppConfig } from "../core/config.js";
import { rawAmountToDecimalString } from "../core/money.js";
import type { MppxStoreHandle } from "../ports/mppx-store.js";
import type { PriceQuote, SessionSettlementAmount } from "../charging/index.js";

export type MppxSessionAuthorization =
  | { kind: "challenge"; response: Response }
  | { kind: "management"; response: Response }
  | { kind: "authorized"; receipt: MppxTempoSession.Types.SessionReceipt; reservedAmount: bigint };

type TempoSessionHandler = (input: Request) => Promise<
  | { status: 402; challenge: Response }
  | { status: 200; withReceipt(response: Response): Response }
>;

interface MppxSessionServer {
  tempo: {
    session(options: {
      amount: string;
      currency: string;
      decimals: number;
      description: string;
      recipient: string;
      suggestedDeposit: string;
      unitType: string;
    }): TempoSessionHandler;
  };
}

export class MppxSessionAdapter {
  private readonly storeHandle: MppxStoreHandle;
  private readonly channelStore: MppxTempoSession.ChannelStore.ChannelStore;
  private readonly mppx: MppxSessionServer;

  constructor(private readonly config: AppConfig) {
    if (!config.mppxSession.privateKey) {
      throw new Error("MPPX_SESSION_PRIVATE_KEY is required when mppxSession.enabled is true");
    }

    this.storeHandle = createMppxStore(config);
    this.channelStore = MppxTempoSession.ChannelStore.fromStore(this.storeHandle.store);
    this.mppx = Mppx.create({
      realm: paymentRealm(config.publicBaseUrl),
      secretKey: config.mppxSession.secretKey,
      methods: [
        tempo.session({
          account: privateKeyToAccount(config.mppxSession.privateKey),
          currency: config.tempo.acceptedAsset as `0x${string}`,
          decimals: config.tempo.assetDecimals,
          recipient: config.tempo.settlementAddress as `0x${string}`,
          rpcUrl: { [config.tempo.chainId]: config.tempo.rpcUrl },
          store: this.storeHandle.store,
          testnet: config.mppxSession.testnet,
          unitType: config.sessionBilling.unitType,
          waitForConfirmation: config.mppxSession.waitForConfirmation
        } as unknown as Parameters<typeof tempo.session>[0])
      ]
    }) as unknown as MppxSessionServer;
  }

  async authorizeRequest(params: {
    request: FastifyRequest;
    body: Record<string, unknown>;
    quote?: PriceQuote;
    reservedAmount?: bigint;
  }): Promise<MppxSessionAuthorization> {
    const options = resolveSessionOptions({
      config: this.config,
      request: params.request,
      quote: params.quote,
      reservedAmount: params.reservedAmount
    });
    const handler = this.mppx.tempo.session({
      amount: options.amount,
      currency: options.currency,
      decimals: this.config.tempo.assetDecimals,
      description: options.description,
      recipient: options.recipient,
      suggestedDeposit: options.suggestedDeposit,
      unitType: options.unitType
    });
    const result = await handler(toFetchRequest(params.request, params.body, this.config.publicBaseUrl));

    if (result.status === 402) {
      return { kind: "challenge", response: result.challenge };
    }

    const responseWithReceipt = result.withReceipt(new Response(null));
    if (responseWithReceipt.status !== 200) {
      return { kind: "management", response: responseWithReceipt };
    }

    const receiptHeader = responseWithReceipt.headers.get("payment-receipt");
    if (!receiptHeader) throw new Error("mppx session did not produce a Payment-Receipt header");

    return {
      kind: "authorized",
      receipt: MppxTempoSession.Receipt.deserializeSessionReceipt(receiptHeader),
      reservedAmount: options.reservedAmount
    };
  }

  async finalizeUsage(
    receipt: MppxTempoSession.Types.SessionReceipt,
    settlement: SessionSettlementAmount
  ): Promise<MppxTempoSession.Types.SessionReceipt> {
    const channel = await settleReservedChannelUsage(this.channelStore, receipt.channelId, settlement);

    return MppxTempoSession.Receipt.createSessionReceipt({
      acceptedCumulative: channel.highestVoucherAmount,
      challengeId: receipt.challengeId,
      channelId: receipt.channelId,
      spent: channel.spent,
      txHash: receipt.txHash,
      units: channel.units
    });
  }

  async releaseAuthorization(
    receipt: MppxTempoSession.Types.SessionReceipt,
    reservedAmount: bigint
  ): Promise<void> {
    await releaseReservedChannelAuthorization(this.channelStore, receipt.channelId, receipt, reservedAmount);
  }

  serializeReceipt(receipt: MppxTempoSession.Types.SessionReceipt): string {
    return MppxTempoSession.Receipt.serializeSessionReceipt(receipt);
  }

  close(): void {
    this.storeHandle.close();
  }
}

export function createMppxSessionAdapter(config: AppConfig): MppxSessionAdapter | undefined {
  return config.mppxSession.enabled ? new MppxSessionAdapter(config) : undefined;
}

export { rawAmountToDecimalString };

export async function settleReservedChannelUsage(
  store: MppxTempoSession.ChannelStore.ChannelStore,
  channelId: `0x${string}`,
  settlement: SessionSettlementAmount
): Promise<MppxTempoSession.ChannelStore.State> {
  const units = bigintToSafeNumber(settlement.totalUnits);
  const channel = await store.updateChannel(channelId, (current) => {
    if (!current) return null;
    if (settlement.totalAmount > current.highestVoucherAmount) {
      throw new Error(
        `mppx session settlement exceeds authorized voucher: actual ${settlement.totalAmount}, authorized ${current.highestVoucherAmount}`
      );
    }
    return {
      ...current,
      spent: settlement.totalAmount,
      units
    };
  });
  if (!channel) throw new Error("mppx session channel was not found after authorization");
  return channel;
}

/**
 * Reverses a just-issued authorization on the named channel.
 *
 * Preconditions enforced inside the atomic store update:
 *   - The channel must still be at exactly `spentAfterAuthorization` (i.e. nothing
 *     else has settled or reserved on it since this authorization). If concurrent
 *     activity advanced the channel, we throw rather than silently leave the
 *     channel inconsistent — callers must decide how to recover.
 *   - The reserved amount can be drawn back fully (cannot release more than the
 *     channel currently has spent).
 */
export async function releaseReservedChannelAuthorization(
  store: MppxTempoSession.ChannelStore.ChannelStore,
  channelId: `0x${string}`,
  receipt: MppxTempoSession.Types.SessionReceipt,
  reservedAmount: bigint
): Promise<MppxTempoSession.ChannelStore.State> {
  const spentAfterAuthorization = BigInt(receipt.spent);
  if (reservedAmount < 0n) {
    throw new Error("mppx session release requires a non-negative reservedAmount");
  }
  if (spentAfterAuthorization < reservedAmount) {
    throw new Error(
      `mppx session release inconsistent: receipt.spent ${spentAfterAuthorization} < reservedAmount ${reservedAmount}`
    );
  }
  const previousSpent = spentAfterAuthorization - reservedAmount;
  const channel = await store.updateChannel(channelId, (current) => {
    if (!current) return null;
    if (current.spent !== spentAfterAuthorization) {
      throw new Error(
        `mppx session release rejected: channel spent advanced to ${current.spent} since authorization at ${spentAfterAuthorization}`
      );
    }
    return {
      ...current,
      spent: previousSpent,
      units: Math.max(0, current.units - 1)
    };
  });
  if (!channel) throw new Error("mppx session channel was not found after authorization");
  return channel;
}

export function createMppxStore(config: AppConfig): MppxStoreHandle {
  return createSqliteMppxStore(config.databasePath);
}

function toFetchRequest(request: FastifyRequest, body: Record<string, unknown>, publicBaseUrl: string): Request {
  const url = new URL(request.url, publicBaseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else headers.set(key, String(value));
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  return new Request(url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : JSON.stringify(body)
  });
}

function resolveSessionOptions(params: {
  config: AppConfig;
  request: FastifyRequest;
  quote?: PriceQuote;
  reservedAmount?: bigint;
}): {
  amount: string;
  reservedAmount: bigint;
  currency: string;
  description: string;
  recipient: string;
  suggestedDeposit: string;
  unitType: string;
} {
  const decimals = params.config.tempo.assetDecimals;
  if (params.quote && params.reservedAmount !== undefined) {
    const amount = rawAmountToDecimalString(params.reservedAmount, decimals);
    return {
      amount,
      reservedAmount: params.reservedAmount,
      currency: params.quote.currency.assetAddress,
      description: `pay-api-proxy ${params.quote.model}`,
      recipient: params.config.tempo.settlementAddress,
      suggestedDeposit: amount,
      unitType: params.config.sessionBilling.unitType
    };
  }

  const credential = deserializeCredentialFromRequest(params.request);
  const challengeRequest = credential?.challenge.request as {
    amount?: string;
    currency?: string;
    recipient?: string;
    suggestedDeposit?: string;
    unitType?: string;
  } | undefined;
  if (!challengeRequest?.amount || !challengeRequest.currency || !challengeRequest.unitType) {
    throw new Error("mppx session credential is missing challenge request pricing");
  }

  const reservedAmount = BigInt(challengeRequest.amount);
  const amount = rawAmountToDecimalString(reservedAmount, decimals);
  const suggestedDeposit = challengeRequest.suggestedDeposit
    ? rawAmountToDecimalString(BigInt(challengeRequest.suggestedDeposit), decimals)
    : amount;
  return {
    amount,
    reservedAmount,
    currency: challengeRequest.currency,
    description: "pay-api-proxy session management",
    recipient: challengeRequest.recipient ?? params.config.tempo.settlementAddress,
    suggestedDeposit,
    unitType: challengeRequest.unitType
  };
}

function deserializeCredentialFromRequest(request: FastifyRequest): Credential.Credential | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) return undefined;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value) return undefined;
  return Credential.deserialize(value);
}

function paymentRealm(publicBaseUrl: string): string {
  try {
    return new URL(publicBaseUrl).host;
  } catch {
    return "pay-api-proxy";
  }
}

function bigintToSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`mppx session unit count exceeds JavaScript safe integer: ${value}`);
  }
  return Number(value);
}
