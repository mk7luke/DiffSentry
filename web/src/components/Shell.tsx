import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/useAuth";
import { usePWA } from "../pwa/usePWA";
import { purgePersistedCache } from "../lib/persist";
import { useInstanceBranding } from "../theme/useBranding";
import { SidebarThemeToggle } from "./appearance";
import type { Capabilities } from "../api/types";
import {
  AlertIcon,
  AuditIcon,
  CloseIcon,
  CostIcon,
  FindingsIcon,
  ImpactIcon,
  KeyIcon,
  LeaderboardIcon,
  LearningsIcon,
  LogoIcon,
  MenuIcon,
  OfflineIcon,
  OverviewIcon,
  PatternsIcon,
  QueueIcon,
  RecurringIcon,
  RulesIcon,
  SearchIcon,
  SettingsIcon,
  TrendsIcon,
  WebhooksIcon,
} from "./icons";
import { CommandPalette, openCommandPalette } from "./CommandPalette";
import { SetupWizard } from "./SetupWizard";

// Page shell: a left sidebar (brand + primary nav + signed-in user) and the
// main content column. On phones the sidebar collapses into an off-canvas
// drawer opened from a sticky top bar. Mirrors renderLayout() from
// src/dashboard/layout.ts.

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
  { to: "/impact", label: "Impact", Icon: ImpactIcon, end: false },
  { to: "/queue", label: "Queue", Icon: QueueIcon, end: false },
  { to: "/findings", label: "Findings", Icon: FindingsIcon, end: true },
  { to: "/findings/recurring", label: "Recurring", Icon: RecurringIcon, end: false },
  { to: "/patterns", label: "Patterns", Icon: PatternsIcon, end: false },
  { to: "/cost", label: "Cost", Icon: CostIcon, end: false },
  { to: "/rules", label: "Custom rules", Icon: RulesIcon, end: false, cap: "manageConfig" },
  { to: "/leaderboard", label: "Leaderboard", Icon: LeaderboardIcon, end: false },
  { to: "/trends", label: "Trends", Icon: TrendsIcon, end: false },
  { to: "/learnings", label: "Learnings", Icon: LearningsIcon, end: false },
  { to: "/audit", label: "Audit log", Icon: AuditIcon, end: false, cap: "viewAudit" },
  { to: "/webhooks", label: "Webhooks", Icon: WebhooksIcon, end: false, cap: "viewAudit" },
  { to: "/tokens", label: "API tokens", Icon: KeyIcon, end: false, cap: "manageTokens" },
  { to: "/notifications", label: "Notifications", Icon: AlertIcon, end: false, cap: "manageNotifications" },
  { to: "/settings", label: "Settings", Icon: SettingsIcon, end: false },
];

/** Small "offline" pill, shown in the sidebar foot and the mobile top bar. */
function OfflinePill() {
  const { offline } = usePWA();
  if (!offline) return null;
  return (
    <span className="offline-pill" title="You're offline — showing last-viewed data.">
      <OfflineIcon />
      Offline
    </span>
  );
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { login, role, capabilities, authEnabled } = useAuth();
  const queryClient = useQueryClient();
  const { instanceName } = useInstanceBranding();
  const showUser = !!login && (authEnabled || login !== "local");
  const initial = login ? login.slice(0, 1).toUpperCase() : "?";
  const items = NAV.filter((n) => !n.cap || capabilities[n.cap]);

  // Sign-out clears the user-scoped offline cache before the full-page redirect
  // so the next visitor on this device can't read this user's cached data.
  const signOut = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const href = e.currentTarget.href;
    void purgePersistedCache(queryClient).finally(() => {
      window.location.href = href;
    });
  };

  return (
    <aside id="app-sidebar" className="sidebar" aria-label="Sidebar">
      <NavLink to="/" className="sidebar-head" onClick={onNavigate}>
        <LogoIcon />
        <div>
          <div className="wordmark">{instanceName}</div>
          <div className="wordmark-sub">REVIEW OPS</div>
        </div>
      </NavLink>
      <button type="button" className="cmdk-trigger" onClick={openCommandPalette}>
        <SearchIcon />
        <span>Search…</span>
        <kbd className="cmdk-kbd">⌘K</kbd>
      </button>
      <nav className="sidebar-nav" aria-label="Primary">
        {items.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) => `snav${isActive ? " active" : ""}`}
          >
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">
        {showUser ? (
          <>
            <span className="avatar">{initial}</span>
            <span className="login" title={`@${login}`}>
              @{login}
              {role ? <span className={`rolechip role-${role}`}>{role}</span> : null}
            </span>
          </>
        ) : (
          <span className="login muted">Appearance</span>
        )}
        <OfflinePill />
        <SidebarThemeToggle />
        {showUser && authEnabled ? (
          <a className="signout" href="/dashboard/auth/logout" onClick={signOut}>
            Sign out
          </a>
        ) : null}
      </div>
    </aside>
  );
}

/** Visible, focusable elements inside `el`, in DOM order — for the drawer trap. */
function getFocusable(el: HTMLElement | null): HTMLElement[] {
  if (!el) return [];
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(el.querySelectorAll<HTMLElement>(sel)).filter((n) => n.offsetParent !== null);
}

export function Shell() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const { instanceName } = useInstanceBranding();
  const topbarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  // True while the drawer was opened from the menu button, so we know to return
  // focus there when it closes.
  const restoreFocusRef = useRef(false);

  // Close the drawer on any route change so a tapped nav link doesn't leave it
  // hanging open over the new page.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // While the drawer is open it behaves as a modal, so inert the background
  // (top bar + main) — keeping tab focus and screen readers inside the drawer
  // and off the content behind the backdrop. Toggle the attribute directly so
  // we don't depend on HTMLElement.inert being present in the TS lib typings.
  useEffect(() => {
    for (const el of [topbarRef.current, mainRef.current]) {
      if (!el) continue;
      if (navOpen) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
  }, [navOpen]);

  // While open: lock body scroll, close on Escape, and trap Tab within the
  // drawer so focus can't reach the (inert) background behind the backdrop.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNavOpen(false);
        return;
      }
      if (e.key === "Tab") {
        const f = getFocusable(drawerRef.current);
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("nav-locked");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("nav-locked");
    };
  }, [navOpen]);

  // Move focus into the drawer as it opens. A layout effect, so it runs before
  // the (passive) inert effect marks the top bar inert — focus goes straight
  // from the menu button into the drawer with no detour through <body>.
  useLayoutEffect(() => {
    if (!navOpen) return;
    const drawer = drawerRef.current;
    (drawer?.querySelector<HTMLElement>(".drawer-close") ?? getFocusable(drawer)[0])?.focus();
  }, [navOpen]);

  // Restore focus to the menu button after the drawer closes (when it opened
  // it). A passive effect declared after the inert effect, so the top bar's
  // inert is already cleared and the button can receive focus.
  useEffect(() => {
    if (!navOpen && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [navOpen]);

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <header ref={topbarRef} className="topbar">
        <button
          ref={menuButtonRef}
          className="topbar-menu"
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
          onClick={() => {
            restoreFocusRef.current = true;
            setNavOpen((open) => !open);
          }}
        >
          <MenuIcon />
        </button>
        <NavLink to="/" className="topbar-brand">
          <LogoIcon />
          <span>{instanceName}</span>
        </NavLink>
        <OfflinePill />
      </header>

      <div
        ref={drawerRef}
        className="sidebar-wrap"
        role={navOpen ? "dialog" : undefined}
        aria-modal={navOpen || undefined}
        aria-label={navOpen ? "Navigation menu" : undefined}
      >
        <Sidebar onNavigate={() => setNavOpen(false)} />
        {/* Close button lives inside the drawer on mobile (hidden on desktop). */}
        <button className="drawer-close" aria-label="Close navigation" onClick={() => setNavOpen(false)}>
          <CloseIcon />
        </button>
      </div>

      <div
        className="nav-backdrop"
        hidden={!navOpen}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      <main ref={mainRef} className="main">
        <SetupWizard />
        <Outlet />
      </main>
      <CommandPalette />
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
