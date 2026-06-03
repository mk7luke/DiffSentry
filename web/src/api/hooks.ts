// TanStack Query hooks — one per API endpoint, all read-only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "./client";
import type {
  AuditResponse,
  FindingsResponse,
  HealthResponse,
  MeResponse,
  NotificationsResponse,
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
  // Test does not change config, so no invalidation needed; caller reads result.
  return useMutation({
    mutationFn: (id: number) => apiSend<{ id: number; ok: boolean; detail: string }>(`/notifications/channels/${id}/test`),
  });
}

export interface RuleInput {
  name?: string | null;
  scope?: string;
  condition: { event: string; minSeverity?: string };
  channelId?: number | null;
  enabled?: boolean;
}

export function useCreateRule() {
  return useNotifMutation((vars: RuleInput) => apiSend("/notifications/rules", { body: vars }));
}

export function useUpdateRule() {
  return useNotifMutation((vars: { id: number; patch: Partial<RuleInput> }) =>
    apiSend(`/notifications/rules/${vars.id}`, { method: "PUT", body: vars.patch }),
  );
}

export function useDeleteRule() {
  return useNotifMutation((id: number) => apiSend(`/notifications/rules/${id}`, { method: "DELETE" }));
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
