import {
  AIProvider,
  PRContext,
  ReviewResult,
  WalkthroughResult,
  RepoConfig,
  Learning,
  IssueContext,
} from "../types.js";
import { isTransientError } from "./transient.js";
import { logger } from "../logger.js";

export interface FailoverOptions {
  /** Consecutive failover-eligible primary failures before the breaker opens. */
  circuitThreshold: number;
  /** How long (ms) the breaker stays open, routing straight to the backup. */
  circuitCooldownMs: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequential try-primary-then-backup wrapper around two AIProviders.
//
//   - Fails over ONLY on transient errors (isTransientError): timeouts, 5xx,
//     429, network blips. A 4xx (auth / bad request) rethrows without touching
//     the backup or the breaker — a bad primary key must surface, not silently
//     route all traffic to the backup.
//   - The primary is constructed with a SHORT deadline and the backup with the
//     normal one (see reviewer.ts), so a slow-hang on the primary switches fast.
//   - A circuit breaker skips a persistently-down primary for a cooldown so we
//     don't pay the primary's stall on every single review during an outage.
//
// State is in-memory on the instance (the Reviewer is effectively a singleton),
// so it persists across reviews within a process and resets on restart — it is a
// cost/latency guard, not a correctness mechanism.
// ─────────────────────────────────────────────────────────────────────────────
export class FailoverProvider implements AIProvider {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    private readonly primary: AIProvider,
    private readonly backup: AIProvider,
    opts: FailoverOptions,
  ) {
    this.threshold = opts.circuitThreshold;
    this.cooldownMs = opts.circuitCooldownMs;
    this.now = opts.now ?? Date.now;
  }

  /** True while the breaker is open and the cooldown has not yet elapsed. Once
   *  the cooldown passes we return false so the next call probes the primary
   *  (half-open). */
  private breakerOpen(): boolean {
    if (this.openedAt === null) return false;
    return this.now() - this.openedAt < this.cooldownMs;
  }

  private recordPrimarySuccess(): void {
    if (this.openedAt !== null || this.consecutiveFailures > 0) {
      logger.info({ mode: "failover" }, "Primary AI provider recovered — closing circuit breaker");
    }
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private recordPrimaryFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      const wasOpen = this.openedAt !== null;
      this.openedAt = this.now();
      if (!wasOpen) {
        logger.warn(
          { mode: "failover", consecutiveFailures: this.consecutiveFailures },
          "Primary AI provider failing repeatedly — opening circuit breaker (routing to backup)",
        );
      }
    }
  }

  /**
   * Run one operation with failover. Returns the result plus which provider
   * served it. Never runs primary and backup concurrently.
   */
  private async run<T>(
    operation: string,
    primaryCall: () => Promise<T>,
    backupCall: () => Promise<T>,
  ): Promise<{ result: T; servedBy: "primary" | "backup" }> {
    if (this.breakerOpen()) {
      logger.warn({ mode: "failover", operation }, "Circuit breaker open — routing directly to backup AI provider");
      return { result: await backupCall(), servedBy: "backup" };
    }

    const startedAt = this.now();
    try {
      const result = await primaryCall();
      this.recordPrimarySuccess();
      return { result, servedBy: "primary" };
    } catch (err) {
      if (!isTransientError(err)) {
        // Deterministic failure (e.g. 401/403/400) — do NOT fail over and do
        // NOT trip the breaker; surface it so misconfiguration is visible.
        throw err;
      }
      this.recordPrimaryFailure();
      logger.warn(
        { mode: "failover", operation, primaryLatencyMs: this.now() - startedAt, err },
        "Primary AI provider failed transiently — failing over to backup",
      );
      return { result: await backupCall(), servedBy: "backup" };
    }
  }

  async review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult> {
    const { result, servedBy } = await this.run(
      "review",
      () => this.primary.review(context, repoConfig, learnings),
      () => this.backup.review(context, repoConfig, learnings),
    );
    return servedBy === "backup" ? { ...result, servedBy } : result;
  }

  async generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult> {
    const { result } = await this.run(
      "walkthrough",
      () => this.primary.generateWalkthrough(context, repoConfig),
      () => this.backup.generateWalkthrough(context, repoConfig),
    );
    return result;
  }

  async chat(context: PRContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { result } = await this.run(
      "chat",
      () => this.primary.chat(context, userMessage, repoConfig),
      () => this.backup.chat(context, userMessage, repoConfig),
    );
    return result;
  }

  async chatIssue(context: IssueContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { result } = await this.run(
      "issue_chat",
      () => this.primary.chatIssue(context, userMessage, repoConfig),
      () => this.backup.chatIssue(context, userMessage, repoConfig),
    );
    return result;
  }

  async complete(system: string, user: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string> {
    const { result } = await this.run(
      "complete",
      () => this.primary.complete(system, user, opts),
      () => this.backup.complete(system, user, opts),
    );
    return result;
  }
}
