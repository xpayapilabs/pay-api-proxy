export interface TempoLog {
  address: string;
  topics: string[];
  data: string;
}

export interface TempoTransactionReceipt {
  status: string;
  blockNumber: string;
  blockHash?: string;
  logs: TempoLog[];
}

export interface TempoTransaction {
  hash: string;
  input: string;
}

export interface TempoRpcClient {
  getTransactionReceipt(hash: string): Promise<TempoTransactionReceipt | null>;
  getTransactionByHash(hash: string): Promise<TempoTransaction | null>;
  getChainId(): Promise<number>;
  sendRawTransaction(rawTransaction: string): Promise<string>;
}

export class HttpTempoRpcClient implements TempoRpcClient {
  constructor(private readonly rpcUrl: string) {}

  async getTransactionReceipt(hash: string): Promise<TempoTransactionReceipt | null> {
    const result = await this.call("eth_getTransactionReceipt", [hash]);
    if (result === null || result === undefined) return null;
    if (typeof result !== "object") {
      throw new Error("Unexpected response shape from Tempo RPC eth_getTransactionReceipt");
    }
    return result as TempoTransactionReceipt;
  }

  async getTransactionByHash(hash: string): Promise<TempoTransaction | null> {
    const result = await this.call("eth_getTransactionByHash", [hash]);
    if (result === null || result === undefined) return null;
    if (typeof result !== "object") {
      throw new Error("Unexpected response shape from Tempo RPC eth_getTransactionByHash");
    }
    return result as TempoTransaction;
  }

  async getChainId(): Promise<number> {
    const result = await this.call("eth_chainId", []);
    if (typeof result !== "string") throw new Error("Unexpected response shape from Tempo RPC eth_chainId");
    return Number(BigInt(result));
  }

  async sendRawTransaction(rawTransaction: string): Promise<string> {
    let result: unknown;
    try {
      result = await this.call("eth_sendRawTransactionSync", [rawTransaction]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("method") && !message.includes("not found") && !message.includes("not supported")) {
        throw error;
      }
      result = await this.call("eth_sendRawTransaction", [rawTransaction]);
    }

    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const candidate = result as Record<string, unknown>;
      if (typeof candidate.transactionHash === "string") return candidate.transactionHash;
      if (typeof candidate.hash === "string") return candidate.hash;
    }
    throw new Error("Unexpected response shape from Tempo RPC transaction broadcast");
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
    });
    if (!response.ok) {
      throw new Error(`Tempo RPC HTTP ${response.status}`);
    }
    const json = (await response.json()) as { result?: unknown; error?: { message?: string; code?: number } };
    if (json.error) {
      throw new Error(`Tempo RPC error: ${json.error.message ?? "unknown"}`);
    }
    return json.result;
  }
}
