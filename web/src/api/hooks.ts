// TanStack Query hooks — one per API endpoint, all read-only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "./client";
import type {
  AuditResponse,
  FindingsResponse,
  HealthResponse,
  Learning,
  LearningScope,
  LearningsResponse,
  LearningTestResponse,
  MeResponse,
  PatternsResponse,
  PRDetailResponse,
  RepoDetailResponse,
  ReposResponse,
  Role,
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
