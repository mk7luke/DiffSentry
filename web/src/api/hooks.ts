// TanStack Query hooks — one per API endpoint, all read-only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "./client";
import type {
  AuditResponse,
  CustomRuleInput,
  CustomRuleRow,
  CustomRulesResponse,
  FindingsResponse,
  HealthResponse,
  MeResponse,
  PatternsResponse,
  PRDetailResponse,
  RepoDetailResponse,
  ReposResponse,
  Role,
  RuleTestResult,
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

// ─── Custom rules (admin) ───────────────────────────────────────────

/** Admin: list custom anti-pattern rules with their hit-counts. */
export function useCustomRules(enabled: boolean) {
  return useQuery({
    queryKey: ["rules"],
    queryFn: () => apiGet<CustomRulesResponse>("/rules"),
    enabled,
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
