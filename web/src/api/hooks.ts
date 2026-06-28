// TanStack Query hooks — one per API endpoint, all read-only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "./client";
import type {
  ActivityResponse,
  ApiScope,
  AuditResponse,
  BrandingResponse,
  BrandingUpdate,
  CostResponse,
  CreatedImpactShare,
  CreatedToken,
  AuthorDetailResponse,
  AuthorsResponse,
  ConfigUpdateResult,
  CustomRuleInput,
  CustomRuleRow,
  CustomRulesResponse,
  DiagnosticsResponse,
  FindingsResponse,
  GlobalSettingsPatch,
  GithubDiagnosticsResponse,
  HealthResponse,
  ImpactReport,
  Learning,
  LearningScope,
  LearningsResponse,
  LearningTestResponse,
  MeResponse,
  NotificationsResponse,
  PatternsResponse,
  PRDetailResponse,
  PRDiffResponse,
  RecurringResponse,
  QueueResponse,
  RepoConfigResponse,
  RepoDetailResponse,
  RepoSettingsPatch,
  RepoSettingsResponse,
  ReplayResponse,
  ReposResponse,
  Role,
  TriageResult,
  TriageState,
  RuleTestResult,
  SearchResponse,
  SettingsResponse,
  TestAiResult,
  TestWebhookResult,
  TokensResponse,
  TrendsResponse,
  WebhookDeliveryDetail,
  WebhooksResponse,
} from "./types";

export const BRANDING_QUERY_KEY = ["branding"] as const;

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => apiGet<MeResponse>("/me"),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function useRepos() {
  return useQuery({
    queryKey: ["repos"],
    queryFn: () => apiGet<ReposResponse>("/repos"),
  });
}

export function useRepoDetail(owner: string, repo: string) {
  return useQuery({
    queryKey: ["repo", owner, repo],
    queryFn: () => apiGet<RepoDetailResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`),
    enabled: !!owner && !!repo,
  });
}

export function usePRDetail(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: ["pr", owner, repo, number],
    queryFn: () =>
      apiGet<PRDetailResponse>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/prs/${number}`,
      ),
    enabled: !!owner && !!repo && Number.isFinite(number),
  });
}

/**
 * The PR's unified diff + anchored findings for the inline diff viewer. The key
 * is nested under ["pr", …] so the triage invalidator and the PR-detail SSE
 * handler (both of which invalidate ["pr", owner, repo, number]) refresh it too.
 */
export function usePRDiff(owner: string, repo: string, number: number, enabled = true) {
  return useQuery({
    queryKey: ["pr", owner, repo, number, "diff"],
    queryFn: () =>
      apiGet<PRDiffResponse>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/prs/${number}/diff`,
      ),
    enabled: enabled && !!owner && !!repo && Number.isFinite(number),
  });
}

export interface FindingsQuery {
  severity?: string;
  source?: string;
  repo?: string;
  q?: string;
  fingerprint?: string;
  author?: string;
  triage?: string;
  age?: string;
  limit?: number;
  offset?: number;
}

export function useFindings(query: FindingsQuery) {
  return useQuery({
    queryKey: ["findings", query],
    queryFn: () =>
      apiGet<FindingsResponse>("/findings", {
        severity: query.severity,
        source: query.source,
        repo: query.repo,
        q: query.q,
        fingerprint: query.fingerprint,
        author: query.author,
        triage: query.triage,
        age: query.age,
        limit: query.limit,
        offset: query.offset,
      }),
    placeholderData: (prev) => prev,
  });
}

export interface ActivityQuery {
  repo?: string;
  kind?: string;
  severity?: string;
  before?: string;
  limit?: number;
}

/** Low-level fetch — used for "load older" paging where we hold the cursor. */
export function fetchActivity(query: ActivityQuery): Promise<ActivityResponse> {
  return apiGet<ActivityResponse>("/activity", {
    repo: query.repo,
    kind: query.kind,
    severity: query.severity,
    before: query.before,
    limit: query.limit,
  });
}

/**
 * The Ops Console backfill: the most-recent page for the active filter scope
 * (repo / kind / severity), so older matches aren't hidden behind an unfiltered
 * page. The component then live-tails the SSE bus on top of this seed.
 */
export function useActivity(query: ActivityQuery) {
  const limit = query.limit ?? 120;
  return useQuery({
    queryKey: ["activity", query.repo ?? "", query.kind ?? "", query.severity ?? "", limit],
    queryFn: () =>
      fetchActivity({ repo: query.repo, kind: query.kind, severity: query.severity, limit }),
    // The bus is the realtime source of truth; don't poll the backfill.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useRecurring(query: FindingsQuery) {
  return useQuery({
    queryKey: ["recurring", query],
    queryFn: () =>
      apiGet<RecurringResponse>("/findings/recurring", {
        severity: query.severity,
        source: query.source,
        repo: query.repo,
        q: query.q,
        fingerprint: query.fingerprint,
        triage: query.triage,
        age: query.age,
        limit: query.limit,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useImpact(range: string, repo?: string) {
  return useQuery({
    queryKey: ["impact", range, repo ?? null],
    queryFn: () => apiGet<ImpactReport>("/impact", { range, repo }),
    placeholderData: (prev) => prev,
  });
}

/**
 * The public, no-auth Impact report behind a share token. Hits the public read
 * endpoint (no login, scoped to the share's fixed repo); the viewer can re-window
 * the date range. `retry: false` so a revoked/invalid link surfaces its 404
 * immediately instead of retrying.
 */
export function usePublicImpact(token: string, range: string) {
  return useQuery({
    queryKey: ["public-impact", token, range],
    queryFn: () => apiGet<ImpactReport>(`/public/impact/${encodeURIComponent(token)}`, { range }),
    enabled: !!token,
    placeholderData: (prev) => prev,
    retry: false,
  });
}

/** Admin: mint a public, revocable share link for the Impact report. Resolves
 *  with the one-time plaintext token + absolute URL. */
export function useCreateImpactShare() {
  return useMutation({
    mutationFn: (vars: { repo?: string | null; range?: string; label?: string }) =>
      apiSend<CreatedImpactShare>("/impact/shares", { body: vars }),
  });
}

export interface TriageVars {
  state: TriageState;
  /** ISO-8601 deadline — required when state is "snoozed". */
  until?: string;
  note?: string;
}

/**
 * Refetch every view a triage write can touch: the explorer, the recurring
 * view, any open PR detail, and the audit log. Called from each triage success.
 */
function invalidateTriageViews(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["findings"] });
  void qc.invalidateQueries({ queryKey: ["recurring"] });
  void qc.invalidateQueries({ queryKey: ["pr"] });
  void qc.invalidateQueries({ queryKey: ["audit"] });
}

/** Triage a single finding by id. */
export function useTriageFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number } & TriageVars) =>
      apiSend<TriageResult>(`/findings/${vars.id}/triage`, {
        body: { state: vars.state, until: vars.until, note: vars.note },
      }),
    onSuccess: () => invalidateTriageViews(qc),
  });
}

/** Bulk-triage findings by explicit id list, or a whole fingerprint class. */
export function useBulkTriage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: ({ ids: number[] } | { fingerprint: string }) & TriageVars) =>
      apiSend<TriageResult>("/findings/triage", { body: vars }),
    onSuccess: () => invalidateTriageViews(qc),
  });
}

export function usePatterns() {
  return useQuery({
    queryKey: ["patterns"],
    queryFn: () => apiGet<PatternsResponse>("/patterns"),
  });
}

export function useAuthorAnalytics(days: number) {
  return useQuery({
    queryKey: ["analytics", "authors", days],
    queryFn: () => apiGet<AuthorsResponse>("/analytics/authors", { days }),
    placeholderData: (prev) => prev,
  });
}

export function useAuthorDetail(author: string | null, days: number) {
  return useQuery({
    queryKey: ["analytics", "author", author, days],
    queryFn: () =>
      apiGet<AuthorDetailResponse>(`/analytics/authors/${encodeURIComponent(author ?? "")}`, { days }),
    enabled: !!author,
  });
}

export function useTrends(days: number) {
  return useQuery({
    queryKey: ["analytics", "trends", days],
    queryFn: () => apiGet<TrendsResponse>("/analytics/trends", { days }),
    placeholderData: (prev) => prev,
  });
}

/** The review-pipeline board snapshot. Live transitions arrive over SSE
 * (`queue.updated`); this just hydrates the initial board on load. */
export function useQueue() {
  return useQuery({
    queryKey: ["queue"],
    queryFn: () => apiGet<QueueResponse>("/queue"),
    staleTime: 5_000,
  });
}

/** Cmd-K palette search. Disabled for blank queries; keeps the prior page of
 * results visible while the next one loads so the list doesn't flicker. */
export function useSearch(q: string, enabled = true) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ["search", trimmed],
    queryFn: () => apiGet<SearchResponse>("/search", { q: trimmed }),
    enabled: enabled && trimmed.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => apiGet<HealthResponse>("/health"),
  });
}

export interface AuditQuery {
  action?: string;
  actor?: string;
  limit?: number;
  offset?: number;
}

export function useAudit(query: AuditQuery, enabled: boolean) {
  return useQuery({
    queryKey: ["audit", query],
    queryFn: () =>
      apiGet<AuditResponse>("/audit", {
        action: query.action,
        actor: query.actor,
        limit: query.limit,
        offset: query.offset,
      }),
    enabled,
    placeholderData: (prev) => prev,
  });
}

// ─── Notifications ──────────────────────────────────────────────────

const NOTIF_KEY = ["notifications"];

export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: NOTIF_KEY,
    queryFn: () => apiGet<NotificationsResponse>("/notifications"),
    enabled,
    // Deliveries trickle in from background events; refresh periodically while open.
    refetchInterval: 20_000,
  });
}

/** Generic notification mutation: invalidates the notifications query on success. */
function useNotifMutation<TVars>(fn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NOTIF_KEY });
    },
  });
}

/** Instance branding (name + accent). Readable by any authenticated role; the
 * SPA applies it as the theme accent + sidebar wordmark + document title. */
export function useBranding() {
  return useQuery({
    queryKey: BRANDING_QUERY_KEY,
    queryFn: () => apiGet<BrandingResponse>("/settings/branding"),
    staleTime: 5 * 60 * 1000,
  });
}

/** Admin: update instance branding. Returns the resolved branding. */
export function useSetBranding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: BrandingUpdate) => apiSend<BrandingResponse>("/settings/branding", { body: vars }),
    onSuccess: (data) => {
      qc.setQueryData(BRANDING_QUERY_KEY, data);
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

/** AI spend rollups for the Cost page. `range` is e.g. "7d" | "30d" | "90d" | "mtd". */
export function useCost(range: string) {
  return useQuery({
    queryKey: ["cost", range],
    queryFn: () => apiGet<CostResponse>("/cost", { range }),
    placeholderData: (prev) => prev,
  });
}

/** Admin: set (or clear, with `monthlyUsd: null`) a monthly budget for a scope. */
export function useSetBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { scope: string; monthlyUsd: number | null }) =>
      apiSend<{ scope: string; monthlyUsd: number | null }>("/cost/budget", { body: vars }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["cost"] });
    },
  });
}

export interface ChannelInput {
  type: string;
  name?: string | null;
  config: Record<string, unknown>;
  enabled?: boolean;
}

export function useCreateChannel() {
  return useNotifMutation((vars: ChannelInput) => apiSend("/notifications/channels", { body: vars }));
}

export function useUpdateChannel() {
  return useNotifMutation((vars: { id: number; patch: Partial<ChannelInput> }) =>
    apiSend(`/notifications/channels/${vars.id}`, { method: "PUT", body: vars.patch }),
  );
}

export function useDeleteChannel() {
  return useNotifMutation((id: number) => apiSend(`/notifications/channels/${id}`, { method: "DELETE" }));
}

export function useTestChannel() {
  const qc = useQueryClient();
  // A test send records a delivery row, so refresh the notifications view (Recent
  // deliveries) on success. The mutation result (ok/detail) is still returned to
  // the caller for display.
  return useMutation({
    mutationFn: (id: number) => apiSend<{ id: number; ok: boolean; detail: string }>(`/notifications/channels/${id}/test`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NOTIF_KEY });
    },
  });
}

export interface RuleInput {
  name?: string | null;
  scope?: string;
  condition: { event: string; minSeverity?: string };
  channelId?: number | null;
  enabled?: boolean;
}

export function useCreateAlertRule() {
  return useNotifMutation((vars: RuleInput) => apiSend("/notifications/rules", { body: vars }));
}

export function useUpdateAlertRule() {
  return useNotifMutation((vars: { id: number; patch: Partial<RuleInput> }) =>
    apiSend(`/notifications/rules/${vars.id}`, { method: "PUT", body: vars.patch }),
  );
}

export function useDeleteAlertRule() {
  return useNotifMutation((id: number) => apiSend(`/notifications/rules/${id}`, { method: "DELETE" }));
}

// ─── Settings (operator controls, admin) ────────────────────────────

/** Admin: resolved global settings. Only fetched when `enabled` (i.e. admin). */
export function useSettings(enabled: boolean) {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsResponse>("/settings"),
    enabled,
  });
}

/** Admin: list API tokens (metadata only). */
export function useTokens(enabled: boolean) {
  return useQuery({
    queryKey: ["tokens"],
    queryFn: () => apiGet<TokensResponse>("/tokens"),
    enabled,
  });
}

/** Admin: set/clear global settings. Returns the refreshed resolved settings. */
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: GlobalSettingsPatch) => apiSend<SettingsResponse>("/settings", { method: "PUT", body: patch }),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

/** Admin: resolved per-repo overrides. */
export function useRepoSettings(owner: string, repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repoSettings", owner, repo],
    queryFn: () =>
      apiGet<RepoSettingsResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings`),
    enabled: enabled && !!owner && !!repo,
  });
}

/** Admin: set/clear per-repo overrides. */
export function useUpdateRepoSettings(owner: string, repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: RepoSettingsPatch) =>
      apiSend<RepoSettingsResponse>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings`,
        { method: "PUT", body: patch },
      ),
    onSuccess: (data) => {
      qc.setQueryData(["repoSettings", owner, repo], data);
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

// ─── Custom rules (admin) ───────────────────────────────────────────

/** Admin: list custom anti-pattern rules with their hit-counts. */
export function useCustomRules(enabled: boolean) {
  return useQuery({
    queryKey: ["rules"],
    queryFn: () => apiGet<CustomRulesResponse>("/rules"),
    enabled,
  });
}

/** Admin: create an API token. Resolves with the one-time plaintext secret. */
export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; scopes: ApiScope[] }) =>
      apiSend<CreatedToken>("/tokens", { body: vars }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
}

/** Admin: create a custom rule. */
export function useCreateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: CustomRuleInput) => apiSend<{ rule: CustomRuleRow }>("/rules", { body: vars }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });
}

/** Admin: revoke an API token by id. */
export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend<{ id: number; revoked: boolean }>(`/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
}

// ─── Diagnostics / first-run experience ─────────────────────────────

export function useDiagnostics() {
  return useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => apiGet<DiagnosticsResponse>("/diagnostics"),
    staleTime: 30_000,
  });
}

/** Live GitHub App probe. Lazy: only runs once `enabled` is true (a network
 * call, so we don't fire it until the user opens the GitHub section). */
export function useGithubDiagnostics(enabled: boolean) {
  return useQuery({
    queryKey: ["diagnostics", "github"],
    queryFn: () => apiGet<GithubDiagnosticsResponse>("/diagnostics/github"),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Author+: fire a tiny completion at the configured provider. */
export function useTestAi() {
  return useMutation({
    mutationFn: () => apiSend<TestAiResult>("/diagnostics/test-ai"),
  });
}

/** Author+: round-trip a signed payload through the webhook verifier. */
export function useTestWebhook() {
  return useMutation({
    mutationFn: () => apiSend<TestWebhookResult>("/diagnostics/test-webhook"),
  });
}

// ─── Repo config (read viewer+, write admin) ───────────────────────

export function useRepoConfig(owner: string, repo: string) {
  return useQuery({
    queryKey: ["repo-config", owner, repo],
    queryFn: () =>
      apiGet<RepoConfigResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/config`),
    enabled: !!owner && !!repo,
  });
}

/** Admin: validate + commit (or open a PR for) a new .diffsentry.yaml. */
export function useUpdateRepoConfig(owner: string, repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { yaml: string; mode: "commit" | "pr"; message?: string }) =>
      apiSend<ConfigUpdateResult>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/config`, {
        method: "PUT",
        body: vars,
      }),
    onSuccess: (result) => {
      // A direct commit changes what the read path serves; a PR doesn't (yet).
      if (result.mode === "commit") {
        void qc.invalidateQueries({ queryKey: ["repo-config", owner, repo] });
        void qc.invalidateQueries({ queryKey: ["repo", owner, repo] });
      }
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

/** Admin: update an existing custom rule (partial fields). */
export function useUpdateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number } & Partial<CustomRuleInput>) => {
      const { id, ...body } = vars;
      return apiSend<{ rule: CustomRuleRow }>(`/rules/${id}`, { method: "PUT", body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });
}

/** Admin: delete a custom rule. */
export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend<{ id: number }>(`/rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });
}

export interface RuleTestVars {
  pattern: string;
  flags?: string;
  pathGlob?: string;
  filename?: string;
  snippet: string;
}

/** Admin: test a candidate rule against a pasted snippet (no persistence). */
export function useTestRule() {
  return useMutation({
    mutationFn: (vars: RuleTestVars) => apiSend<RuleTestResult>("/rules/test", { body: vars }),
  });
}

// ─── Webhook deliveries (admin) ─────────────────────────────────────

export interface WebhooksQuery {
  event?: string;
  repo?: string;
  limit?: number;
  offset?: number;
}

/** Admin: paged raw webhook deliveries + filter options. */
export function useWebhooks(query: WebhooksQuery, enabled: boolean) {
  return useQuery({
    queryKey: ["webhooks", query],
    queryFn: () =>
      apiGet<WebhooksResponse>("/webhooks", {
        event: query.event,
        repo: query.repo,
        limit: query.limit,
        offset: query.offset,
      }),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** Admin: one delivery with its full stored payload. Enabled lazily on expand. */
export function useWebhookDelivery(id: number | null) {
  return useQuery({
    queryKey: ["webhook", id],
    queryFn: () => apiGet<WebhookDeliveryDetail>(`/webhooks/${id}`),
    enabled: id != null,
    staleTime: 5 * 60 * 1000,
  });
}

/** Admin: re-dispatch a stored delivery through the engine. Refetches the list. */
export function useReplayWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend<ReplayResponse>(`/webhooks/${id}/replay`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

/** Admin: grant or clear a per-login role override. `role: null` clears it. */
export function useSetRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { login: string; role: Role | null }) =>
      apiSend<{ login: string; role: Role | null }>("/roles", { body: vars }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["audit"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

// ─── Learnings ──────────────────────────────────────────────────────

const enc = encodeURIComponent;
const repoLearningsPath = (owner: string, repo: string) => `/repos/${enc(owner)}/${enc(repo)}/learnings`;

export function useLearnings() {
  return useQuery({
    queryKey: ["learnings"],
    queryFn: () => apiGet<LearningsResponse>("/learnings"),
  });
}

/** Shared cache invalidation: any learning write refreshes the list (and the
 * repo detail page, whose learnings card reads the same files). */
function useInvalidateLearnings() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["learnings"] });
    void qc.invalidateQueries({ queryKey: ["repo"] });
  };
}

export interface LearningWrite {
  content?: string;
  path?: string | null;
}

export function useCreateLearning() {
  const invalidate = useInvalidateLearnings();
  return useMutation({
    mutationFn: (vars: { owner: string; repo: string } & LearningWrite) =>
      apiSend<Learning>(repoLearningsPath(vars.owner, vars.repo), {
        body: { content: vars.content, path: vars.path },
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateLearning() {
  const invalidate = useInvalidateLearnings();
  return useMutation({
    mutationFn: (vars: { owner: string; repo: string; id: string } & LearningWrite) =>
      apiSend<Learning>(`${repoLearningsPath(vars.owner, vars.repo)}/${enc(vars.id)}`, {
        method: "PUT",
        body: { content: vars.content, path: vars.path },
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteLearning() {
  const invalidate = useInvalidateLearnings();
  return useMutation({
    mutationFn: (vars: { owner: string; repo: string; id: string }) =>
      apiSend<{ id: string; deleted: boolean }>(`${repoLearningsPath(vars.owner, vars.repo)}/${enc(vars.id)}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  });
}

export function usePromoteLearning() {
  const invalidate = useInvalidateLearnings();
  return useMutation({
    mutationFn: (vars: { owner: string; repo: string; id: string }) =>
      apiSend<Learning>(`${repoLearningsPath(vars.owner, vars.repo)}/${enc(vars.id)}/promote`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useCreateGlobalLearning() {
  const invalidate = useInvalidateLearnings();
  return useMutation({
    mutationFn: (vars: LearningWrite) =>
      apiSend<Learning>("/learnings/global", { body: { content: vars.content, path: vars.path } }),
    onSuccess: invalidate,
  });
}

export function useUpdateGlobalLearning() {
  const invalidate = useInvalidateLearnings();
  return useMutation({
    mutationFn: (vars: { id: string } & LearningWrite) =>
      apiSend<Learning>(`/learnings/global/${enc(vars.id)}`, {
        method: "PUT",
        body: { content: vars.content, path: vars.path },
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteGlobalLearning() {
  const invalidate = useInvalidateLearnings();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      apiSend<{ id: string; deleted: boolean }>(`/learnings/global/${enc(vars.id)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export interface BulkDeleteRef {
  scope: LearningScope;
  owner?: string;
  repo?: string;
  id: string;
}

export function useBulkDeleteLearnings() {
  const invalidate = useInvalidateLearnings();
  return useMutation({
    mutationFn: (items: BulkDeleteRef[]) => apiSend<{ deleted: number }>("/learnings/bulk-delete", { body: { items } }),
    onSuccess: invalidate,
  });
}

/** Read-only: preview which learnings would apply to a given file path. */
export function useTestLearning() {
  return useMutation({
    mutationFn: (vars: { owner?: string; repo?: string; path: string }) =>
      apiSend<LearningTestResponse>("/learnings/test", { body: vars }),
  });
}
