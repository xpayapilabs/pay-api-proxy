import { loadWorkerConfig } from "../core/config.js";
import { openDatabase } from "../db/database.js";
import { Repository } from "../db/repository.js";
import { directoryPublishSkipReason, registerDirectoryNode } from "./directory-publisher.js";

const POLL_INTERVAL_MS = 30_000;
const PENDING_PAYMENT_EXPIRY_MS = 60 * 60 * 1000;

const config = loadWorkerConfig();
const database = openDatabase(config.databasePath);
const repository = new Repository(database.db);

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

log("pay-api-proxy worker started");

if (config.directoryPublish.enabled) {
  void syncDirectoryListing();
}

const interval = setInterval(() => {
  try {
    const cutoff = new Date(Date.now() - PENDING_PAYMENT_EXPIRY_MS).toISOString();
    const expired = repository.expirePendingPayments(cutoff);
    if (expired > 0) {
      log(`expired ${expired} pending payment(s) created before ${cutoff}`);
    }
    const pending = repository.countPaymentsByStatus("pending");
    if (pending > 0) {
      log(`pending payments awaiting settlement: ${pending}`);
    }
  } catch (error) {
    log(`worker tick failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}, POLL_INTERVAL_MS);

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown(): void {
  log("pay-api-proxy worker stopping");
  clearInterval(interval);
  database.close();
  process.exit(0);
}

async function syncDirectoryListing(): Promise<void> {
  const skipReason = directoryPublishSkipReason(config.directoryPublish.publicBaseUrl);
  if (skipReason) {
    log(`directory registration skipped: ${skipReason}`);
    return;
  }
  try {
    const result = await registerDirectoryNode(config.directoryPublish);
    log(`directory registration ${result.approvalStatus ?? "submitted"} for ${result.apiIds.length} API listing(s)`);
  } catch (error) {
    log(`directory registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
