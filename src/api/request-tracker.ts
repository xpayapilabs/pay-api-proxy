import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface ActiveRequestInfo {
  id: string;
  method: string;
  url: string;
  phase: string;
  startedAt: number;
}

export interface RequestTrackerSnapshot {
  draining: boolean;
  active: number;
  phases: Record<string, number>;
}

export interface RequestTracker {
  attach(app: FastifyInstance): void;
  startDrain(reason: string): void;
  isDraining(): boolean;
  setPhase(request: FastifyRequest, phase: string): void;
  snapshot(): RequestTrackerSnapshot;
  activeRequests(): ActiveRequestInfo[];
  waitForIdle(timeoutMs: number, onTick?: (snapshot: RequestTrackerSnapshot) => void): Promise<boolean>;
}

export function createRequestTracker(): RequestTracker {
  let draining = false;
  const active = new Map<string, ActiveRequestInfo>();
  const requestIds = new WeakMap<FastifyRequest, string>();

  function snapshot(): RequestTrackerSnapshot {
    const phases: Record<string, number> = {};
    for (const info of active.values()) {
      phases[info.phase] = (phases[info.phase] ?? 0) + 1;
    }
    return {
      draining,
      active: active.size,
      phases
    };
  }

  function finish(request: FastifyRequest): void {
    const id = requestIds.get(request);
    if (!id) return;
    requestIds.delete(request);
    active.delete(id);
  }

  return {
    attach(app) {
      app.addHook("onRequest", async (request, reply) => {
        if (draining && !isDrainAllowed(request.url)) {
          sendRestartingResponse(reply);
          return;
        }

        const id = typeof request.id === "string" ? request.id : `${Date.now()}-${active.size + 1}`;
        requestIds.set(request, id);
        active.set(id, {
          id,
          method: request.method,
          url: request.url,
          phase: "received",
          startedAt: Date.now()
        });
      });

      app.addHook("onResponse", async (request) => {
        finish(request);
      });

      app.addHook("onError", async (request) => {
        finish(request);
      });
    },
    startDrain(_reason) {
      draining = true;
    },
    isDraining() {
      return draining;
    },
    setPhase(request, phase) {
      const id = requestIds.get(request);
      if (!id) return;
      const info = active.get(id);
      if (!info) return;
      info.phase = phase;
    },
    snapshot() {
      return snapshot();
    },
    activeRequests() {
      return [...active.values()].map((info) => ({ ...info }));
    },
    waitForIdle(timeoutMs, onTick) {
      if (active.size === 0) return Promise.resolve(true);
      const startedAt = Date.now();
      let lastTickAt = 0;
      return new Promise((resolve) => {
        const timer = setInterval(() => {
          if (active.size === 0) {
            clearInterval(timer);
            resolve(true);
            return;
          }

          const now = Date.now();
          if (onTick && now - lastTickAt >= 5_000) {
            lastTickAt = now;
            onTick(snapshot());
          }

          if (now - startedAt >= timeoutMs) {
            clearInterval(timer);
            resolve(false);
          }
        }, 250);
      });
    }
  };
}

function isDrainAllowed(url: string): boolean {
  const path = url.split("?")[0];
  return path === "/health";
}

function sendRestartingResponse(reply: FastifyReply): void {
  reply.header("retry-after", "15");
  reply.status(503).send({
    error: {
      message: "Server is restarting; retry shortly.",
      type: "service_unavailable",
      code: "server_draining"
    }
  });
}
