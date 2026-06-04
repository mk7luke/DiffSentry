import { createBrowserRouter } from "react-router-dom";
import { Shell } from "./components/Shell";
import { OverviewPage } from "./pages/Overview";
import { ImpactPage } from "./pages/Impact";
import { QueuePage } from "./pages/Queue";
import { RepoDetailPage } from "./pages/RepoDetail";
import { PRDetailPage } from "./pages/PRDetail";
import { FindingsPage } from "./pages/Findings";
import { PatternsPage } from "./pages/Patterns";
import { RulesPage } from "./pages/Rules";
import { LeaderboardPage } from "./pages/Leaderboard";
import { TrendsPage } from "./pages/Trends";
import { LearningsPage } from "./pages/Learnings";
import { SettingsPage } from "./pages/Settings";
import { AuditPage } from "./pages/Audit";
import { WebhooksPage } from "./pages/Webhooks";
import { NotFoundState } from "./components/states";

function NotFoundPage() {
  return (
    <div style={{ marginTop: 14 }}>
      <NotFoundState message="That page doesn't exist." />
      <div style={{ marginTop: 14 }}>
        <a href="/" className="btn btn-ghost">
          ← Back to overview
        </a>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <OverviewPage /> },
      { path: "/impact", element: <ImpactPage /> },
      { path: "/queue", element: <QueuePage /> },
      { path: "/repos/:owner/:repo", element: <RepoDetailPage /> },
      { path: "/repos/:owner/:repo/pr/:number", element: <PRDetailPage /> },
      { path: "/findings", element: <FindingsPage /> },
      { path: "/patterns", element: <PatternsPage /> },
      { path: "/rules", element: <RulesPage /> },
      { path: "/leaderboard", element: <LeaderboardPage /> },
      { path: "/trends", element: <TrendsPage /> },
      { path: "/learnings", element: <LearningsPage /> },
      { path: "/audit", element: <AuditPage /> },
      { path: "/webhooks", element: <WebhooksPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
