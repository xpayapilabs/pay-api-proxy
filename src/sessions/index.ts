import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../core/config.js";
import type { Repository } from "../db/repository.js";
import { type MppxSessionAdapter, createMppxSessionAdapter } from "../payments/mppx-session.js";
import { InternalSessionBackend } from "./internal.js";
import { MppxSessionBackend } from "./mppx.js";
import type { SessionBackend } from "./types.js";

export type { SessionBackend, SessionBackendName } from "./types.js";
export type {
  ReceiptInput,
  ReceiptOutput,
  ReserveInput,
  ReserveOutcome,
  SessionAuthorization,
  SettleInput,
  SettleOutcome
} from "./types.js";
export { MppxSessionBackend } from "./mppx.js";

/**
 * Bundles the active backends and the mppx adapter (so the app can wire its
 * lifecycle hooks). `mppxBackend` may be undefined when native mppx sessions
 * are disabled in config.
 */
export interface SessionBackends {
  internal: SessionBackend;
  mppx?: MppxSessionBackend;
  mppxAdapter?: MppxSessionAdapter;
  /** Pick the backend that should handle this request, or undefined when none matches. */
  select(request: FastifyRequest): SessionBackend | undefined;
}

export function createSessionBackends(config: AppConfig, repository: Repository): SessionBackends {
  const internal = new InternalSessionBackend(repository, config.nodeSigningSecret);
  const mppxAdapter = createMppxSessionAdapter(config);
  const mppx = mppxAdapter ? new MppxSessionBackend(mppxAdapter, repository) : undefined;

  return {
    internal,
    mppx,
    mppxAdapter,
    select(request) {
      const sessionId = firstHeaderValue(request.headers["x-mpp-session-id"]);
      if (sessionId) return internal;
      if (mppx) return mppx;
      return undefined;
    }
  };
}

function firstHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
