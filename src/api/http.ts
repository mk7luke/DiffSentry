import type { Response } from "express";

/** Error codes shared by every /api/v1 JSON error envelope. */
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "internal"
  | "unavailable";

/** Success envelope: `{ data: ... }`. */
export function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

/** Error envelope: `{ error: { code, message, details? } }`. */
export function sendError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  extra?: unknown,
): void {
  res.status(status).json({ error: { code, message, ...(extra ? { details: extra } : {}) } });
}
