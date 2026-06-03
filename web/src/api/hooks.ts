// TanStack Query hooks — one per API endpoint, all read-only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "./client";
import type {
  AuditResponse,
  FindingsResponse,
  HealthResponse,
  ImpactReport,
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
