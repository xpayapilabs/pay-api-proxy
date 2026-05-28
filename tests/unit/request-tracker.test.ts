import Fastify from "fastify";
import { createRequestTracker } from "../../src/api/request-tracker.js";

describe("request tracker", () => {
  it("rejects new non-health requests while draining", async () => {
    const tracker = createRequestTracker();
    const app = Fastify({ logger: false });
    tracker.attach(app);
    app.get("/health", async (_request, reply) => {
      if (tracker.isDraining()) reply.status(503);
      return { ok: !tracker.isDraining(), shutdown: tracker.snapshot() };
    });
    app.get("/paid", async () => ({ ok: true }));

    tracker.startDrain("test");

    const rejected = await app.inject({ method: "GET", url: "/paid" });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().error.code).toBe("server_draining");

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(503);
    expect(health.json().shutdown.draining).toBe(true);

    await app.close();
  });

  it("tracks phases until a request finishes", async () => {
    const tracker = createRequestTracker();
    const app = Fastify({ logger: false });
    tracker.attach(app);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.get("/paid", async (request) => {
      tracker.setPhase(request, "calling_upstream");
      await gate;
      return { ok: true };
    });

    const pending = app.inject({ method: "GET", url: "/paid" });
    await waitForActivePhase(tracker, "calling_upstream");

    expect(tracker.snapshot()).toEqual({
      draining: false,
      active: 1,
      phases: { calling_upstream: 1 }
    });

    release();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(tracker.snapshot().active).toBe(0);

    await app.close();
  });
});

async function waitForActivePhase(tracker: ReturnType<typeof createRequestTracker>, phase: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (tracker.snapshot().phases[phase]) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for phase ${phase}`);
}
