import { loadConfig } from "../core/config.js";
import { openDatabase } from "../db/database.js";
import { Repository } from "../db/repository.js";
import { createPaymentProvider } from "../payments/index.js";
import { createAiProvider } from "../providers/index.js";
import { buildApp } from "../api/app.js";
import { createRequestTracker } from "../api/request-tracker.js";

const config = loadConfig();
const database = openDatabase(config.databasePath);
const repository = new Repository(database.db);
const requestTracker = createRequestTracker();
const app = buildApp({
  config,
  repository,
  paymentProvider: createPaymentProvider(config),
  aiProvider: createAiProvider(config),
  requestTracker
});
let shuttingDown = false;
const shutdownTimeoutMs = parseShutdownTimeoutMs();

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info({
    host: config.host,
    port: config.port,
    gracefulShutdownTimeoutMs: shutdownTimeoutMs
  }, "pay-api-proxy server started");
} catch (error) {
  app.log.error(error);
  database.close();
  process.exit(1);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  requestTracker.startDrain(signal);
  app.log.info({
    signal,
    gracefulShutdownTimeoutMs: shutdownTimeoutMs,
    shutdown: requestTracker.snapshot()
  }, "graceful shutdown started");

  const closeTimer = setTimeout(() => {
    app.log.error({
      signal,
      shutdown: requestTracker.snapshot(),
      activeRequests: requestTracker.activeRequests()
    }, "graceful shutdown timed out");
    database.close();
    process.exit(1);
  }, shutdownTimeoutMs);
  closeTimer.unref();

  try {
    const closeApp = app.close();
    const drained = await requestTracker.waitForIdle(shutdownTimeoutMs, (snapshot) => {
      app.log.info({ signal, shutdown: snapshot }, "waiting for active requests before shutdown");
    });
    await closeApp;
    clearTimeout(closeTimer);
    database.close();
    app.log.info({ signal, drained }, "graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    clearTimeout(closeTimer);
    app.log.error(error, "graceful shutdown failed");
    database.close();
    process.exit(1);
  }
}

function parseShutdownTimeoutMs(): number {
  const raw = process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS ?? "60000";
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1_000) return 60_000;
  return Math.floor(value);
}
