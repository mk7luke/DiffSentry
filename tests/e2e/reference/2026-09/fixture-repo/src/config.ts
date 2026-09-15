export type Config = {
  port: number;
  logLevel: string;
  retentionMs: number;
};

const DEFAULT_PORT = 3000;
const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // seven days

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function parseRetentionMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_RETENTION_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_MS;
}

/** Reads server configuration from the environment, falling back to sane defaults. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: parsePort(env.PORT),
    logLevel: env.LOG_LEVEL?.trim() || DEFAULT_LOG_LEVEL,
    retentionMs: parseRetentionMs(env.RETENTION_MS),
  };
}
