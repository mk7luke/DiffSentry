import type { IncomingMessage, ServerResponse } from "node:http";

export const OWNER_HEADER = "x-owner-id";

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export function ownerId(req: IncomingMessage): string | undefined {
  const header = req.headers[OWNER_HEADER];
  return Array.isArray(header) ? header[0] : header;
}
