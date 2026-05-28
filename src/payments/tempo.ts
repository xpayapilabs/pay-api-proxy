import { nanoid } from "nanoid";
import type { AppConfig } from "../core/config.js";
import { hashCredential, memoTextToBytes32, parsePaymentHeader } from "./credential.js";
import type { PaymentChallenge, PaymentCredential, PaymentProvider, VerifiedPayment } from "./types.js";
import { validateCredentialAgainstChallenge } from "./validation.js";
import type { PriceQuote } from "../charging/index.js";
import {
  HttpTempoRpcClient,
  type TempoRpcClient,
  type TempoTransactionReceipt
} from "./tempo-rpc.js";

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MEMO_PREFIX = "pay-api-proxy:mpp:v1";

export class TempoPaymentProvider implements PaymentProvider {
  private readonly rpc: TempoRpcClient;

  constructor(private readonly config: AppConfig, rpc?: TempoRpcClient) {
    this.rpc = rpc ?? new HttpTempoRpcClient(config.tempo.rpcUrl);
  }

  createChallenge(quote: PriceQuote): PaymentChallenge {
    const memoText = `${MEMO_PREFIX}:${quote.requestId}`;
    return {
      version: "pay-api-proxy-mvp-1",
      protocol: "mpp",
      chainId: this.config.tempo.chainId,
      assetAddress: this.config.tempo.acceptedAsset,
      settlementAddress: this.config.tempo.settlementAddress,
      amount: quote.maxCharge.toString(),
      memo: quote.requestId,
      memoText,
      memoHex: memoTextToBytes32(memoText),
      credentialTypes: ["transaction", "hash"]
    };
  }

  parseCredential(header: string | undefined): PaymentCredential | undefined {
    return parsePaymentHeader(header);
  }

  async verifyCredential(credential: PaymentCredential, challenge: PaymentChallenge): Promise<VerifiedPayment> {
    validateCredentialAgainstChallenge(credential, challenge);

    const chainId = await this.rpc.getChainId();
    if (chainId !== challenge.chainId) {
      throw new Error(`Tempo RPC chain mismatch: expected ${challenge.chainId}, got ${chainId}`);
    }

    const settlementTx = await this.settleCredential(credential, challenge);
    if (!/^0x[a-fA-F0-9]{64}$/.test(settlementTx)) {
      throw new Error("Tempo settlement transaction hash must be a 32-byte hex hash");
    }

    const receipt = await this.rpc.getTransactionReceipt(settlementTx);
    if (!receipt) {
      throw new Error("Tempo transaction not found on chain");
    }
    if (receipt.status !== "0x1") {
      throw new Error("Tempo transaction did not succeed on chain");
    }
    const settledAmount = sumMatchingTransferAmounts(receipt, challenge);
    if (settledAmount === undefined) {
      throw new Error("Tempo transaction does not include a matching Transfer to the node settlement address");
    }

    return {
      id: `pay_${nanoid(16)}`,
      protocol: "mpp",
      chainId: credential.chainId,
      assetAddress: credential.assetAddress,
      credentialType: credential.type,
      credentialHash: hashCredential(credential.type, credential.value),
      settlementTx,
      status: "settled",
      settlementVerification: "onchain",
      prepaidMaxAmount: settledAmount.toString(),
      settledAmount: settledAmount.toString()
    };
  }

  private async settleCredential(credential: PaymentCredential, challenge: PaymentChallenge): Promise<string> {
    if (credential.type === "hash") {
      if (!/^0x[a-fA-F0-9]{64}$/.test(credential.value)) {
        throw new Error("Tempo transaction hash credential must be a 32-byte hex hash");
      }
      if (!challenge.credentialTypes.includes("hash")) {
        throw new Error("Tempo hash credentials are not supported for this challenge");
      }
      return credential.value;
    }

    if (!/^0x[a-fA-F0-9]+$/.test(credential.value)) {
      throw new Error("Tempo transaction credential must be 0x-prefixed hex");
    }
    if (!challenge.credentialTypes.includes("transaction")) {
      throw new Error("Tempo transaction credentials are not supported for this challenge");
    }
    return this.rpc.sendRawTransaction(credential.value);
  }
}

function sumMatchingTransferAmounts(receipt: TempoTransactionReceipt, challenge: PaymentChallenge): bigint | undefined {
  if (!Array.isArray(receipt.logs)) return undefined;
  const expectedAsset = challenge.assetAddress.toLowerCase();
  const expectedRecipientTopic =
    "0x" + challenge.settlementAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const requiredAmount = BigInt(challenge.amount);

  let total = 0n;
  for (const log of receipt.logs) {
    if (!log || typeof log !== "object") continue;
    if (typeof log.address !== "string" || log.address.toLowerCase() !== expectedAsset) continue;
    if (!Array.isArray(log.topics) || log.topics.length < 3) continue;
    if (typeof log.topics[0] !== "string" || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (typeof log.topics[2] !== "string" || log.topics[2].toLowerCase() !== expectedRecipientTopic) continue;
    if (typeof log.data !== "string") continue;
    try {
      const amount = BigInt(log.data);
      total += amount;
    } catch {
      continue;
    }
  }

  return total >= requiredAmount ? total : undefined;
}
