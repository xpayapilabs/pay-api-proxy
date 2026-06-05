import { Store } from "mppx/server";
import { Json } from "ox";
import type { MppxStoreHandle } from "../../ports/mppx-store.js";

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface DurableObjectStubLike {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export function createDurableObjectMppxStore(
  namespace: DurableObjectNamespaceLike,
  name = "mppx-store"
): MppxStoreHandle {
  const stub = namespace.get(namespace.idFromName(name));
  const store = Store.from({
    async get(key) {
      const response = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`mppx Durable Object get failed: ${response.status}`);
      return Json.parse(await response.text()) as never;
    },
    async put(key, value) {
      const response = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: Json.stringify(value)
      });
      if (!response.ok) throw new Error(`mppx Durable Object put failed: ${response.status}`);
    },
    async delete(key) {
      const response = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}`, {
        method: "DELETE"
      });
      if (!response.ok) throw new Error(`mppx Durable Object delete failed: ${response.status}`);
    },
    async update<result>(
      key: string,
      fn: (current: unknown | null) => Store.Change<unknown, result>
    ): Promise<result> {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const snapshot = await readSnapshot(stub, key);
        const current = snapshot.value === null ? null : Json.parse(snapshot.value);
        const change = fn(current as never);
        const commit = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: snapshot.version,
            op: change.op,
            value: change.op === "set" ? Json.stringify(change.value) : undefined
          })
        });
        if (commit.status === 409) continue;
        if (!commit.ok) throw new Error(`mppx Durable Object update commit failed: ${commit.status}`);
        return change.result;
      }
      throw new Error(`mppx Durable Object update conflict for key ${key}`);
    }
  });

  return {
    store,
    close: () => {}
  };
}

async function readSnapshot(
  stub: DurableObjectStubLike,
  key: string
): Promise<{ value: string | null; version: number }> {
  const response = await stub.fetch(`https://mppx-store.local/store/${encodeURIComponent(key)}/snapshot`);
  if (!response.ok) throw new Error(`mppx Durable Object snapshot failed: ${response.status}`);
  return response.json() as Promise<{ value: string | null; version: number }>;
}

type DurableObjectStateLike = {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
};

export class MppxStoreDurableObject {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/store\/([^/]+)(?:\/(snapshot|commit))?$/.exec(url.pathname);
    if (!match) return new Response("Not Found", { status: 404 });

    const key = decodeURIComponent(match[1]!);
    const action = match[2];

    if (request.method === "GET" && !action) {
      const value = await this.state.storage.get<string>(key);
      return value === undefined ? new Response(null, { status: 404 }) : new Response(value);
    }

    if (request.method === "PUT" && !action) {
      await this.state.storage.put(key, await request.text());
      await this.incrementVersion(key);
      return new Response(null, { status: 204 });
    }

    if (request.method === "DELETE" && !action) {
      await this.state.storage.delete(key);
      await this.incrementVersion(key);
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && action === "snapshot") {
      const [value, version] = await Promise.all([
        this.state.storage.get<string>(key),
        this.version(key)
      ]);
      return Response.json({ value: value ?? null, version });
    }

    if (request.method === "POST" && action === "commit") {
      const change = await request.json() as { expectedVersion?: unknown; op?: unknown; value?: unknown };
      const version = await this.version(key);
      if (change.expectedVersion !== version) {
        return new Response("Version conflict", { status: 409 });
      }
      if (change.op === "set") {
        if (typeof change.value !== "string") {
          return new Response("Invalid set value", { status: 400 });
        }
        await this.state.storage.put(key, change.value);
      } else if (change.op === "delete") {
        await this.state.storage.delete(key);
      } else if (change.op !== "noop") {
        return new Response("Invalid operation", { status: 400 });
      }
      if (change.op !== "noop") await this.setVersion(key, version + 1);
      return new Response(null, { status: 204 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  private async version(key: string): Promise<number> {
    const value = await this.state.storage.get<number>(this.versionKey(key));
    return typeof value === "number" ? value : 0;
  }

  private async setVersion(key: string, version: number): Promise<void> {
    await this.state.storage.put(this.versionKey(key), version);
  }

  private async incrementVersion(key: string): Promise<void> {
    await this.setVersion(key, (await this.version(key)) + 1);
  }

  private versionKey(key: string): string {
    return `__version:${key}`;
  }
}
