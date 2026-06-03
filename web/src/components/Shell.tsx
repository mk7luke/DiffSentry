import type { ComponentType, ReactNode, SVGProps } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import type { Capabilities } from "../api/types";
import { AlertIcon, AuditIcon, FindingsIcon, LogoIcon, OverviewIcon, PatternsIcon, SettingsIcon } from "./icons";

// Page shell: sticky left sidebar (brand + primary nav + signed-in user) and
// the main content column. Mirrors renderLayout() from src/dashboard/layout.ts.

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  end: boolean;
  /** When set, the link is shown only if the capability is granted. */
  cap?: keyof Capabilities;
}

const NAV: NavItem[] = [
  { to: "/", label: "Overview", Icon: OverviewIcon, end: true },
  { to: "/findings", label: "Findings", Icon: FindingsIcon, end: false },
  { to: "/patterns", label: "Patterns", Icon: PatternsIcon, end: false },
  { to: "/audit", label: "Audit log", Icon: AuditIcon, end: false, cap: "viewAudit" },
  { to: "/notifications", label: "Notifications", Icon: AlertIcon, end: false, cap: "manageNotifications" },
  { to: "/settings", label: "Settings", Icon: SettingsIcon, end: false },
];

function Sidebar() {
  const { login, role, capabilities, authEnabled } = useAuth();
  const showUser = !!login && (authEnabled || login !== "local");
  const initial = login ? login.slice(0, 1).toUpperCase() : "?";
  const items = NAV.filter((n) => !n.cap || capabilities[n.cap]);

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
        {items.map(({ to, label, Icon, end }) => (
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
            {role ? <span className={`rolechip role-${role}`}>{role}</span> : null}
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
