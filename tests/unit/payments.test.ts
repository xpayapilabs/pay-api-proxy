import { testConfig } from "../../src/core/config.js";
import { DEFAULT_MODELS } from "../../src/core/models.js";
import { quoteAiTokenRequest as quoteChatRequest } from "../../src/charging/index.js";
import { encodePaymentCredential } from "../../src/payments/credential.js";
import { TestPaymentProvider } from "../helpers/test-payment-provider.js";
import { TempoPaymentProvider } from "../../src/payments/tempo.js";
import type { TempoRpcClient, TempoTransaction, TempoTransactionReceipt } from "../../src/payments/tempo-rpc.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function topicAddress(address: string): string {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function topicValue(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

function transferReceipt(args: {
  asset: string;
  recipient: string;
  amount: bigint;
  extraAmount?: bigint;
  status?: string;
}): TempoTransactionReceipt {
  const logs = [
    {
      address: args.asset.toLowerCase(),
      topics: [TRANSFER_TOPIC, topicAddress("0x000000000000000000000000000000000000dead"), topicAddress(args.recipient)],
      data: topicValue(args.amount)
    }
  ];
  if (args.extraAmount !== undefined) {
    logs.push({
      address: args.asset.toLowerCase(),
      topics: [TRANSFER_TOPIC, topicAddress("0x000000000000000000000000000000000000beef"), topicAddress(args.recipient)],
      data: topicValue(args.extraAmount)
    });
  }

  return {
    status: args.status ?? "0x1",
    blockNumber: "0x10",
    logs
  };
}

class StubRpc implements TempoRpcClient {
  constructor(
    private readonly receipts: Map<string, TempoTransactionReceipt | null>,
    private readonly transactions: Map<string, TempoTransaction | null> = new Map(),
    private readonly chainId = 42431,
    private readonly broadcastHash = `0x${"9".repeat(64)}`
  ) {}
  async getTransactionReceipt(hash: string): Promise<TempoTransactionReceipt | null> {
    return this.receipts.has(hash) ? this.receipts.get(hash)! : null;
  }
  async getTransactionByHash(hash: string): Promise<TempoTransaction | null> {
    if (this.transactions.has(hash)) return this.transactions.get(hash)!;
    return this.receipts.has(hash) ? memoTransaction(hash, "req_payment") : null;
  }
  async getChainId(): Promise<number> {
    return this.chainId;
  }
  async sendRawTransaction(_rawTransaction: string): Promise<string> {
    return this.broadcastHash;
  }
}

function memoTransaction(hash: string, memo: string): TempoTransaction {
  return {
    hash,
    input: `0x1234${Buffer.from(`pay-api-proxy:mpp:v1:${memo}`, "utf8").toString("hex")}`
  };
}

describe("payments", () => {
  const config = testConfig();
  const model = DEFAULT_MODELS[0];
  const quote = quoteChatRequest(
    "req_payment",
    {
      model: model.modelName,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100
    },
    model
  );

  it("parses and verifies deterministic test transaction credentials", async () => {
    const provider = new TestPaymentProvider(config);
    const challenge = provider.createChallenge(quote);
    const header = encodePaymentCredential({
      type: "transaction",
      value: "signed-tempo-transaction",
      amount: challenge.amount,
      chainId: challenge.chainId,
      assetAddress: challenge.assetAddress,
      recipient: challenge.settlementAddress,
      memo: challenge.memo
    });

    const credential = provider.parseCredential(header);
    expect(credential?.type).toBe("transaction");
    const verified = await provider.verifyCredential(credential!, challenge);
    expect(verified.status).toBe("settled");
    expect(verified.prepaidMaxAmount).toBe(challenge.amount);
  });

  it("rejects underpaid credentials", async () => {
    const provider = new TestPaymentProvider(config);
    const challenge = provider.createChallenge(quote);
    const credential = {
      type: "transaction" as const,
      value: "signed-tempo-transaction",
      amount: "1",
      chainId: challenge.chainId,
      assetAddress: challenge.assetAddress,
      recipient: challenge.settlementAddress,
      memo: challenge.memo
    };

    await expect(provider.verifyCredential(credential, challenge)).rejects.toThrow(/insufficient/);
  });

  describe("Tempo provider", () => {
    const tempoConfig = testConfig({
      tempo: {
        rpcUrl: "https://rpc.example",
        chainId: 42431,
        settlementAddress: "0x1111111111111111111111111111111111111111",
        acceptedAsset: "0x2222222222222222222222222222222222222222",
        assetDecimals: 6
      }
    });

    it("advertises transaction and hash credential types", () => {
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map()));
      const challenge = provider.createChallenge(quote);
      expect(challenge.credentialTypes).toEqual(["transaction", "hash"]);
      expect(challenge.settlementAddress).toBe(tempoConfig.tempo.settlementAddress);
    });

    it("broadcasts transaction credentials before verifying the resulting receipt", async () => {
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map()));
      const challenge = provider.createChallenge(quote);
      const txHash = `0x${"9".repeat(64)}`;
      const receipt = transferReceipt({
        asset: tempoConfig.tempo.acceptedAsset,
        recipient: tempoConfig.tempo.settlementAddress,
        amount: BigInt(challenge.amount)
      });
      const rpc = new StubRpc(new Map([[txHash, receipt]]), new Map([[txHash, memoTransaction(txHash, "req_payment")]]));

      const verified = await new TempoPaymentProvider(tempoConfig, rpc).verifyCredential({
        type: "transaction",
        value: "0x76f901",
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge);

      expect(verified.credentialType).toBe("transaction");
      expect(verified.settlementTx).toBe(txHash);
      void provider;
    });

    it("verifies a hash credential against an on-chain Transfer log", async () => {
      const provider = new TempoPaymentProvider(tempoConfig);
      const challenge = provider.createChallenge(quote);
      const txHash = `0x${"a".repeat(64)}`;
      const rpc = new StubRpc(new Map([[
        txHash,
        transferReceipt({
          asset: tempoConfig.tempo.acceptedAsset,
          recipient: tempoConfig.tempo.settlementAddress,
          amount: BigInt(challenge.amount)
        })
      ]]));
      const verified = await new TempoPaymentProvider(tempoConfig, rpc).verifyCredential({
        type: "hash",
        value: txHash,
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge);

      expect(verified.status).toBe("settled");
      expect(verified.settlementTx).toBe(txHash);
      expect(verified.prepaidMaxAmount).toBe(challenge.amount);
      void provider;
    });

    it("records the verified on-chain amount instead of the claimed credential amount", async () => {
      const challenge = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map())).createChallenge(quote);
      const txHash = `0x${"f".repeat(64)}`;
      const onChainAmount = BigInt(challenge.amount) + 123n;
      const receipt = transferReceipt({
        asset: tempoConfig.tempo.acceptedAsset,
        recipient: tempoConfig.tempo.settlementAddress,
        amount: onChainAmount
      });
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map([[txHash, receipt]])));
      const verified = await provider.verifyCredential({
        type: "hash",
        value: txHash,
        amount: (onChainAmount + 999n).toString(),
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge);

      expect(verified.prepaidMaxAmount).toBe(onChainAmount.toString());
      expect(verified.settledAmount).toBe(onChainAmount.toString());
    });

    it("sums multiple matching transfer logs for receipt accounting", async () => {
      const challenge = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map())).createChallenge(quote);
      const txHash = `0x${"0".repeat(64)}`;
      const firstAmount = BigInt(challenge.amount) - 1n;
      const secondAmount = 5n;
      const receipt = transferReceipt({
        asset: tempoConfig.tempo.acceptedAsset,
        recipient: tempoConfig.tempo.settlementAddress,
        amount: firstAmount,
        extraAmount: secondAmount
      });
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map([[txHash, receipt]])));
      const verified = await provider.verifyCredential({
        type: "hash",
        value: txHash,
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge);

      expect(verified.prepaidMaxAmount).toBe((firstAmount + secondAmount).toString());
      expect(verified.settlementVerification).toBe("onchain");
    });

    it("rejects a hash credential when the RPC is pointed at the wrong chain", async () => {
      const challenge = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map())).createChallenge(quote);
      const txHash = `0x${"1".repeat(64)}`;
      const receipt = transferReceipt({
        asset: tempoConfig.tempo.acceptedAsset,
        recipient: tempoConfig.tempo.settlementAddress,
        amount: BigInt(challenge.amount)
      });
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map([[txHash, receipt]]), new Map(), 1));
      await expect(provider.verifyCredential({
        type: "hash",
        value: txHash,
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge)).rejects.toThrow(/chain mismatch/i);
    });

    it("accepts a hash credential based on matching receipt payment effects", async () => {
      const challenge = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map())).createChallenge(quote);
      const txHash = `0x${"2".repeat(64)}`;
      const receipt = transferReceipt({
        asset: tempoConfig.tempo.acceptedAsset,
        recipient: tempoConfig.tempo.settlementAddress,
        amount: BigInt(challenge.amount)
      });
      const provider = new TempoPaymentProvider(
        tempoConfig,
        new StubRpc(new Map([[txHash, receipt]]), new Map([[txHash, memoTransaction(txHash, "req_other")]]))
      );
      const verified = await provider.verifyCredential({
        type: "hash",
        value: txHash,
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge);

      expect(verified.settlementTx).toBe(txHash);
    });

    it("rejects a hash credential when the transaction is missing", async () => {
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map()));
      const challenge = provider.createChallenge(quote);
      await expect(provider.verifyCredential({
        type: "hash",
        value: `0x${"b".repeat(64)}`,
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge)).rejects.toThrow(/not found/i);
    });

    it("rejects a hash credential whose receipt has no matching transfer", async () => {
      const challenge = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map())).createChallenge(quote);
      const txHash = `0x${"c".repeat(64)}`;
      const wrongRecipient = transferReceipt({
        asset: tempoConfig.tempo.acceptedAsset,
        recipient: "0x9999999999999999999999999999999999999999",
        amount: BigInt(challenge.amount)
      });
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map([[txHash, wrongRecipient]])));
      await expect(provider.verifyCredential({
        type: "hash",
        value: txHash,
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge)).rejects.toThrow(/Transfer/);
    });

    it("rejects a hash credential when the transfer amount is too low", async () => {
      const challenge = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map())).createChallenge(quote);
      const txHash = `0x${"d".repeat(64)}`;
      const underpaid = transferReceipt({
        asset: tempoConfig.tempo.acceptedAsset,
        recipient: tempoConfig.tempo.settlementAddress,
        amount: BigInt(challenge.amount) - 1n
      });
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map([[txHash, underpaid]])));
      await expect(provider.verifyCredential({
        type: "hash",
        value: txHash,
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge)).rejects.toThrow(/Transfer/);
    });

    it("rejects a reverted transaction", async () => {
      const challenge = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map())).createChallenge(quote);
      const txHash = `0x${"e".repeat(64)}`;
      const reverted = transferReceipt({
        asset: tempoConfig.tempo.acceptedAsset,
        recipient: tempoConfig.tempo.settlementAddress,
        amount: BigInt(challenge.amount),
        status: "0x0"
      });
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map([[txHash, reverted]])));
      await expect(provider.verifyCredential({
        type: "hash",
        value: txHash,
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge)).rejects.toThrow(/did not succeed/i);
    });

    it("rejects a malformed hash", async () => {
      const provider = new TempoPaymentProvider(tempoConfig, new StubRpc(new Map()));
      const challenge = provider.createChallenge(quote);
      await expect(provider.verifyCredential({
        type: "hash",
        value: "not-a-hash",
        amount: challenge.amount,
        chainId: challenge.chainId,
        assetAddress: challenge.assetAddress,
        recipient: challenge.settlementAddress,
        memo: challenge.memo
      }, challenge)).rejects.toThrow(/32-byte hex/);
    });
  });
});
