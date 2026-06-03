// TanStack Query hooks — one per API endpoint, all read-only.

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";
import type {
  FindingsResponse,
  HealthResponse,
  MeResponse,
  PatternsResponse,
  PRDetailResponse,
  RepoDetailResponse,
  ReposResponse,
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

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => apiGet<HealthResponse>("/health"),
  });
}
