import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMe } from "../api/hooks";
import { reconcileCacheOwner } from "../lib/persist";
import type { Capabilities, Role } from "../api/types";

// Auth context — fetches /me exactly once (TanStack Query dedupes the
// ["me"] key) and exposes the resolved role + capabilities app-wide so screens
// gate controls without each re-requesting. The server still enforces every
// capability independently (requireRole / CSRF); this only drives the UI.

const VIEWER_CAPS: Capabilities = {
  viewDashboard: true,
  triageFindings: false,
  triggerReview: false,
  manageConfig: false,
  manageRoles: false,
  viewAudit: false,
};

export interface AuthState {
  login: string | null;
  role: Role | null;
  capabilities: Capabilities;
  authEnabled: boolean;
  isLoading: boolean;
  isError: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const user = me.data?.user;
  const queryClient = useQueryClient();
  const login = user?.login ?? null;

  // Bind the persisted offline cache to this user. If it was written under a
  // different login on this device, reconcileCacheOwner wipes it so we never
  // surface one user's cached data to another. See lib/persist.ts.
  useEffect(() => {
    if (login) reconcileCacheOwner(login, queryClient);
  }, [login, queryClient]);

  const value: AuthState = {
    login: user?.login ?? null,
    role: user?.role ?? null,
    // Until /me resolves, assume the least privilege so controls stay hidden
    // rather than flashing then disappearing.
    capabilities: user?.capabilities ?? VIEWER_CAPS,
    authEnabled: me.data?.authEnabled ?? false,
    isLoading: me.isPending,
    isError: me.isError,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
