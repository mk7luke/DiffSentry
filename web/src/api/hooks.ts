// TanStack Query hooks — one per API endpoint, all read-only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "./client";
import type {
  AuditResponse,
  FindingsResponse,
  HealthResponse,
  ImpactReport,
  Learning,
  LearningScope,
  LearningsResponse,
  LearningTestResponse,
  MeResponse,
  PatternsResponse,
  PRDetailResponse,
  QueueResponse,
  RepoDetailResponse,
  ReplayResponse,
  ReposResponse,
  Role,
  SearchResponse,
  WebhookDeliveryDetail,
  WebhooksResponse,
} from "./types";

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

export interface FindingsQuery {
  severity?: string;
  source?: string;
  repo?: string;
  q?: string;
  fingerprint?: string;
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
        age: query.age,
        limit: query.limit,
        offset: query.offset,
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

export function usePatterns() {
  return useQuery({
    queryKey: ["patterns"],
    queryFn: () => apiGet<PatternsResponse>("/patterns"),
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
