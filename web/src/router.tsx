import { createBrowserRouter } from "react-router-dom";
import { Shell } from "./components/Shell";
import { OverviewPage } from "./pages/Overview";
import { RepoDetailPage } from "./pages/RepoDetail";
import { PRDetailPage } from "./pages/PRDetail";
import { FindingsPage } from "./pages/Findings";
import { PatternsPage } from "./pages/Patterns";
import { SettingsPage } from "./pages/Settings";
import { DiagnosticsPage } from "./pages/Diagnostics";
import { AuditPage } from "./pages/Audit";
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
      { path: "/repos/:owner/:repo", element: <RepoDetailPage /> },
      { path: "/repos/:owner/:repo/pr/:number", element: <PRDetailPage /> },
      { path: "/findings", element: <FindingsPage /> },
      { path: "/patterns", element: <PatternsPage /> },
      { path: "/audit", element: <AuditPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/settings/diagnostics", element: <DiagnosticsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
