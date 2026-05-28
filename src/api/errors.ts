import type { FastifyReply } from "fastify";

export function sendOpenAiError(reply: FastifyReply, statusCode: number, code: string, message: string): void {
  reply.status(statusCode).send({
    error: {
      message,
      type: statusCode === 402 ? "payment_required" : "invalid_request_error",
      code
    }
  });
}
