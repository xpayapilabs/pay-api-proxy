import { createHash } from "node:crypto";
import type { FastifyReply } from "fastify";
import { nanoid } from "nanoid";
import { amountToSessionUnits, type SessionSettlementAmount } from "../charging/session-meter.js";
import { bigintToString } from "../core/money.js";
import type { Repository } from "../db/repository.js";
import type { MppxSessionAdapter } from "../payments/mppx-session.js";
import { signReceiptPayload, stableJson } from "../receipts/receipt.js";
import type {
  ReceiptInput,
  ReceiptOutput,
  ReserveInput,
  ReserveOutcome,
  SessionAuthorization,
  SessionBackend,
  SettleInput,
  SettleOutcome
} from "./types.js";

interface MppxAuthorization extends SessionAuthorization {
  kind: "mppx";
  receipt: unknown;
  reservedAmount: bigint;
}

interface MppxSettleContext {
  finalReceipt: {
    channelId: `0x${string}`;
    challengeId: string;
    serialized: string;
    txHash?: string;
  };
  settlement: SessionSettlementAmount;
}

export class MppxSessionBackend implements SessionBackend {
  readonly name = "mppx" as const;

  constructor(
    private readonly adapter: MppxSessionAdapter,
    private readonly repository: Repository
  ) {}

  /**
   * Empty-body preflight for the mppx session credential. If the caller has attached
   * an Authorization: Payment header but sent no/invalid body, mppx may want to
   * respond with a challenge or a channel-management response (e.g. close request).
   * If mppx returns an authorized debit instead, we release immediately because we
   * have no body to actually bill against.
   *
   * Returns a Response to forward verbatim, or undefined to mean "fall through to
   * normal invalid_body handling".
   */
  async preflightEmptyBody(request: import("fastify").FastifyRequest): Promise<Response | undefined> {
    const authorization = await this.adapter.authorizeRequest({ request, body: {} });
    if (authorization.kind === "challenge" || authorization.kind === "management") {
      return authorization.response;
    }
    try {
      await this.adapter.releaseAuthorization(authorization.receipt, authorization.reservedAmount);
    } catch {
      // Release is best-effort; the upstream invalid_body response is more important.
    }
    return undefined;
  }

  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    const authorization = await this.adapter.authorizeRequest({
      request: input.request,
      body: input.body,
      quote: input.quote,
      reservedAmount: input.sessionQuote.reservedAmount
    });
    if (authorization.kind === "challenge" || authorization.kind === "management") {
      return { kind: "raw_response", response: authorization.response };
    }

    const created = this.repository.transaction(() => {
      if (this.repository.getRequest(input.requestId)) return false;
      this.repository.createRequest({
        id: input.requestId,
        model: input.model.modelName,
        status: "running",
        inputTokensEstimate: input.quote.inputTokensEstimate,
        maxOutputTokens: input.quote.maxOutputTokens,
        maxCharge: bigintToString(input.sessionQuote.reservedAmount)
      });
      return true;
    });
    if (!created) {
      await this.adapter.releaseAuthorization(authorization.receipt, authorization.reservedAmount);
      return { kind: "error", status: 409, code: "request_id_already_used", message: "Request id has already been used" };
    }

    const result: MppxAuthorization = {
      kind: "mppx",
      receipt: authorization.receipt,
      reservedAmount: authorization.reservedAmount
    };
    return { kind: "reserved", authorization: result };
  }

  async settle(input: SettleInput): Promise<SettleOutcome> {
    const auth = input.authorization as MppxAuthorization;
    // The mppx voucher is the strict upper bound on what we can claim. If the
    // settled actual exceeds it (e.g. a tokenizer-estimate undercount), cap at
    // the voucher rather than 502'ing — the operator absorbs the small delta,
    // mirroring InternalSessionBackend's repository.settlePaymentReservation
    // which clamps actual to reserved.
    const cappedSettlement = capSettlementToReserved(input.settlement, auth.reservedAmount);
    const finalMppxReceipt = await this.adapter.finalizeUsage(
      auth.receipt as Parameters<MppxSessionAdapter["finalizeUsage"]>[0],
      cappedSettlement
    );
    // Complete the request after the mppx-side settlement succeeds so a failed
    // finalizeUsage leaves the request "running" and the release path can roll it back.
    this.repository.completeRequest(
      input.requestId,
      input.usage.inputTokens,
      input.usage.outputTokens,
      cappedSettlement.totalAmount.toString()
    );
    return {
      context: {
        finalReceipt: {
          channelId: finalMppxReceipt.channelId,
          challengeId: finalMppxReceipt.challengeId,
          serialized: this.adapter.serializeReceipt(finalMppxReceipt),
          txHash: typeof (finalMppxReceipt as { txHash?: unknown }).txHash === "string"
            ? (finalMppxReceipt as { txHash: string }).txHash
            : undefined
        },
        settlement: cappedSettlement
      } satisfies MppxSettleContext
    };
  }

  async release(authorization: SessionAuthorization, requestId: string): Promise<void> {
    const auth = authorization as MppxAuthorization;
    try {
      await this.adapter.releaseAuthorization(
        auth.receipt as Parameters<MppxSessionAdapter["releaseAuthorization"]>[0],
        auth.reservedAmount
      );
    } catch {
      // mppx release is best-effort; we still mark the request failed.
    }
    this.repository.failRequest(requestId, "upstream_error");
  }

  buildReceiptAndHeaders(input: ReceiptInput): ReceiptOutput {
    const auth = input.authorization as MppxAuthorization;
    const { finalReceipt, settlement } = input.settle.context as MppxSettleContext;
    const receiptId = `rcpt_${nanoid(16)}`;
    const difference = auth.reservedAmount > settlement.totalAmount
      ? auth.reservedAmount - settlement.totalAmount
      : 0n;

    const payload = {
      receipt_id: receiptId,
      request_id: input.requestId,
      payment_id: `mppx:${finalReceipt.channelId}`,
      issued_at: new Date().toISOString(),
      model: input.model.modelName,
      usage: {
        input_tokens: input.usage.inputTokens,
        output_tokens: input.usage.outputTokens,
        total_tokens: input.usage.inputTokens + input.usage.outputTokens
      },
      pricing: {
        prepaid_max_amount: auth.reservedAmount.toString(),
        actual_usage_amount: settlement.totalAmount.toString(),
        difference_amount: difference.toString()
      },
      session: {
        backend: "mppx",
        channel_id: finalReceipt.channelId,
        challenge_id: finalReceipt.challengeId
      },
      settlement: {
        protocol: "mppx",
        chain_id: input.config.tempo.chainId,
        asset_address: input.config.tempo.acceptedAsset,
        credential_type: "session",
        // challenge_hash is a content-addressed identifier of the challenge id,
        // not a hash of a verified credential. Named to distinguish it from the
        // internal-session receipt's credential_hash.
        challenge_hash: createHash("sha256").update(finalReceipt.challengeId).digest("hex"),
        settlement_tx: finalReceipt.txHash
      },
      mppx_receipt: auth.receipt
    };
    const { receiptHash, signature } = signReceiptPayload(payload, input.config.nodeSigningSecret);

    return {
      receiptId,
      receiptHash,
      signature,
      payloadJson: stableJson(payload),
      status: "pending",
      applyHeaders: (reply: FastifyReply) => {
        reply
          .header("payment-receipt", finalReceipt.serialized)
          .header("x-paid-receipt-id", receiptId)
          .header("x-mppx-channel-id", finalReceipt.channelId)
          .header("x-session-billing-unit-type", settlement.unitType)
          .header("x-session-billing-units", settlement.totalUnits.toString());
      }
    };
  }
}

function capSettlementToReserved(settlement: SessionSettlementAmount, reservedAmount: bigint): SessionSettlementAmount {
  if (settlement.totalAmount <= reservedAmount) return settlement;
  return {
    ...settlement,
    totalAmount: reservedAmount,
    totalUnits: amountToSessionUnits(reservedAmount, settlement.unitAmount)
  };
}
