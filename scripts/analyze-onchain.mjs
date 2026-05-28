// One-shot Tempo Moderato analyzer for two wallets.
//
// Pulls:
//   1. pathUSD ERC20 Transfer logs touching either wallet (recent ~50k blocks).
//   2. Escrow contract events (ChannelOpened/Closed/Settled/TopUp/CloseRequested)
//      whose indexed payer or payee matches either wallet.
// For each unique tx, fetches receipt + tx and decodes:
//   - method (first 4 bytes of input vs known escrow + TIP20 selectors)
//   - gas used × effective gas price → cost in wei and pathUSD-equivalent
//
// Usage: node scripts/analyze-onchain.mjs
import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, toHex, toBytes, decodeAbiParameters, formatUnits } from "viem";

const RPC = "https://rpc.moderato.tempo.xyz";
const ESCROW = "0xe1c4d3dce17bc111181ddf716f75bae49e61a336".toLowerCase();
const PATHUSD = "0x20c0000000000000000000000000000000000000".toLowerCase();
const WALLET_CONFIG_PATH = new URL("./analyze-onchain-wallets.jsonc", import.meta.url);
const WALLET_CONFIG = parseJsoncObject(readFileSync(WALLET_CONFIG_PATH, "utf8"), WALLET_CONFIG_PATH.pathname);
const WALLET_ENTRIES = readWalletEntries(WALLET_CONFIG);
const WALLETS = WALLET_ENTRIES.map((entry) => entry.address);
const WALLET_LABEL = Object.fromEntries(WALLET_ENTRIES.map((entry) => [entry.address, entry.label]));
const PAD = (a) => "0x" + "0".repeat(24) + a.slice(2);

// Pre-compute event topic hashes
const TRANSFER_TOPIC      = keccak256(toBytes("Transfer(address,address,uint256)"));
const CHANNEL_OPENED      = keccak256(toBytes("ChannelOpened(bytes32,address,address,address,address,bytes32,uint256)"));
const CHANNEL_CLOSED      = keccak256(toBytes("ChannelClosed(bytes32,address,address,uint256,uint256)"));
const CHANNEL_EXPIRED     = keccak256(toBytes("ChannelExpired(bytes32,address,address)"));
const SETTLED             = keccak256(toBytes("Settled(bytes32,address,address,uint256,uint256,uint256)"));
const TOPUP               = keccak256(toBytes("TopUp(bytes32,address,address,uint256,uint256)"));
const CLOSE_REQUESTED     = keccak256(toBytes("CloseRequested(bytes32,address,address,uint256)"));
const CLOSE_REQ_CANCELLED = keccak256(toBytes("CloseRequestCancelled(bytes32,address,address)"));

const EVENT_NAMES = {
  [TRANSFER_TOPIC]: "Transfer",
  [CHANNEL_OPENED]: "ChannelOpened",
  [CHANNEL_CLOSED]: "ChannelClosed",
  [CHANNEL_EXPIRED]: "ChannelExpired",
  [SETTLED]: "Settled",
  [TOPUP]: "TopUp",
  [CLOSE_REQUESTED]: "CloseRequested",
  [CLOSE_REQ_CANCELLED]: "CloseRequestCancelled"
};

// Pre-compute function selectors
const sel = (sig) => keccak256(toBytes(sig)).slice(0, 10);
const ESCROW_FUNCS = {
  [sel("open(address,address,uint128,bytes32,address)")]: "open",
  [sel("topUp(bytes32,uint256)")]: "topUp",
  [sel("close(bytes32,uint128,bytes)")]: "close",
  [sel("settle(bytes32,uint128,bytes)")]: "settle",
  [sel("requestClose(bytes32)")]: "requestClose",
  [sel("withdraw(bytes32)")]: "withdraw"
};
const TIP20_FUNCS = {
  [sel("transfer(address,uint256)")]: "transfer",
  [sel("approve(address,uint256)")]: "approve",
  [sel("transferWithMemo(address,uint256,bytes32)")]: "transferWithMemo",
  [sel("transferFrom(address,address,uint256)")]: "transferFrom"
};

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function getLogsRange(fromBlock, toBlock, filter) {
  return rpc("eth_getLogs", [{ ...filter, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }]);
}

async function getLogsChunked(fromBlock, toBlock, filter, chunkSize = 5000n) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    const to = from + chunkSize - 1n > toBlock ? toBlock : from + chunkSize - 1n;
    try {
      const logs = await getLogsRange(from, to, filter);
      out.push(...logs);
    } catch (e) {
      if (e.message.includes("range") || e.message.includes("limit")) {
        // retry with smaller chunk
        const mid = (from + to) / 2n;
        out.push(...await getLogsChunked(from, mid, filter, (mid - from) / 2n + 1n));
        out.push(...await getLogsChunked(mid + 1n, to, filter, (to - mid) / 2n + 1n));
      } else {
        throw e;
      }
    }
  }
  return out;
}

function classifyMethod(tx) {
  if (!tx) return "(unknown tx)";
  if (tx.to && tx.to.toLowerCase() === ESCROW) {
    const selector = (tx.input || "0x").slice(0, 10);
    return `escrow.${ESCROW_FUNCS[selector] ?? `<${selector}>`}`;
  }
  if (tx.to && tx.to.toLowerCase() === PATHUSD) {
    const selector = (tx.input || "0x").slice(0, 10);
    return `pathUSD.${TIP20_FUNCS[selector] ?? `<${selector}>`}`;
  }
  if (!tx.input || tx.input === "0x") return "value transfer";
  return `other(${tx.to?.slice(0, 10) ?? "?"}…)`;
}

function decodeChannelEvent(log) {
  const topic = log.topics[0];
  const name = EVENT_NAMES[topic] ?? "?";
  // Most channel events have (bytes32 channelId, address payer, address payee, ...)
  // ChannelOpened: payer indexed (topic1), payee indexed (topic2), channelId data
  // ChannelClosed/Settled/TopUp/CloseRequested: channelId indexed (topic1), payer indexed (topic2), payee indexed (topic3)
  let payer, payee, channelId;
  if (name === "ChannelOpened") {
    payer = log.topics[1] ? "0x" + log.topics[1].slice(26) : undefined;
    payee = log.topics[2] ? "0x" + log.topics[2].slice(26) : undefined;
  } else {
    channelId = log.topics[1];
    payer = log.topics[2] ? "0x" + log.topics[2].slice(26) : undefined;
    payee = log.topics[3] ? "0x" + log.topics[3].slice(26) : undefined;
  }
  return { name, channelId, payer, payee };
}

async function main() {
  const latest = BigInt(await rpc("eth_blockNumber", []));
  const lookback = 200_000n;
  const from = latest > lookback ? latest - lookback : 0n;
  console.error(`Scanning blocks ${from} .. ${latest} (${latest - from} blocks)`);

  // 1) pathUSD Transfer logs where from or to is one of our wallets.
  const transferLogs = [];
  for (const wallet of WALLETS) {
    const padded = PAD(wallet);
    transferLogs.push(...await getLogsChunked(from, latest, {
      address: PATHUSD, topics: [TRANSFER_TOPIC, padded]
    }));
    transferLogs.push(...await getLogsChunked(from, latest, {
      address: PATHUSD, topics: [TRANSFER_TOPIC, null, padded]
    }));
  }
  console.error(`pathUSD Transfer logs touching either wallet: ${transferLogs.length}`);

  // 2) Escrow events. ChannelOpened indexes payer/payee in topics 1,2.
  //    Other events index channelId in topic 1 and payer/payee in topics 2,3.
  const escrowLogs = [];
  // ChannelOpened — payer or payee match
  for (const wallet of WALLETS) {
    const padded = PAD(wallet);
    escrowLogs.push(...await getLogsChunked(from, latest, {
      address: ESCROW, topics: [CHANNEL_OPENED, padded]
    }));
    escrowLogs.push(...await getLogsChunked(from, latest, {
      address: ESCROW, topics: [CHANNEL_OPENED, null, padded]
    }));
  }
  // Other channel events — payer in topic 2, payee in topic 3
  for (const eventTopic of [CHANNEL_CLOSED, CHANNEL_EXPIRED, SETTLED, TOPUP, CLOSE_REQUESTED, CLOSE_REQ_CANCELLED]) {
    for (const wallet of WALLETS) {
      const padded = PAD(wallet);
      escrowLogs.push(...await getLogsChunked(from, latest, {
        address: ESCROW, topics: [eventTopic, null, padded]
      }));
      escrowLogs.push(...await getLogsChunked(from, latest, {
        address: ESCROW, topics: [eventTopic, null, null, padded]
      }));
    }
  }
  console.error(`escrow logs touching either wallet: ${escrowLogs.length}`);

  // 3) Collect unique tx hashes and fetch receipts + txs concurrently.
  const allLogs = [...transferLogs, ...escrowLogs];
  const txHashes = [...new Set(allLogs.map((l) => l.transactionHash))];
  console.error(`unique tx count: ${txHashes.length}`);

  const txs = new Map();
  const receipts = new Map();
  for (let i = 0; i < txHashes.length; i += 10) {
    const batch = txHashes.slice(i, i + 10);
    await Promise.all(batch.map(async (h) => {
      txs.set(h, await rpc("eth_getTransactionByHash", [h]));
      receipts.set(h, await rpc("eth_getTransactionReceipt", [h]));
    }));
  }

  // 4) Group logs by tx, label, sort by block, print summary.
  const byTx = new Map();
  for (const l of allLogs) {
    if (!byTx.has(l.transactionHash)) byTx.set(l.transactionHash, []);
    byTx.get(l.transactionHash).push(l);
  }
  const rows = [...byTx.entries()].map(([hash, logs]) => {
    const tx = txs.get(hash);
    const r = receipts.get(hash);
    const blockNum = BigInt(r?.blockNumber ?? "0x0");
    const gasUsed = BigInt(r?.gasUsed ?? "0x0");
    const gasPrice = BigInt(r?.effectiveGasPrice ?? tx?.gasPrice ?? "0x0");
    const cost = gasUsed * gasPrice;
    const method = classifyMethod(tx);
    const status = r?.status === "0x1" ? "ok" : (r?.status === "0x0" ? "FAIL" : "?");
    const from = tx?.from?.toLowerCase();
    const to = tx?.to?.toLowerCase();
    const sender = WALLET_LABEL[from] ?? from?.slice(0, 10);
    const target = WALLET_LABEL[to] ?? to?.slice(0, 10);
    const events = logs.map(l => {
      if (l.address.toLowerCase() === PATHUSD && l.topics[0] === TRANSFER_TOPIC) {
        const fromAddr = "0x" + l.topics[1].slice(26);
        const toAddr = "0x" + l.topics[2].slice(26);
        const [amount] = decodeAbiParameters([{ type: "uint256" }], l.data);
        const fLabel = WALLET_LABEL[fromAddr.toLowerCase()] ?? fromAddr.slice(0, 10);
        const tLabel = WALLET_LABEL[toAddr.toLowerCase()] ?? toAddr.slice(0, 10);
        return `Transfer ${fLabel}→${tLabel} ${formatUnits(amount, 6)}`;
      }
      if (l.address.toLowerCase() === ESCROW) {
        const ev = decodeChannelEvent(l);
        const pLabel = WALLET_LABEL[ev.payer?.toLowerCase()] ?? ev.payer?.slice(0, 10);
        const eLabel = WALLET_LABEL[ev.payee?.toLowerCase()] ?? ev.payee?.slice(0, 10);
        return `${ev.name} payer=${pLabel} payee=${eLabel}${ev.channelId ? " ch=" + ev.channelId.slice(0, 10) : ""}`;
      }
      return "?";
    });
    return { hash, blockNum, gasUsed, gasPrice, cost, method, status, sender, target, events };
  }).sort((a, b) => Number(a.blockNum - b.blockNum));

  // 5) Print
  console.log();
  console.log("BLOCK    | METHOD                 | STATUS | GAS     | COST (pathUSD-eq*) | SENDER → TARGET           | EVENTS");
  console.log("---------|------------------------|--------|---------|--------------------|---------------------------|--------");
  let totalCost = 0n;
  let totalGas = 0n;
  const methodTally = new Map();
  for (const r of rows) {
    const costStr = (r.cost > 0n ? formatUnits(r.cost, 18) : "0").padEnd(18);
    console.log(
      `${String(r.blockNum).padEnd(8)} | ${r.method.padEnd(22)} | ${r.status.padEnd(6)} | ${String(r.gasUsed).padStart(7)} | ${costStr} | ${(r.sender + " → " + r.target).padEnd(25)} | ${r.events.join("; ")}`
    );
    totalCost += r.cost;
    totalGas += r.gasUsed;
    methodTally.set(r.method, (methodTally.get(r.method) ?? 0) + 1);
  }

  console.log();
  console.log("--- totals ---");
  console.log(`txs: ${rows.length} | total gas: ${totalGas} | total fee: ${formatUnits(totalCost, 18)} ETH-equivalent`);
  console.log("\nmethod tally:");
  for (const [m, c] of [...methodTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(3)}  ${m}`);
  }
  console.log("\n* fee printed in ETH-style units (gas × gasPrice / 1e18). On Tempo, fees may be denominated differently — interpret as the chain's native unit.");
}

function parseJsoncObject(value, sourceName) {
  const parsed = JSON.parse(stripJsonComments(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourceName} must contain a JSON object`);
  }
  return parsed;
}

function stripJsonComments(value) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") index += 1;
      if (index < value.length) output += value[index];
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function readWalletEntries(config) {
  if (!Array.isArray(config.wallets) || config.wallets.length === 0) {
    throw new Error(`${WALLET_CONFIG_PATH.pathname} must define a non-empty wallets array`);
  }

  return config.wallets.map((wallet, index) => {
    if (!wallet || typeof wallet !== "object" || Array.isArray(wallet)) {
      throw new Error(`wallets[${index}] must be an object`);
    }
    if (typeof wallet.label !== "string" || wallet.label.length === 0) {
      throw new Error(`wallets[${index}].label must be a non-empty string`);
    }
    if (typeof wallet.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) {
      throw new Error(`wallets[${index}].address must be a 20-byte hex address`);
    }
    return {
      label: wallet.label,
      address: wallet.address.toLowerCase()
    };
  });
}

main().catch(e => { console.error(e); process.exit(1); });
