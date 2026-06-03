// TanStack Query hooks — one per API endpoint, all read-only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "./client";
import type {
  AuditResponse,
  FindingsResponse,
  HealthResponse,
  MeResponse,
  PatternsResponse,
  PRDetailResponse,
  RecurringResponse,
  RepoDetailResponse,
  ReposResponse,
  Role,
  TriageResult,
  TriageState,
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
        triage: query.triage,
        age: query.age,
        limit: query.limit,
        offset: query.offset,
      }),
    placeholderData: (prev) => prev,
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
        triage: query.triage,
        age: query.age,
        limit: query.limit,
      }),
    placeholderData: (prev) => prev,
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
