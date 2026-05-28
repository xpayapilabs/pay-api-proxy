import type { FastifyInstance } from "fastify";
import { createChatCompletionsEndpoint } from "./chat-completions.js";
import { handleBilledRequest, type HandlerDeps } from "./handler.js";
import { createImagesEndpoint } from "./images.js";
import type { PaidEndpoint } from "./types.js";

export type { PaidEndpoint } from "./types.js";
export { handleBilledRequest } from "./handler.js";
export { createChatCompletionsEndpoint } from "./chat-completions.js";
export { createImagesEndpoint } from "./images.js";

/**
 * Default registry of paid endpoints. Add a new endpoint by appending to the
 * array — the generic handler does the rest. The mppx-backend getter is
 * threaded in so chat-completions can do its empty-body preflight.
 */
export function defaultPaidEndpoints(deps: HandlerDeps): PaidEndpoint[] {
  return [
    createChatCompletionsEndpoint(() => deps.sessions.mppx),
    createImagesEndpoint(() => deps.sessions.mppx) as PaidEndpoint
  ];
}

export function registerPaidEndpoints(app: FastifyInstance, deps: HandlerDeps, endpoints?: PaidEndpoint[]): void {
  const list = endpoints ?? defaultPaidEndpoints(deps);
  for (const endpoint of list) {
    app.route({
      method: endpoint.method,
      url: endpoint.path,
      handler: (request, reply) => handleBilledRequest(endpoint, deps, request, reply)
    });
  }
}
