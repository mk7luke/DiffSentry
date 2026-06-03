import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useMe } from "../api/hooks";
import { FindingsIcon, LogoIcon, OverviewIcon, PatternsIcon, SettingsIcon } from "./icons";

// Page shell: sticky left sidebar (brand + primary nav + signed-in user) and
// the main content column. Mirrors renderLayout() from src/dashboard/layout.ts.

const NAV = [
  { to: "/", label: "Overview", Icon: OverviewIcon, end: true },
  { to: "/findings", label: "Findings", Icon: FindingsIcon, end: false },
  { to: "/patterns", label: "Patterns", Icon: PatternsIcon, end: false },
  { to: "/settings", label: "Settings", Icon: SettingsIcon, end: false },
];

function Sidebar() {
  const me = useMe();
  const login = me.data?.user.login;
  const authEnabled = me.data?.authEnabled ?? false;
  const showUser = !!login && (authEnabled || login !== "local");
  const initial = login ? login.slice(0, 1).toUpperCase() : "?";

  return (
    <aside className="sidebar">
      <NavLink to="/" className="sidebar-head">
        <LogoIcon />
        <div>
          <div className="wordmark">DiffSentry</div>
          <div className="wordmark-sub">REVIEW OPS</div>
        </div>
      </NavLink>
      <nav className="sidebar-nav" aria-label="Primary">
        {NAV.map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `snav${isActive ? " active" : ""}`}>
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      {showUser ? (
        <div className="sidebar-foot">
          <span className="avatar">{initial}</span>
          <span className="login" title={`@${login}`}>
            @{login}
          </span>
          {authEnabled ? (
            <a className="signout" href="/dashboard/auth/logout">
              Sign out
            </a>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

export function Shell() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

export interface Crumb {
  label: string;
  to?: string;
}

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (crumbs.length === 0) return null;
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {crumbs.map((c, i) => {
        const node: ReactNode = c.to ? (
          <NavLink to={c.to}>{c.label}</NavLink>
        ) : (
          <span className="current">{c.label}</span>
        );
        return (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {i > 0 ? <span className="sep">/</span> : null}
            {node}
          </span>
        );
      })}
    </nav>
  );
}
