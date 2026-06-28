import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { DEMO, DEMO_BASENAME } from "./demo/mode";
import { Shell } from "./components/Shell";
import { useAuth } from "./auth/useAuth";
import { OpsConsolePage } from "./pages/OpsConsole";
import { OverviewPage } from "./pages/Overview";
import { ImpactPage } from "./pages/Impact";
import { QueuePage } from "./pages/Queue";
import { RepoDetailPage } from "./pages/RepoDetail";
import { PRDetailPage } from "./pages/PRDetail";
import { FindingsPage } from "./pages/Findings";
import { TriageModePage } from "./pages/TriageMode";
import { RecurringPage } from "./pages/Recurring";
import { PatternsPage } from "./pages/Patterns";
import { CostPage } from "./pages/Cost";
import { RulesPage } from "./pages/Rules";
import { LeaderboardPage } from "./pages/Leaderboard";
import { TrendsPage } from "./pages/Trends";
import { LearningsPage } from "./pages/Learnings";
import { SettingsPage } from "./pages/Settings";
import { DiagnosticsPage } from "./pages/Diagnostics";
import { AuditPage } from "./pages/Audit";
import { NotificationsPage } from "./pages/Notifications";
import { ApiTokensPage } from "./pages/ApiTokens";
import { WebhooksPage } from "./pages/Webhooks";
import { LoadingState, NotFoundState } from "./components/states";

// Code editor (CodeMirror) only loads on the config screen, so split it out of
// the main bundle.
const RepoConfigPage = lazy(() => import("./pages/RepoConfig").then((m) => ({ default: m.RepoConfigPage })));

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

export const router = createBrowserRouter(
  [
  {
    element: <Shell />,
    children: [
      { path: "/", element: <RootLanding /> },
      { path: "/ops", element: <OpsConsolePage /> },
      { path: "/overview", element: <OverviewPage /> },
      { path: "/impact", element: <ImpactPage /> },
      { path: "/queue", element: <QueuePage /> },
      {
        path: "/repos/:owner/:repo/config",
        element: (
          <Suspense fallback={<LoadingState label="Loading config editor…" />}>
            <RepoConfigPage />
          </Suspense>
        ),
      },
      { path: "/repos/:owner/:repo", element: <RepoDetailPage /> },
      { path: "/repos/:owner/:repo/pr/:number", element: <PRDetailPage /> },
      { path: "/findings", element: <FindingsPage /> },
      { path: "/findings/triage", element: <TriageModePage /> },
      { path: "/findings/recurring", element: <RecurringPage /> },
      { path: "/patterns", element: <PatternsPage /> },
      { path: "/cost", element: <CostPage /> },
      { path: "/rules", element: <RulesPage /> },
      { path: "/leaderboard", element: <LeaderboardPage /> },
      { path: "/trends", element: <TrendsPage /> },
      { path: "/learnings", element: <LearningsPage /> },
      { path: "/audit", element: <AuditPage /> },
      { path: "/webhooks", element: <WebhooksPage /> },
      { path: "/tokens", element: <ApiTokensPage /> },
      { path: "/notifications", element: <NotificationsPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/settings/diagnostics", element: <DiagnosticsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
  ],
  // In demo mode the SPA is served under /demo; basename keeps every in-app
  // link and navigation scoped to that prefix.
  DEMO ? { basename: DEMO_BASENAME } : undefined,
);
