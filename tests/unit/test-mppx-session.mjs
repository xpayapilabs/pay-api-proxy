import { Mppx, session } from "mppx/client";
import { createClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoTestnet } from "viem/chains";

if (!process.env.CLIENT_PRIVATE_KEY) {
  throw new Error("CLIENT_PRIVATE_KEY is required");
}

const account = privateKeyToAccount(process.env.CLIENT_PRIVATE_KEY);

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
      maxDeposit: "1000000",
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
});

const url = "http://127.0.0.1:8080/v1/chat/completions";
const response = await mppx.fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-paid-request-id": `req_mppx_${Date.now()}`
  },
  body: JSON.stringify({
    model: "gpt-5.4-nano",
    messages: [{ role: "user", content: "what is moon" }],
    max_tokens: 128000
  })
});

const receiptHeader = response.headers.get("payment-receipt");
console.log("status", response.status);
console.log("payment-receipt", receiptHeader);
console.log(await response.text());

if (!response.ok || !receiptHeader || !sessionChallenge) {
  process.exit(0);
}

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
