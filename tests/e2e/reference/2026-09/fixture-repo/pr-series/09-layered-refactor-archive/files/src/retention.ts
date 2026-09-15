/** True when a row created at `createdAt` is still inside the retention window as of `now`. */
export function isWithinRetention(createdAt: number, now: number, retentionMs: number): boolean {
  return now - createdAt < retentionMs;
}
