import { createBrowserRouter, Navigate } from "react-router-dom";
import { Shell } from "./components/Shell";
import { useAuth } from "./auth/useAuth";
import { OpsConsolePage } from "./pages/OpsConsole";
import { OverviewPage } from "./pages/Overview";
import { RepoDetailPage } from "./pages/RepoDetail";
import { PRDetailPage } from "./pages/PRDetail";
import { FindingsPage } from "./pages/Findings";
import { PatternsPage } from "./pages/Patterns";
import { SettingsPage } from "./pages/Settings";
import { AuditPage } from "./pages/Audit";
import { LoadingState, NotFoundState } from "./components/states";

function NotFoundPage() {
  return (
    <div style={{ marginTop: 14 }}>
      <NotFoundState message="That page doesn't exist." />
      <div style={{ marginTop: 14 }}>
        <a href="/overview" className="btn btn-ghost">
          ← Back to overview
        </a>
      </div>
    </div>
  );
}

// The "/" landing tab is role-aware: admins drop straight into the live Ops
// Console; everyone else lands on the repo Overview. We wait for /me so the
// first paint doesn't flash the wrong tab and then bounce.
function RootLanding() {
  const { role, isLoading } = useAuth();
  if (isLoading) return <LoadingState label="Loading…" />;
  return <Navigate to={role === "admin" ? "/ops" : "/overview"} replace />;
}

export const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <RootLanding /> },
      { path: "/ops", element: <OpsConsolePage /> },
      { path: "/overview", element: <OverviewPage /> },
      { path: "/repos/:owner/:repo", element: <RepoDetailPage /> },
      { path: "/repos/:owner/:repo/pr/:number", element: <PRDetailPage /> },
      { path: "/findings", element: <FindingsPage /> },
      { path: "/patterns", element: <PatternsPage /> },
      { path: "/audit", element: <AuditPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
