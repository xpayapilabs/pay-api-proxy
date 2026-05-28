// Real-money smoke test for POST /v1/images/generations on Tempo testnet.
// Mirrors test-mppx-session.mjs but swaps the endpoint + body.
//
// Requirements before running:
//   - server is running locally (npx tsx src/server/index.ts) with
//     paymentProvider=tempo-testnet, upstreamProvider=openai, a real OPENAI_API_KEY,
//     PAYMENT_RECIPIENT_ADDRESS set, and MPPX_SESSION_PRIVATE_KEY set;
//   - your client wallet has pathUSD on Tempo Moderato;
//   - CLIENT_PRIVATE_KEY env var = client wallet private key (0x-prefixed 32-byte).
//
// Edit test-mppx-image.jsonc to change the request body, server URL, or output directory.
// The previous env knobs still override the JSONC values:
//   IMAGE_MODEL, IMAGE_PROMPT, IMAGE_SIZE, IMAGE_QUALITY, IMAGE_N, IMAGE_OUTPUT_DIR, SERVER_URL

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Mppx, session } from "mppx/client";
import { createClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoTestnet } from "viem/chains";

const configPath = new URL("./test-mppx-image.jsonc", import.meta.url);
const config = parseJsoncObject(readFileSync(configPath, "utf8"), configPath.pathname);

const serverUrl = readStringConfig("serverUrl", process.env.SERVER_URL ?? config.serverUrl);
const model = readStringConfig("model", process.env.IMAGE_MODEL ?? config.model);
const prompt = readStringConfig("prompt", process.env.IMAGE_PROMPT ?? config.prompt);
const size = readStringConfig("size", process.env.IMAGE_SIZE ?? config.size);
const quality = readStringConfig("quality", process.env.IMAGE_QUALITY ?? config.quality);
const n = readPositiveIntegerConfig("n", process.env.IMAGE_N ?? config.n);
const outputDir = readStringConfig("outputDir", process.env.IMAGE_OUTPUT_DIR ?? config.outputDir);
const clientPrivateKey = readPrivateKeyEnv("CLIENT_PRIVATE_KEY", process.env.CLIENT_PRIVATE_KEY);

const account = privateKeyToAccount(clientPrivateKey);

const client = createClient({
  account,
  chain: tempoTestnet,
  transport: http("https://rpc.moderato.tempo.xyz"),
});

const mppx = Mppx.create({
  polyfill: false,
  methods: [
    session({
      account,
      decimals: 6,
      getClient: () => client,
      maxDeposit: "1000000",  // 1.0 pathUSD ceiling per channel open
      onChannelUpdate(entry) {
        console.log("channel", {
          channelId: entry.channelId,
          cumulativeAmount: entry.cumulativeAmount?.toString(),
          opened: entry.opened,
        });
      },
    }),
  ],
});

let sessionChallenge;
mppx.onChallengeReceived(({ challenge }) => {
  sessionChallenge = challenge;
  return undefined;
});

const url = `${serverUrl}/v1/images/generations`;
console.log("POST", url, "model", model, "size", size, "quality", quality, "n", n);

const start = Date.now();
const response = await mppx.fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-paid-request-id": `req_mppx_img_${Date.now()}`
  },
  body: JSON.stringify({
    model,
    prompt,
    size,
    quality,
    n
  })
});
const elapsedMs = Date.now() - start;

const receiptHeader = response.headers.get("payment-receipt");
const paidReceiptId = response.headers.get("x-paid-receipt-id");
const channelId = response.headers.get("x-mppx-channel-id");
const sessionUnits = response.headers.get("x-session-billing-units");
const sessionUnitType = response.headers.get("x-session-billing-unit-type");

console.log("status", response.status, "in", elapsedMs, "ms");
console.log("x-paid-receipt-id", paidReceiptId);
console.log("x-mppx-channel-id", channelId);
console.log("session billing", sessionUnits, sessionUnitType);

const bodyText = await response.text();
if (!response.ok) {
  console.log("body", bodyText);
  process.exit(1);
}

const body = JSON.parse(bodyText);
const firstUrl = body?.data?.[0]?.url;
const firstB64Len = body?.data?.[0]?.b64_json?.length;
console.log("image data entries:", body?.data?.length, "first url:", firstUrl, "first b64 len:", firstB64Len);
console.log("usage:", body?.usage);

const savedImages = await saveImages(body, outputDir);
if (savedImages.length > 0) {
  console.log("saved images:", savedImages);
} else {
  console.log("no image payloads saved");
}

// Pull the local signed receipt for billing detail
if (paidReceiptId) {
  const localReceipt = await fetch(`${serverUrl}/receipts/${paidReceiptId}`);
  if (localReceipt.ok) {
    const json = await localReceipt.json();
    console.log("local receipt pricing:", receiptField(json, "pricing"));
    console.log("local receipt session:", receiptField(json, "session"));
  } else {
    console.log("local receipt fetch failed:", localReceipt.status);
  }
}

if (!receiptHeader || !sessionChallenge) {
  console.log("(no mppx payment-receipt header; channel not closed)");
  process.exit(0);
}

// Close the mppx channel to settle the deposit on chain.
const receipt = JSON.parse(Buffer.from(receiptHeader, "base64url").toString("utf8"));
const sessionMethod = mppx.methods.find((method) => method.name === "tempo" && method.intent === "session");
if (!sessionMethod) {
  throw new Error("tempo/session method not found");
}

const closeCredential = await sessionMethod.createCredential({
  challenge: sessionChallenge,
  context: {
    action: "close",
    channelId: receipt.channelId,
    cumulativeAmountRaw: receipt.spent,
  },
});

const closeResponse = await mppx.rawFetch(url, {
  method: "POST",
  headers: {
    authorization: closeCredential,
  },
});

console.log("close status", closeResponse.status);
console.log("close payment-receipt", closeResponse.headers.get("payment-receipt"));
if (!closeResponse.ok) {
  console.log(await closeResponse.text());
}

async function saveImages(body, outputDir) {
  const entries = Array.isArray(body?.data) ? body.data : [];
  if (entries.length === 0) return [];

  mkdirSync(outputDir, { recursive: true });
  const saved = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const [index, entry] of entries.entries()) {
    const extension = imageExtension(entry);
    const outputPath = join(outputDir, `${timestamp}-${model}-${index + 1}.${extension}`);

    if (typeof entry?.b64_json === "string" && entry.b64_json.length > 0) {
      writeFileSync(outputPath, Buffer.from(entry.b64_json, "base64"));
      saved.push(outputPath);
      continue;
    }

    if (typeof entry?.url === "string" && entry.url.length > 0) {
      const imageResponse = await fetch(entry.url);
      if (!imageResponse.ok) {
        console.log("image download failed:", imageResponse.status, entry.url);
        continue;
      }
      writeFileSync(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
      saved.push(outputPath);
    }
  }

  return saved;
}

function imageExtension(entry) {
  const mimeType = typeof entry?.mime_type === "string" ? entry.mime_type : "";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
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

function readStringConfig(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string in ${configPath.pathname}`);
  }

  return value;
}

function readPositiveIntegerConfig(name, value) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer in ${configPath.pathname}`);
  }

  return parsed;
}

/**
 * @returns {`0x${string}`}
 */
function readPrivateKeyEnv(name, value) {
  if (!value) {
    throw new Error(`${name} is required`);
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte private key`);
  }

  return value;
}

function receiptField(value, field) {
  if (!value || typeof value !== "object" || !("receipt" in value)) {
    return undefined;
  }

  const receipt = value.receipt;
  if (!receipt || typeof receipt !== "object" || !(field in receipt)) {
    return undefined;
  }

  return receipt[field];
}
