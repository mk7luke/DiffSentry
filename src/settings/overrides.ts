import { getSettingOverride } from "../storage/dao.js";
import { logger, setLogLevel } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Operator settings overrides — the resolution layer over `settings_overrides`.
//
// The DAO (src/storage/dao.ts) provides the raw scope/key/value store; this
// module gives it meaning: a typed registry of the keys the command center
// exposes, their validators, their defaults, and the resolution rules the
// review pipeline reads.
//
// Two scopes:
//   - 'global'       process-wide defaults + the Pause-All kill switch.
//   - 'owner/repo'   per-repo overrides that win over the global default.
//
// Every read degrades gracefully: getSettingOverride() returns `undefined` when
// persistence is disabled OR the key is unset, so the documented file/env
// default is used. Nothing here ever throws on a missing DB.
// ─────────────────────────────────────────────────────────────────────────────

export const GLOBAL_SCOPE = "global";

export type Profile = "chill" | "assertive";
export const PROFILES: readonly Profile[] = ["chill", "assertive"] as const;

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Resolved global settings, with defaults filled in. */
export interface GlobalSettings {
  /** Kill switch — when true the webhook/reviewer queue no new reviews. */
  pauseAll: boolean;
  /** Default for automatic (webhook) reviews; per-repo can override. */
  autoReview: boolean;
  /** Default review profile when a repo doesn't pin one. */
  defaultProfile: Profile;
  /** Active process log level (reflects the running logger). */
  logLevel: LogLevel;
  /** Max files per review, or null to use the MAX_FILES_PER_REVIEW env default. */
  maxFiles: number | null;
}

/** Per-repo overrides. `null` on a field means "inherit the global value". */
export interface RepoSettings {
  autoReview: boolean | null;
  profile: Profile | null;
  maxFiles: number | null;
}

export function repoScope(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

// ── Validators ───────────────────────────────────────────────────────────────

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

function vBool(v: unknown): Validated<boolean> {
  return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, message: "must be a boolean" };
}
function vProfile(v: unknown): Validated<Profile> {
  return v === "chill" || v === "assertive"
    ? { ok: true, value: v }
    : { ok: false, message: "must be 'chill' or 'assertive'" };
}
function vLogLevel(v: unknown): Validated<LogLevel> {
  return typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v)
    ? { ok: true, value: v as LogLevel }
    : { ok: false, message: `must be one of ${LOG_LEVELS.join(", ")}` };
}
function vMaxFiles(v: unknown): Validated<number> {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 500
    ? { ok: true, value: v }
    : { ok: false, message: "must be an integer between 1 and 500" };
}

/** A configurable key: how to validate it, whether it can be cleared, and any
 *  runtime side effect to run when its value changes (e.g. the log level). */
export interface SettingDef {
  key: string;
  validate: (v: unknown) => Validated<unknown>;
  /** When true, a `null` value clears the override (reverting to the default). */
  nullable: boolean;
  /** Side effect applied when the value is set/cleared at runtime. */
  apply?: (value: unknown) => void;
}

/** Global settings the admin UI can change. Order drives the audit/response. */
export const GLOBAL_SETTING_DEFS: readonly SettingDef[] = [
  { key: "pauseAll", validate: vBool, nullable: false },
  { key: "autoReview", validate: vBool, nullable: false },
  { key: "defaultProfile", validate: vProfile, nullable: false },
  { key: "logLevel", validate: vLogLevel, nullable: false, apply: (v) => setLogLevel(String(v)) },
  { key: "maxFiles", validate: vMaxFiles, nullable: true },
];

/** Per-repo settings the admin UI can change. All clearable (inherit global). */
export const REPO_SETTING_DEFS: readonly SettingDef[] = [
  { key: "autoReview", validate: vBool, nullable: true },
  { key: "profile", validate: vProfile, nullable: true },
  { key: "maxFiles", validate: vMaxFiles, nullable: true },
];

// ── Typed reads with defaults ─────────────────────────────────────────────────

function readBool(scope: string, key: string, dflt: boolean): boolean {
  const v = getSettingOverride<boolean>(scope, key);
  return typeof v === "boolean" ? v : dflt;
}
function readProfile(scope: string, key: string, dflt: Profile): Profile {
  const v = getSettingOverride<Profile>(scope, key);
  return v === "chill" || v === "assertive" ? v : dflt;
}
function readNum(scope: string, key: string): number | null {
  const v = getSettingOverride<number>(scope, key);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The running logger's level, falling back to a known level. */
function activeLogLevel(): LogLevel {
  const lvl = logger.level;
  return (LOG_LEVELS as readonly string[]).includes(lvl) ? (lvl as LogLevel) : "info";
}

/**
 * Canonical default global settings — the values resolved when no override is
 * stored. The single source of truth: getGlobalSettings (and the effective
 * helpers) read these, and tests assert against them. `logLevel` is excluded on
 * purpose — its default is the running process level (see activeLogLevel), not
 * a fixed constant.
 */
export const GLOBAL_SETTING_DEFAULTS: {
  pauseAll: boolean;
  autoReview: boolean;
  defaultProfile: Profile;
  maxFiles: number | null;
} = {
  pauseAll: false,
  autoReview: true,
  defaultProfile: "chill",
  maxFiles: null,
};

/** Resolve the global settings, with file/env/process defaults filled in. */
export function getGlobalSettings(): GlobalSettings {
  return {
    pauseAll: readBool(GLOBAL_SCOPE, "pauseAll", GLOBAL_SETTING_DEFAULTS.pauseAll),
    autoReview: readBool(GLOBAL_SCOPE, "autoReview", GLOBAL_SETTING_DEFAULTS.autoReview),
    defaultProfile: readProfile(GLOBAL_SCOPE, "defaultProfile", GLOBAL_SETTING_DEFAULTS.defaultProfile),
    logLevel: ((): LogLevel => {
      const v = getSettingOverride<string>(GLOBAL_SCOPE, "logLevel");
      return typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v)
        ? (v as LogLevel)
        : activeLogLevel();
    })(),
    maxFiles: readNum(GLOBAL_SCOPE, "maxFiles") ?? GLOBAL_SETTING_DEFAULTS.maxFiles,
  };
}

/** Resolve the raw per-repo overrides (each field null when not pinned). */
export function getRepoSettings(owner: string, repo: string): RepoSettings {
  const scope = repoScope(owner, repo);
  const autoReview = getSettingOverride<boolean>(scope, "autoReview");
  const profile = getSettingOverride<Profile>(scope, "profile");
  return {
    autoReview: typeof autoReview === "boolean" ? autoReview : null,
    profile: profile === "chill" || profile === "assertive" ? profile : null,
    maxFiles: readNum(scope, "maxFiles"),
  };
}

// ── Effective resolution (read by the review pipeline) ─────────────────────────

/** The global Pause-All kill switch. Honored before queuing any review. */
export function isPauseAll(): boolean {
  return readBool(GLOBAL_SCOPE, "pauseAll", GLOBAL_SETTING_DEFAULTS.pauseAll);
}

/**
 * Whether automatic (webhook) reviews are enabled for a repo. A per-repo
 * override wins; otherwise the global `autoReview` default (true) applies.
 */
export function isAutoReviewEnabled(owner: string, repo: string): boolean {
  const r = getSettingOverride<boolean>(repoScope(owner, repo), "autoReview");
  if (typeof r === "boolean") return r;
  return readBool(GLOBAL_SCOPE, "autoReview", GLOBAL_SETTING_DEFAULTS.autoReview);
}

/**
 * The review profile an operator has pinned (repo override > global default),
 * or null when no override is set (caller falls back to .diffsentry.yaml).
 */
export function resolveProfileOverride(owner: string, repo: string): Profile | null {
  const r = getSettingOverride<Profile>(repoScope(owner, repo), "profile");
  if (r === "chill" || r === "assertive") return r;
  const g = getSettingOverride<Profile>(GLOBAL_SCOPE, "defaultProfile");
  if (g === "chill" || g === "assertive") return g;
  return null;
}

/**
 * The max-files cap an operator has pinned (repo override > global), or null
 * when unset (caller falls back to config.maxFilesPerReview).
 */
export function resolveMaxFilesOverride(owner: string, repo: string): number | null {
  const r = readNum(repoScope(owner, repo), "maxFiles");
  if (r != null) return r;
  return readNum(GLOBAL_SCOPE, "maxFiles");
}

/**
 * Apply any persisted runtime side effects on startup — currently just the log
 * level. Called once from createServer so a level set via the dashboard
 * survives restarts. No-ops gracefully when persistence is disabled.
 */
export function applyPersistedSettings(): void {
  const v = getSettingOverride<string>(GLOBAL_SCOPE, "logLevel");
  if (typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v)) {
    setLogLevel(v);
    logger.info({ logLevel: v }, "Applied persisted log level override");
  }
}
