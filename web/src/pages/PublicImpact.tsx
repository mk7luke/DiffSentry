import { useState } from "react";
import { useParams } from "react-router-dom";
import { usePublicImpact } from "../api/hooks";
import { QueryBoundary } from "../components/states";
import { LogoIcon } from "../components/icons";
import { ImpactReportBody } from "./Impact";

/**
 * Public, chrome-less Impact share view. Rendered OUTSIDE the app Shell (no
 * sidebar / nav / search), reached via a tokenized link at /share/impact/:id.
 *
 * It reuses the exact same `ImpactReportBody` the authed page uses, so the
 * shared report stays in lockstep with the dashboard. The data comes from the
 * no-auth public endpoint, which serves ONLY aggregate impact metrics for the
 * share's fixed repo scope — never source code or per-finding detail. The
 * viewer can change the date range but cannot widen the scope.
 */
export function PublicImpactPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [range, setRange] = useState("30d");
  const query = usePublicImpact(id, range);

  return (
    <div className="public-share">
      <header className="public-share-bar">
        <a className="public-share-brand" href="https://github.com/diffsentry" rel="noreferrer">
          <LogoIcon />
          <span>DiffSentry</span>
        </a>
        <span className="public-share-tag">Shared Impact report</span>
      </header>

      <main className="public-share-main">
        <QueryBoundary query={query} loadingLabel="Loading shared report…">
          {(report) => (
            <ImpactReportBody
              report={report}
              range={range}
              onRange={setRange}
              extraActions={
                <button className="btn btn-ghost" onClick={() => window.print()}>
                  Print
                </button>
              }
            />
          )}
        </QueryBoundary>
      </main>

      <footer className="public-share-foot">
        Aggregate metrics only · powered by <strong>DiffSentry</strong>
      </footer>
    </div>
  );
}
