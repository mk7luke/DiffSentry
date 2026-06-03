// TanStack Query hooks — one per API endpoint, all read-only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "./client";
import type {
  AuditResponse,
  AuthorDetailResponse,
  AuthorsResponse,
  FindingsResponse,
  HealthResponse,
  MeResponse,
  PatternsResponse,
  PRDetailResponse,
  RepoDetailResponse,
  ReposResponse,
  Role,
  TrendsResponse,
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
