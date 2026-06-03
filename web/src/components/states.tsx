import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { AlertIcon } from "./icons";

// Shared loading / error / empty states so every screen handles the three
// non-happy paths consistently.

export function EmptyState({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <div className="empty">
      <div className="title">{title}</div>
      {hint ? <div>{hint}</div> : null}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="center-pad">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const isApi = error instanceof ApiError;
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const code = isApi ? error.code : undefined;
  return (
    <section className="card tone-danger">
      <div className="card-body">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span style={{ color: "var(--sev-crit)", flexShrink: 0 }}>
            <AlertIcon style={{ width: 18, height: 18 }} />
          </span>
          <div>
            <div style={{ color: "var(--sev-crit)", fontWeight: 600, fontSize: 13 }}>{message}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
              {code ? `Error code: ${code}.` : "Check server logs for details."}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function NotFoundState({ message }: { message: string }) {
  return (
    <section className="card">
      <div className="empty">
        <div className="mono" style={{ color: "var(--text-3)", fontSize: 11, letterSpacing: "0.12em", marginBottom: 8 }}>
          404 · NOT FOUND
        </div>
        <div className="title">{message}</div>
      </div>
    </section>
  );
}

/** Render-prop wrapper that handles loading / error before exposing data. */
export function QueryBoundary<T>({
  query,
  loadingLabel,
  children,
}: {
  query: UseQueryResult<T>;
  loadingLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <LoadingState label={loadingLabel} />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return <NotFoundState message={query.error.message} />;
    }
    return <ErrorState error={query.error} />;
  }
  return <>{children(query.data)}</>;
}
