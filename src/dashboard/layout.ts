import { AsyncLocalStorage } from "node:async_hooks";

// ─────────────────────────────────────────────────────────────────────────────
// Request context
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestContext {
  user: { login: string } | null;
  pathname: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getRequestContext(): RequestContext {
  return als.getStore() ?? { user: null, pathname: "" };
}

/** Tiny HTML escape for untrusted string interpolation. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface Crumb {
  label: string;
  href?: string;
}

export interface CurrentUser {
  login: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logo + icons
// ─────────────────────────────────────────────────────────────────────────────

const LOGO_SVG = `<svg viewBox="0 0 536.47 603.92" class="logo" aria-hidden="true">
  <path fill="currentColor" d="M268.5,603.92l-20.91-9.38c-52.32-23.47-92.73-49.8-135.59-87.15l-4.73-4.12c-11.43-9.96-21.23-20.67-30.91-32.29-27.54-33.04-48.51-70.17-60.28-111.6-6.77-23.85-10.93-47.15-13.25-71.67l-2.51-26.52-.24-13.23-.07-157.57c38.42-5.4,74.93-13.75,111.72-23.56l32.28-10.16c43.05-14.96,84.19-33.91,124.25-56.66,27.33,15.02,54.88,28.48,83.72,40.65,47.68,20.13,96.79,33.9,147.61,43.15l36.88,6.54-.1,85.75-.77,85.38c-.26,28.47-3.73,56.26-11.57,83.52l-5.79,20.14c-12.87,44.76-39.64,86.03-71.1,119.91-31.24,33.64-69.83,61.49-109.55,84.35-22.43,12.91-45,23.23-69.08,34.52ZM147.17,488.52c2.4,2.21,4.48,4.05,6.83,5.74l35.64,25.66c8.86,6.38,28.81,18.38,38.59,23.13l39.87,19.35c17.05-8.29,33.15-15.63,49.46-25.02,85.9-49.43,157.12-118.34,173.56-220.35,5.1-31.44,7.33-61.97,7.32-93.96l-.02-100.75c-83.18-14.52-156.14-39.09-230.34-78.19l-18.94,9.74c-68.9,33.69-134.48,55.7-211.11,68.48v100.67c0,15.97.48,30.85,1.59,46.54l2.29,23.71c2.42,25.08,11.06,61.19,20.89,84.67,4.83,11.54,10.78,22.67,17.11,33.59,6.35,10.94,29.09,41.03,37.68,49.18l19.54,18.55,10.04,9.26Z"/>
</svg>`;

export const ICON = {
  overview: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/></svg>`,
  findings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`,
  patterns: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 12h18M3 17h18"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/><circle cx="13" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="17" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  github: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.17c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.3 3.5 1 .11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.53.12-3.18 0 0 1-.32 3.3 1.23A11.5 11.5 0 0 1 12 5.8c1.02 0 2.05.14 3.01.4 2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>`,
  arrowRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  dot: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z"/></svg>`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Design system — colors, typography, spacing
// ─────────────────────────────────────────────────────────────────────────────

const DESIGN_TOKENS = `
  :root {
    /* Surface */
    --bg: #0a0c13;
    --bg-deep: #070910;
    --bg-elev: #11141d;
    --bg-elev-2: #171b26;
    --bg-hover: #1c212e;
    --bg-chart: #0d1018;

    /* Line */
    --line: #1d2230;
    --line-strong: #2a3043;
    --line-soft: #141824;

    /* Text */
    --text: #f1f3f8;
    --text-1: #d8dbe5;
    --text-2: #9aa0b2;
    --text-3: #6a7085;
    --text-4: #40465a;

    /* Brand */
    --accent: #5a8dff;
    --accent-bright: #7aa7ff;
    --accent-deep: #3d6ee8;
    --accent-glow: rgba(90, 141, 255, 0.32);
    --accent-soft: rgba(90, 141, 255, 0.10);
    --accent-line: rgba(90, 141, 255, 0.28);
    --accent-2: #9a6bff;

    /* Severity / semantic */
    --sev-crit: #fb6d82;
    --sev-crit-soft: rgba(251, 109, 130, 0.14);
    --sev-crit-line: rgba(251, 109, 130, 0.38);
    --sev-major: #fb923c;
    --sev-major-soft: rgba(251, 146, 60, 0.13);
    --sev-major-line: rgba(251, 146, 60, 0.38);
    --sev-minor: #fbbf24;
    --sev-minor-soft: rgba(251, 191, 36, 0.12);
    --sev-minor-line: rgba(251, 191, 36, 0.36);
    --sev-nit: #64748b;
    --sev-nit-soft: rgba(100, 116, 139, 0.15);
    --sev-nit-line: rgba(100, 116, 139, 0.38);

    --good: #4ade80;
    --good-soft: rgba(74, 222, 128, 0.13);
    --good-line: rgba(74, 222, 128, 0.38);
    --warn: #fbbf24;
    --warn-soft: rgba(251, 191, 36, 0.13);
    --warn-line: rgba(251, 191, 36, 0.38);
    --danger: #ef4444;
    --danger-soft: rgba(239, 68, 68, 0.13);
    --danger-line: rgba(239, 68, 68, 0.40);

    /* Typography */
    --font-sans: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    --font-display: 'Inter Tight', 'Inter', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

    /* Radius */
    --r-xs: 3px;
    --r-sm: 5px;
    --r-md: 7px;
    --r-lg: 10px;
    --r-xl: 14px;

    /* Shadow */
    --shadow-card: 0 1px 0 rgba(255, 255, 255, 0.025) inset, 0 1px 2px rgba(0, 0, 0, 0.25);
    --shadow-hover: 0 1px 0 rgba(255, 255, 255, 0.045) inset, 0 8px 24px -12px rgba(0, 0, 0, 0.5);
    --shadow-accent: 0 0 0 1px var(--accent-line), 0 10px 30px -10px var(--accent-glow);

    /* Layout */
    --sidebar-w: 228px;
    --page-max: 1440px;
    --page-gutter: 28px;

    color-scheme: dark;
  }
`;

const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  html { background: var(--bg); }
  body {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.45;
    font-feature-settings: "cv11", "ss01";
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    background:
      radial-gradient(ellipse 1400px 600px at 50% -10%, rgba(90, 141, 255, 0.06), transparent 60%),
      var(--bg);
    color: var(--text-1);
    min-height: 100vh;
  }
  h1, h2, h3, h4 { margin: 0; color: var(--text); font-family: var(--font-display); }
  p { margin: 0; }
  a { color: inherit; text-decoration: none; }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
  pre, code { font-family: var(--font-mono); }
  ::selection { background: var(--accent-glow); color: var(--text); }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 5px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-4); }

  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

  /* ── Layout shell ──────────────────────────────────────────────── */
  .app {
    display: grid;
    grid-template-columns: var(--sidebar-w) 1fr;
    min-height: 100vh;
  }
  .sidebar {
    position: sticky;
    top: 0;
    align-self: start;
    height: 100vh;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--line);
    background:
      linear-gradient(180deg, rgba(90, 141, 255, 0.025), transparent 240px),
      var(--bg-deep);
    padding: 18px 14px 16px;
    z-index: 40;
  }
  .sidebar-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2px 6px 18px;
    border-bottom: 1px solid var(--line-soft);
    margin-bottom: 14px;
  }
  .sidebar-head .logo {
    width: 20px; height: 20px;
    color: var(--accent-bright);
    filter: drop-shadow(0 0 8px var(--accent-glow));
  }
  .sidebar-head .wordmark {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
    color: var(--text);
    letter-spacing: -0.015em;
  }
  .sidebar-head .wordmark-sub {
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--text-3);
    margin-top: 1px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .sidebar-nav { display: flex; flex-direction: column; gap: 1px; }
  .snav {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: var(--r-sm);
    font-size: 13px;
    color: var(--text-2);
    transition: background 0.12s, color 0.12s;
    position: relative;
  }
  .snav svg { width: 15px; height: 15px; flex-shrink: 0; opacity: 0.85; }
  .snav:hover { background: var(--bg-elev); color: var(--text); }
  .snav.active {
    background: var(--accent-soft);
    color: var(--text);
  }
  .snav.active::before {
    content: "";
    position: absolute;
    left: -14px;
    top: 7px;
    bottom: 7px;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow);
  }
  .snav.active svg { color: var(--accent-bright); opacity: 1; }

  .sidebar-section { margin-top: 22px; }
  .sidebar-title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 0 10px 8px;
  }
  .sidebar-foot {
    margin-top: auto;
    padding-top: 14px;
    border-top: 1px solid var(--line-soft);
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
  }
  .sidebar-foot .avatar {
    width: 24px; height: 24px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-weight: 600;
    font-size: 11px;
  }
  .sidebar-foot .login { color: var(--text-1); font-family: var(--font-mono); font-size: 11.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .sidebar-foot .signout {
    color: var(--text-3); font-size: 11px;
    padding: 4px 6px; border-radius: var(--r-xs);
    transition: color 0.12s, background 0.12s;
  }
  .sidebar-foot .signout:hover { color: var(--text); background: var(--bg-elev); }

  /* Narrow screens: stack sidebar on top as a strip */
  @media (max-width: 820px) {
    .app { grid-template-columns: 1fr; }
    .sidebar {
      position: static;
      height: auto;
      flex-direction: row;
      align-items: center;
      padding: 10px 16px;
      gap: 10px;
      overflow-x: auto;
    }
    .sidebar-head { padding: 0 8px 0 0; border: 0; margin: 0; }
    .sidebar-head .wordmark-sub { display: none; }
    .sidebar-nav { flex-direction: row; flex: 1; gap: 2px; }
    .snav { padding: 6px 10px; }
    .snav.active::before { left: 4px; top: auto; bottom: 2px; right: 4px; width: auto; height: 2px; }
    .sidebar-section, .sidebar-foot { display: none; }
  }

  /* ── Main + page chrome ────────────────────────────────────────── */
  .main {
    min-width: 0;
    padding: 26px var(--page-gutter) 60px;
    max-width: var(--page-max);
    width: 100%;
  }
  .crumbs {
    display: flex; align-items: center; gap: 6px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-3);
    margin-bottom: 14px;
    letter-spacing: 0.01em;
  }
  .crumbs a { color: var(--text-2); transition: color 0.12s; }
  .crumbs a:hover { color: var(--text); }
  .crumbs .sep { color: var(--text-4); }
  .crumbs .current { color: var(--text-1); }

  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 22px;
    flex-wrap: wrap;
  }
  .page-head .title-block { min-width: 0; }
  .page-head h1 {
    font-size: 24px;
    font-weight: 620;
    letter-spacing: -0.022em;
    line-height: 1.1;
  }
  .page-head .subtitle {
    margin-top: 6px;
    color: var(--text-2);
    font-size: 13px;
    max-width: 70ch;
  }
  .page-head .actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

  /* ── Card ──────────────────────────────────────────────────────── */
  .card {
    background: linear-gradient(180deg, var(--bg-elev) 0%, var(--bg-elev) 50%, #10131c 100%);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .card.tone-accent { border-color: var(--accent-line); box-shadow: var(--shadow-accent); }
  .card.tone-danger { border-color: var(--danger-line); }
  .card.tone-good { border-color: var(--good-line); }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 14px;
    border-bottom: 1px solid var(--line-soft);
    background: linear-gradient(180deg, rgba(255,255,255,0.015), transparent);
  }
  .card-head h2, .card-head h3 {
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: -0.003em;
    color: var(--text);
  }
  .card-head .card-sub {
    font-size: 11.5px;
    color: var(--text-3);
    font-family: var(--font-mono);
    letter-spacing: 0.01em;
  }
  .card-body { padding: 14px; }
  .card-body.flush { padding: 0; }
  .card-body.tight { padding: 10px 14px; }
  .card-body.chart { padding: 16px 14px 8px; background: var(--bg-chart); }

  /* ── Metric (hero numbers) ─────────────────────────────────────── */
  .metric {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 16px;
    background: var(--bg-elev);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    position: relative;
    overflow: hidden;
  }
  .metric::before {
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent);
  }
  .metric.hero {
    padding: 18px 20px;
    background: linear-gradient(180deg, var(--bg-elev) 0%, var(--bg-elev-2) 100%);
  }
  .metric-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-3);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .metric-value {
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 620;
    letter-spacing: -0.03em;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .metric.hero .metric-value { font-size: 48px; letter-spacing: -0.04em; }
  .metric-value.danger { color: var(--sev-crit); }
  .metric-value.good { color: var(--good); }
  .metric-delta {
    font-size: 11px;
    color: var(--text-3);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .metric-delta.up { color: var(--sev-crit); }
  .metric-delta.down { color: var(--good); }
  .metric-foot { margin-top: 4px; }

  /* ── Chips / badges ────────────────────────────────────────────── */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.5;
    letter-spacing: 0.015em;
    border: 1px solid transparent;
    font-variant-numeric: tabular-nums;
  }
  .chip.neutral { background: var(--bg-elev-2); color: var(--text-1); border-color: var(--line-strong); }
  .chip.muted { background: transparent; color: var(--text-3); border-color: var(--line); }
  .chip.sev-crit { background: var(--sev-crit-soft); color: #ffbfc9; border-color: var(--sev-crit-line); }
  .chip.sev-major { background: var(--sev-major-soft); color: #ffcfa4; border-color: var(--sev-major-line); }
  .chip.sev-minor { background: var(--sev-minor-soft); color: #ffe1a0; border-color: var(--sev-minor-line); }
  .chip.sev-nit { background: var(--sev-nit-soft); color: #c3cbd9; border-color: var(--sev-nit-line); }
  .chip.good { background: var(--good-soft); color: #bff5d1; border-color: var(--good-line); }
  .chip.warn { background: var(--warn-soft); color: #ffe1a0; border-color: var(--warn-line); }
  .chip.danger { background: var(--danger-soft); color: #ffc7c7; border-color: var(--danger-line); }
  .chip.accent { background: var(--accent-soft); color: var(--accent-bright); border-color: var(--accent-line); }
  .chip .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .chip.uppercase { text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.08em; }

  /* ── Buttons ───────────────────────────────────────────────────── */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: var(--r-sm);
    font-size: 12px;
    font-weight: 500;
    transition: background 0.12s, border-color 0.12s, color 0.12s, transform 0.08s;
    border: 1px solid transparent;
    line-height: 1;
    white-space: nowrap;
  }
  .btn svg { width: 13px; height: 13px; }
  .btn:active { transform: translateY(1px); }
  .btn-primary {
    background: linear-gradient(180deg, var(--accent-bright) 0%, var(--accent) 100%);
    color: #0a0c13;
    font-weight: 600;
    box-shadow: 0 1px 0 rgba(255,255,255,0.2) inset, 0 4px 14px -4px var(--accent-glow);
  }
  .btn-primary:hover { filter: brightness(1.06); }
  .btn-ghost {
    background: var(--bg-elev);
    color: var(--text-1);
    border-color: var(--line-strong);
  }
  .btn-ghost:hover { background: var(--bg-hover); border-color: var(--text-4); color: var(--text); }
  .btn-link {
    color: var(--text-2);
    padding: 4px 8px;
  }
  .btn-link:hover { color: var(--text); }
  .btn.disabled, .btn[aria-disabled="true"] {
    opacity: 0.4; pointer-events: none;
  }

  /* ── Table ─────────────────────────────────────────────────────── */
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl thead th {
    text-align: left;
    padding: 9px 14px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
    background: var(--bg-elev-2);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    white-space: nowrap;
  }
  .tbl thead th.num, .tbl thead th.right { text-align: right; }
  .tbl tbody td {
    padding: 10px 14px;
    color: var(--text-1);
    border-bottom: 1px solid var(--line-soft);
    vertical-align: middle;
  }
  .tbl tbody tr { transition: background 0.1s; }
  .tbl tbody tr:hover { background: rgba(90, 141, 255, 0.04); }
  .tbl tbody tr:last-child td { border-bottom: 0; }
  .tbl td.num, .tbl td.right { text-align: right; font-variant-numeric: tabular-nums; }
  .tbl td.mono { font-family: var(--font-mono); font-size: 12px; }
  .tbl td.muted { color: var(--text-3); }
  .tbl td.zero { color: var(--text-4); }
  .tbl td.strong { color: var(--text); font-weight: 600; }
  .tbl td.crit { color: var(--sev-crit); font-weight: 600; }
  .tbl a.link { color: var(--accent-bright); }
  .tbl a.link:hover { color: var(--accent-bright); text-decoration: underline; text-underline-offset: 2px; }
  .tbl .line-num { color: var(--text-4); }

  /* Row-left severity rail — purely visual, colors by data-sev attr */
  .tbl.rail tbody tr td:first-child { position: relative; }
  .tbl.rail tbody tr td:first-child::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 2px;
    background: var(--text-4);
  }
  .tbl.rail tbody tr[data-sev="critical"] td:first-child::before { background: var(--sev-crit); box-shadow: 0 0 6px rgba(251,109,130,0.45); }
  .tbl.rail tbody tr[data-sev="major"] td:first-child::before { background: var(--sev-major); }
  .tbl.rail tbody tr[data-sev="minor"] td:first-child::before { background: var(--sev-minor); }
  .tbl.rail tbody tr[data-sev="nit"] td:first-child::before { background: var(--sev-nit); }
  .tbl.rail tbody td { border-bottom-color: rgba(30, 34, 48, 0.6); }

  /* ── Forms ─────────────────────────────────────────────────────── */
  input[type="text"], input[type="search"], input:not([type]), select, textarea {
    width: 100%;
    background: var(--bg-deep);
    border: 1px solid var(--line-strong);
    color: var(--text-1);
    padding: 7px 10px;
    border-radius: var(--r-sm);
    font-size: 12.5px;
    font-family: inherit;
    transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
  }
  input::placeholder { color: var(--text-4); }
  input:focus, select:focus, textarea:focus {
    border-color: var(--accent);
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-soft);
    background: var(--bg-elev);
  }
  label.field {
    display: flex; flex-direction: column; gap: 5px;
    font-size: 10.5px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-3);
  }

  /* ── Repo card (overview grid) ─────────────────────────────────── */
  .repo-card {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px 16px;
    padding: 14px 16px;
    background: linear-gradient(180deg, var(--bg-elev) 0%, #10131c 100%);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    transition: border-color 0.15s, background 0.15s, transform 0.15s;
    position: relative;
    overflow: hidden;
    color: inherit;
  }
  .repo-card::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: var(--text-4);
    opacity: 0.4;
    transition: opacity 0.15s, background 0.15s;
  }
  .repo-card.health-good::before { background: var(--good); opacity: 0.55; }
  .repo-card.health-warn::before { background: var(--sev-major); opacity: 0.7; }
  .repo-card.health-crit::before { background: var(--sev-crit); opacity: 0.9; box-shadow: 0 0 10px var(--sev-crit-line); }
  .repo-card.health-idle::before { background: var(--text-4); opacity: 0.25; }
  .repo-card:hover {
    border-color: var(--line-strong);
    background: linear-gradient(180deg, var(--bg-elev-2) 0%, var(--bg-elev) 100%);
  }
  .repo-card:hover::before { opacity: 1; }
  .repo-card .title {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    font-weight: 500;
    letter-spacing: -0.005em;
  }
  .repo-card .title .owner { color: var(--text-3); }
  .repo-card .meta {
    display: flex; gap: 14px; align-items: center;
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--text-3);
  }
  .repo-card .meta .stat {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-variant-numeric: tabular-nums;
  }
  .repo-card .meta .stat .n { color: var(--text-1); font-weight: 600; font-size: 12.5px; }
  .repo-card .meta .stat .n.crit { color: var(--sev-crit); }
  .repo-card .meta .stat .n.zero { color: var(--text-4); }
  .repo-card .right {
    display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
    text-align: right;
  }
  .repo-card .right .when {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-3);
    letter-spacing: 0.01em;
  }
  .repo-card .spark-14 { grid-column: 1 / -1; margin-top: 2px; }
  .repo-card.idle .title, .repo-card.idle .meta { opacity: 0.55; }

  /* ── Stacked severity bar (chart) ──────────────────────────────── */
  .chart-bar {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 140px;
    padding: 6px 0;
  }
  .chart-bar .col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column-reverse;
    gap: 1px;
    position: relative;
    height: 100%;
    justify-content: flex-start;
  }
  .chart-bar .col .seg {
    width: 100%;
    background: var(--text-4);
    border-radius: 1px;
    transition: filter 0.15s;
  }
  .chart-bar .col .seg.crit { background: var(--sev-crit); }
  .chart-bar .col .seg.major { background: var(--sev-major); }
  .chart-bar .col .seg.minor { background: var(--sev-minor); }
  .chart-bar .col .seg.nit { background: var(--sev-nit); }
  .chart-bar .col:hover .seg { filter: brightness(1.2); }
  .chart-bar .col .empty-dot {
    height: 1px;
    background: var(--line-soft);
    border-radius: 0.5px;
    align-self: stretch;
    opacity: 0.6;
  }
  .chart-legend {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--line-soft);
    font-size: 11px;
    color: var(--text-3);
  }
  .chart-legend .it {
    display: inline-flex; align-items: center; gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  .chart-legend .it .sw {
    width: 9px; height: 9px; border-radius: 2px;
    background: currentColor;
  }
  .chart-legend .it.crit { color: var(--sev-crit); }
  .chart-legend .it.major { color: var(--sev-major); }
  .chart-legend .it.minor { color: var(--sev-minor); }
  .chart-legend .it.nit { color: var(--sev-nit); }
  .chart-legend .count { color: var(--text-1); font-weight: 600; margin-left: 2px; }
  .chart-xaxis {
    display: flex;
    gap: 3px;
    font-size: 9.5px;
    font-family: var(--font-mono);
    color: var(--text-4);
    letter-spacing: 0.02em;
    margin-top: 6px;
  }
  .chart-xaxis span { flex: 1; text-align: center; }

  /* Inline sparkbar (per-repo row) */
  .spark-14 {
    display: flex;
    gap: 2px;
    align-items: flex-end;
    height: 28px;
  }
  .spark-14 .col {
    flex: 1;
    min-height: 2px;
    background: var(--line-strong);
    border-radius: 1px;
    position: relative;
  }
  .spark-14 .col.has { background: var(--text-2); }
  .spark-14 .col.has-crit { background: var(--sev-crit); box-shadow: 0 0 4px var(--sev-crit-line); }
  .spark-14 .col.has-major { background: var(--sev-major); }
  .spark-14 .col.has-minor { background: var(--sev-minor); }
  .spark-14 .col .t { position: absolute; inset: 0; }

  /* ── Horizontal bar (hot paths) ────────────────────────────────── */
  .hbar-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 54px;
    align-items: center;
    gap: 12px;
    padding: 7px 14px;
    border-bottom: 1px solid var(--line-soft);
  }
  .hbar-row:last-child { border-bottom: 0; }
  .hbar-row .label {
    display: flex; flex-direction: column; gap: 4px;
    min-width: 0;
  }
  .hbar-row .label .path {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hbar-row .hb-track {
    display: flex;
    height: 6px;
    background: var(--bg-deep);
    border-radius: 3px;
    overflow: hidden;
  }
  .hbar-row .hb-seg { height: 100%; }
  .hbar-row .hb-seg.crit { background: var(--sev-crit); }
  .hbar-row .hb-seg.major { background: var(--sev-major); }
  .hbar-row .num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    font-size: 12px;
    color: var(--text-1);
    font-weight: 600;
  }

  /* ── Donut ─────────────────────────────────────────────────────── */
  .donut-wrap {
    display: flex;
    gap: 18px;
    align-items: center;
  }
  .donut { width: 88px; height: 88px; flex-shrink: 0; transform: rotate(-90deg); }
  .donut circle { fill: none; stroke-width: 10; }
  .donut .bg { stroke: var(--line); }
  .donut-legend { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .donut-legend .it { display: flex; align-items: center; gap: 8px; }
  .donut-legend .sw { width: 9px; height: 9px; border-radius: 2px; }

  /* ── Risk line chart (replaces old sparkline) ──────────────────── */
  .risk-chart-wrap { position: relative; width: 100%; height: 140px; padding-left: 28px; }
  .risk-chart-wrap .plot { position: relative; width: 100%; height: 100%; }
  .risk-chart { width: 100%; height: 100%; display: block; overflow: visible; }
  .risk-chart .area { fill: url(#riskGrad); opacity: 0.75; }
  .risk-chart .line { stroke: var(--accent-bright); stroke-width: 1.6; fill: none; vector-effect: non-scaling-stroke; }
  .risk-chart-wrap .axis { position: absolute; inset: 0; pointer-events: none; }
  .risk-chart-wrap .axis .gridline {
    position: absolute; left: 28px; right: 0;
    border-top: 1px dashed var(--line-soft);
    height: 0;
  }
  .risk-chart-wrap .axis .ylabel {
    position: absolute; left: 0; width: 24px;
    text-align: right;
    font-size: 10px; font-family: var(--font-mono);
    color: var(--text-4);
    transform: translateY(-50%);
    font-variant-numeric: tabular-nums;
  }
  .risk-chart-wrap .dots { position: absolute; inset: 0 0 0 28px; pointer-events: none; }
  .risk-chart-wrap .dot-marker {
    position: absolute;
    width: 6px; height: 6px; border-radius: 50%;
    transform: translate(-50%, -50%);
    border: 1.3px solid var(--bg-deep);
    pointer-events: auto;
  }

  /* ── Timeline list (events, reviews) ───────────────────────────── */
  .tl {
    display: flex; flex-direction: column;
    padding: 4px 0;
  }
  .tl-item {
    display: grid;
    grid-template-columns: 72px 14px 1fr;
    gap: 10px;
    padding: 7px 14px;
    align-items: start;
    position: relative;
    font-size: 12.5px;
  }
  .tl-item .when {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-3);
    padding-top: 3px;
    text-align: right;
    white-space: nowrap;
  }
  .tl-item .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--text-4);
    margin: 6px auto 0;
    position: relative;
  }
  .tl-item.sev-critical .dot { background: var(--sev-crit); box-shadow: 0 0 6px var(--sev-crit-line); }
  .tl-item.sev-major .dot { background: var(--sev-major); }
  .tl-item.sev-minor .dot { background: var(--sev-minor); }
  .tl-item.approve .dot { background: var(--good); }
  .tl-item:not(:last-child)::before {
    content: "";
    position: absolute;
    left: calc(72px + 10px + 7px);
    top: 20px; bottom: -2px;
    width: 1px;
    background: var(--line-soft);
  }
  .tl-item .body {
    display: flex; flex-direction: column; gap: 3px;
    min-width: 0;
  }
  .tl-item .body .row1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tl-item .body .row2 { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 11.5px; }
  .tl-item .body .title { color: var(--text); font-weight: 500; }
  .tl-item .body .title:hover { color: var(--accent-bright); }

  /* ── KV grid (settings-style pair) ─────────────────────────────── */
  .kv {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 16px;
  }
  .kv dt {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-3);
    margin: 0 0 4px;
  }
  .kv dd {
    margin: 0;
    color: var(--text);
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  .kv dd.mono { font-family: var(--font-mono); font-size: 12px; color: var(--text-1); }

  /* ── Risk meter (inline) ───────────────────────────────────────── */
  .risk-meter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px 3px 6px;
    border-radius: 999px;
    border: 1px solid var(--line-strong);
    background: var(--bg-elev);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.015em;
  }
  .risk-meter .bar {
    width: 40px; height: 4px;
    background: var(--line);
    border-radius: 2px;
    overflow: hidden;
  }
  .risk-meter .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--good), var(--sev-minor) 40%, var(--sev-major) 70%, var(--sev-crit));
  }
  .risk-meter .num { font-variant-numeric: tabular-nums; color: var(--text); }
  .risk-meter .lvl { text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.08em; color: var(--text-3); }

  /* ── Misc text utilities (pared back) ──────────────────────────── */
  .muted { color: var(--text-3); }
  .dim { color: var(--text-2); }
  .mono { font-family: var(--font-mono); }
  .tnum { font-variant-numeric: tabular-nums; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nowrap { white-space: nowrap; }

  /* ── Log-tail rows (settings) ──────────────────────────────────── */
  .logrow {
    display: grid;
    grid-template-columns: 64px 54px 1fr;
    gap: 10px;
    padding: 6px 14px;
    border-bottom: 1px solid var(--line-soft);
    font-size: 12px;
    align-items: start;
  }
  .logrow:last-child { border-bottom: 0; }
  .logrow .ts { font-family: var(--font-mono); color: var(--text-3); font-size: 10.5px; padding-top: 2px; }
  .logrow .lvl {
    font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase;
    display: inline-block;
    padding: 2px 6px;
    border-radius: 3px;
    text-align: center;
  }
  .logrow .lvl.error, .logrow .lvl.fatal { background: var(--danger-soft); color: #ffc7c7; border: 1px solid var(--danger-line); }
  .logrow .lvl.warn { background: var(--warn-soft); color: #ffe1a0; border: 1px solid var(--warn-line); }
  .logrow .msg { color: var(--text-1); word-break: break-word; }

  /* ── Grids ─────────────────────────────────────────────────────── */
  .grid { display: grid; gap: 14px; }
  .grid.stack { grid-template-columns: 1fr; }
  .grid.two { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .grid.three { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .grid.four { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .grid.hero { grid-template-columns: minmax(0, 1.6fr) minmax(260px, 1fr); gap: 14px; }
  @media (max-width: 1000px) { .grid.hero { grid-template-columns: 1fr; } }

  /* ── Filter bar (findings) ─────────────────────────────────────── */
  .filterbar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 10px 12px;
    padding: 14px;
  }
  .filterbar .wide { grid-column: span 2; }
  .filter-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 14px;
    border-top: 1px solid var(--line-soft);
    background: rgba(0,0,0,0.18);
  }
  .filter-foot .hint { font-size: 11.5px; color: var(--text-3); }

  /* ── Empty state ───────────────────────────────────────────────── */
  .empty {
    padding: 40px 20px;
    text-align: center;
    color: var(--text-3);
    font-size: 13px;
  }
  .empty .title { color: var(--text-1); font-size: 14px; font-weight: 500; margin-bottom: 6px; }

  /* ── Markdown body — GitHub-ish in the new palette ─────────────── */
  .md-body { color: var(--text-1); font-size: 13.5px; line-height: 1.6; word-wrap: break-word; }
  .md-body > :first-child { margin-top: 0; }
  .md-body > :last-child { margin-bottom: 0; }
  .md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
    color: var(--text); font-weight: 600; line-height: 1.3;
    margin: 1.2em 0 0.55em; letter-spacing: -0.005em;
    font-family: var(--font-display);
  }
  .md-body h1 { font-size: 1.18rem; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
  .md-body h2 { font-size: 1.04rem; padding-bottom: 0.2em; border-bottom: 1px solid var(--line); }
  .md-body h3 { font-size: 0.95rem; }
  .md-body h4 { font-size: 0.9rem; }
  .md-body p { margin: 0.5em 0 0.75em; }
  .md-body a { color: var(--accent-bright); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  .md-body a:hover { color: var(--text); }
  .md-body strong { color: var(--text); font-weight: 600; }
  .md-body em { color: var(--text-1); }
  .md-body code {
    background: var(--bg-deep); padding: 0.13em 0.4em; border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 0.85em; color: var(--text); white-space: break-spaces;
    border: 1px solid var(--line-soft);
  }
  .md-body pre {
    background: var(--bg-deep); border: 1px solid var(--line); border-radius: 6px;
    padding: 0.75em 1em; overflow-x: auto; margin: 0.8em 0;
    font-size: 0.78rem; line-height: 1.55;
  }
  .md-body pre code { background: transparent; padding: 0; border: 0; font-size: inherit; white-space: pre; }
  .md-body blockquote {
    border-left: 3px solid var(--accent); padding: 0.2em 1em;
    color: var(--text-1); margin: 0.75em 0; background: var(--accent-soft);
    border-radius: 0 4px 4px 0;
  }
  .md-body ul, .md-body ol { margin: 0.5em 0 0.75em; padding-left: 1.75em; }
  .md-body li { margin: 0.22em 0; }
  .md-body li > p { margin: 0.25em 0; }
  .md-body details {
    border: 1px solid var(--line); border-radius: 6px;
    padding: 0.5em 0.9em; margin: 0.6em 0; background: var(--bg-elev);
  }
  .md-body details[open] { background: var(--bg-elev-2); }
  .md-body summary {
    cursor: pointer; color: var(--text-1); font-weight: 500;
    margin: 0; list-style: none; user-select: none;
  }
  .md-body summary::-webkit-details-marker { display: none; }
  .md-body summary::before { content: "▸ "; color: var(--text-3); }
  .md-body details[open] > summary::before { content: "▾ "; color: var(--accent-bright); }
  .md-body summary:hover { color: var(--text); }
  .md-body details[open] > summary { margin-bottom: 0.5em; padding-bottom: 0.5em; border-bottom: 1px solid var(--line-soft); }
  .md-body table { width: 100%; border-collapse: collapse; margin: 0.75em 0; font-size: 0.82rem; }
  .md-body table th, .md-body table td {
    text-align: left; padding: 0.45em 0.75em; border: 1px solid var(--line);
  }
  .md-body table th { background: var(--bg-elev-2); color: var(--text); font-weight: 600; }
  .md-body hr { border: 0; border-top: 1px solid var(--line); margin: 1.25em 0; }
  .md-body img { max-width: 100%; border-radius: 4px; }
  .md-body input[type="checkbox"] { margin-right: 0.4em; accent-color: var(--accent); vertical-align: middle; width: 0.9em; height: 0.9em; }
  .md-body .task-list-item { list-style: none; margin-left: -1.5em; }

  [data-md-wrap] .md-raw { display: none !important; }
  [data-md-wrap].show-raw .md-rendered { display: none !important; }
  [data-md-wrap].show-raw .md-raw { display: block !important; }
`;

const PATHNAME_SCRIPT = `
  (function(){
    var els = document.querySelectorAll('[data-nav-key]');
    var cur = document.body.getAttribute('data-nav') || '';
    els.forEach(function(a){
      var key = a.getAttribute('data-nav-key');
      if (key === cur) a.classList.add('active');
    });
  })();
`;

// ─────────────────────────────────────────────────────────────────────────────
// Layout render
// ─────────────────────────────────────────────────────────────────────────────

export type NavKey = "overview" | "findings" | "patterns" | "settings" | "";

export interface RenderLayoutOpts {
  title: string;
  body: string;
  crumbs?: Crumb[];
  user?: CurrentUser | null;
  active?: NavKey;
}

export function renderLayout(opts: RenderLayoutOpts): string {
  const crumbs = opts.crumbs ?? [];
  const user = opts.user ?? getRequestContext().user;
  const active = opts.active ?? detectActiveFromCrumbs(crumbs);
  const crumbHtml = crumbs.length
    ? `<nav class="crumbs" aria-label="Breadcrumb">${crumbs
        .map((c, i) => {
          const part = c.href
            ? `<a href="${esc(c.href)}">${esc(c.label)}</a>`
            : `<span class="current">${esc(c.label)}</span>`;
          return i === 0 ? part : `<span class="sep">/</span>${part}`;
        })
        .join("")}</nav>`
    : "";

  const navItem = (key: NavKey, href: string, label: string, icon: string) =>
    `<a href="${esc(href)}" data-nav-key="${key}" class="snav">${icon}<span>${esc(label)}</span></a>`;

  const userInitial = user ? user.login.slice(0, 1).toUpperCase() : "?";

  const sidebar = `
    <aside class="sidebar">
      <a href="/dashboard" class="sidebar-head">
        ${LOGO_SVG}
        <div>
          <div class="wordmark">DiffSentry</div>
          <div class="wordmark-sub">REVIEW OPS</div>
        </div>
      </a>
      <nav class="sidebar-nav" aria-label="Primary">
        ${navItem("overview", "/dashboard", "Overview", ICON.overview)}
        ${navItem("findings", "/dashboard/findings", "Findings", ICON.findings)}
        ${navItem("patterns", "/dashboard/patterns", "Patterns", ICON.patterns)}
        ${navItem("settings", "/dashboard/settings", "Settings", ICON.settings)}
      </nav>
      ${
        user
          ? `<div class="sidebar-foot">
               <span class="avatar">${esc(userInitial)}</span>
               <span class="login" title="@${esc(user.login)}">@${esc(user.login)}</span>
               <a class="signout" href="/dashboard/auth/logout">Sign out</a>
             </div>`
          : ""
      }
    </aside>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(opts.title)} — DiffSentry</title>
  <meta name="color-scheme" content="dark" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>${DESIGN_TOKENS}${BASE_STYLES}</style>
</head>
<body data-nav="${esc(active)}">
  <div class="app">
    ${sidebar}
    <main class="main">
      ${crumbHtml}
      ${opts.body}
    </main>
  </div>
  <script>${PATHNAME_SCRIPT}</script>
</body>
</html>`;
}

function detectActiveFromCrumbs(crumbs: Crumb[]): NavKey {
  if (!crumbs.length) return "overview";
  const labels = crumbs.map((c) => c.label.toLowerCase());
  if (labels.some((l) => l === "findings")) return "findings";
  if (labels.some((l) => l === "patterns")) return "patterns";
  if (labels.some((l) => l === "settings")) return "settings";
  return "overview";
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive helpers
// ─────────────────────────────────────────────────────────────────────────────

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** Render the page header block (title, subtitle, right-side actions). */
export function pageHeader(opts: { title: string; subtitle?: string; right?: string }): string {
  return `<header class="page-head">
    <div class="title-block">
      <h1>${esc(opts.title)}</h1>
      ${opts.subtitle ? `<p class="subtitle">${opts.subtitle}</p>` : ""}
    </div>
    ${opts.right ? `<div class="actions">${opts.right}</div>` : ""}
  </header>`;
}

/** A generic card wrapper. `right` slot is shown inside the card header. */
export function card(opts: {
  title?: string;
  subtitle?: string;
  right?: string;
  body: string;
  tone?: "accent" | "good" | "danger";
  bodyClass?: "flush" | "tight" | "chart";
}): string {
  const toneCls = opts.tone ? ` tone-${opts.tone}` : "";
  const head =
    opts.title || opts.subtitle || opts.right
      ? `<div class="card-head">
          ${opts.title ? `<h2>${esc(opts.title)}</h2>` : `<span></span>`}
          <div class="card-sub">${opts.subtitle ? esc(opts.subtitle) : ""}${opts.right ? (opts.subtitle ? " " : "") + opts.right : ""}</div>
         </div>`
      : "";
  const bodyCls = opts.bodyClass ? ` ${opts.bodyClass}` : "";
  return `<section class="card${toneCls}">${head}<div class="card-body${bodyCls}">${opts.body}</div></section>`;
}

export function metric(opts: {
  label: string;
  value: string | number;
  tone?: "good" | "danger" | "neutral";
  delta?: string;
  hero?: boolean;
  foot?: string;
}): string {
  const valueCls = opts.tone === "danger" ? " danger" : opts.tone === "good" ? " good" : "";
  const heroCls = opts.hero ? " hero" : "";
  return `<div class="metric${heroCls}">
    <div class="metric-label">${esc(opts.label)}</div>
    <div class="metric-value${valueCls}">${esc(String(opts.value))}</div>
    ${opts.delta ? `<div class="metric-delta">${opts.delta}</div>` : ""}
    ${opts.foot ? `<div class="metric-foot">${opts.foot}</div>` : ""}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Badges / chips
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_CHIP: Record<string, string> = {
  critical: "sev-crit",
  major: "sev-major",
  minor: "sev-minor",
  nit: "sev-nit",
};
export function severityBadge(sev: string | null | undefined): string {
  const k = (sev ?? "").toLowerCase();
  const cls = SEVERITY_CHIP[k] ?? "muted";
  const label = k || "—";
  return `<span class="chip ${cls} uppercase"><span class="dot"></span>${esc(label)}</span>`;
}

const RISK_TONE: Record<string, string> = {
  low: "good",
  moderate: "warn",
  elevated: "warn",
  high: "danger",
  critical: "danger",
};
export function riskBadge(level: string | null | undefined, score?: number | null): string {
  const k = (level ?? "").toLowerCase();
  const tone = RISK_TONE[k] ?? "muted";
  const s = typeof score === "number" ? Math.max(0, Math.min(100, score)) : null;
  const pct = s ?? 0;
  const levelDisplay = k || "—";
  return `<span class="risk-meter">
    <span class="bar"><span class="fill" style="width:${pct}%"></span></span>
    <span class="num">${s == null ? "—" : s}</span>
    <span class="lvl ${tone}">${esc(levelDisplay)}</span>
  </span>`;
}

const APPROVAL_CLASS: Record<string, string> = {
  approve: "good",
  approved: "good",
  request_changes: "danger",
  comment: "neutral",
  commented: "neutral",
};
const APPROVAL_LABEL: Record<string, string> = {
  approve: "approved",
  approved: "approved",
  request_changes: "changes requested",
  comment: "commented",
  commented: "commented",
};
export function approvalBadge(approval: string | null | undefined): string {
  const k = (approval ?? "").toLowerCase();
  const cls = APPROVAL_CLASS[k] ?? "muted";
  const label = APPROVAL_LABEL[k] ?? k ?? "—";
  return `<span class="chip ${cls} uppercase">${esc(label || "—")}</span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Charts / viz primitives
// ─────────────────────────────────────────────────────────────────────────────

/** One day's severity bin — used by both inline sparkbars and the big chart. */
export interface DayBin {
  day: string;          // YYYY-MM-DD
  reviews: number;
  critical: number;
  major: number;
  minor: number;
  nit: number;
}

/** Build an empty N-day series ending today, then merge real bins into it. */
export function buildDaySeries(bins: DayBin[], days: number): DayBin[] {
  const byDay = new Map(bins.map((b) => [b.day, b]));
  const out: DayBin[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(
      byDay.get(key) ?? { day: key, reviews: 0, critical: 0, major: 0, minor: 0, nit: 0 },
    );
  }
  return out;
}

/** Big stacked-severity bar chart — one column per day. */
export function stackedSeverityBar(series: DayBin[]): string {
  const max = Math.max(1, ...series.map((d) => d.critical + d.major + d.minor + d.nit));
  const totals = series.reduce(
    (acc, d) => {
      acc.critical += d.critical;
      acc.major += d.major;
      acc.minor += d.minor;
      acc.nit += d.nit;
      return acc;
    },
    { critical: 0, major: 0, minor: 0, nit: 0 },
  );
  const cols = series
    .map((d) => {
      const total = d.critical + d.major + d.minor + d.nit;
      if (total === 0) {
        return `<div class="col" title="${esc(d.day)} · no reviews"><div class="empty-dot"></div></div>`;
      }
      const pct = (n: number) => (n === 0 ? 0 : (n / max) * 100);
      const segs = [
        d.nit > 0 ? `<div class="seg nit" style="height:${pct(d.nit).toFixed(1)}%"></div>` : "",
        d.minor > 0 ? `<div class="seg minor" style="height:${pct(d.minor).toFixed(1)}%"></div>` : "",
        d.major > 0 ? `<div class="seg major" style="height:${pct(d.major).toFixed(1)}%"></div>` : "",
        d.critical > 0 ? `<div class="seg crit" style="height:${pct(d.critical).toFixed(1)}%"></div>` : "",
      ].join("");
      const title = `${d.day} · ${total} finding${total === 1 ? "" : "s"} (crit ${d.critical} · maj ${d.major} · min ${d.minor} · nit ${d.nit})`;
      return `<div class="col" title="${esc(title)}">${segs}</div>`;
    })
    .join("");
  // X-axis: show first, middle, last day
  const last = series[series.length - 1]?.day ?? "";
  const first = series[0]?.day ?? "";
  const midIdx = Math.floor(series.length / 2);
  const mid = series[midIdx]?.day ?? "";
  const axisLabels = series
    .map((d, i) => {
      if (i === 0) return `<span>${esc(first.slice(5))}</span>`;
      if (i === midIdx) return `<span>${esc(mid.slice(5))}</span>`;
      if (i === series.length - 1) return `<span>${esc(last.slice(5))}</span>`;
      return `<span></span>`;
    })
    .join("");
  return `<div class="chart-bar">${cols}</div>
  <div class="chart-xaxis">${axisLabels}</div>
  <div class="chart-legend">
    <span class="it crit"><span class="sw"></span>Critical<span class="count">${totals.critical}</span></span>
    <span class="it major"><span class="sw"></span>Major<span class="count">${totals.major}</span></span>
    <span class="it minor"><span class="sw"></span>Minor<span class="count">${totals.minor}</span></span>
    <span class="it nit"><span class="sw"></span>Nit<span class="count">${totals.nit}</span></span>
  </div>`;
}

/** Small 14-day sparkbar — per row on the overview. */
export function miniSparkbar(series: DayBin[]): string {
  const max = Math.max(1, ...series.map((d) => d.critical + d.major + d.minor + d.nit));
  return `<div class="spark-14" aria-hidden="true">${series
    .map((d) => {
      const total = d.critical + d.major + d.minor + d.nit;
      if (total === 0) return `<div class="col" title="${esc(d.day)} · 0"></div>`;
      const h = Math.max(4, (total / max) * 100);
      let cls = "has";
      if (d.critical > 0) cls = "has-crit";
      else if (d.major > 0) cls = "has-major";
      else if (d.minor > 0) cls = "has-minor";
      return `<div class="col ${cls}" style="height:${h.toFixed(0)}%" title="${esc(d.day)} · ${total}"></div>`;
    })
    .join("")}</div>`;
}

/** Risk-line chart — 0-100 risk score over time. */
export function riskLine(points: { created_at: string; risk_score: number | null; number: number }[]): string {
  if (points.length < 2) {
    return `<div class="empty">
      <div class="title">Not enough data yet</div>
      <div>Need at least two reviews to trace risk over time.</div>
    </div>`;
  }
  const w = 720;
  const h = 140;
  const padT = 12;
  const padB = 22;
  const innerH = h - padT - padB;
  const n = points.length;
  const coords = points.map((p, i) => {
    const x = (i * w) / Math.max(1, n - 1);
    const score = typeof p.risk_score === "number" ? p.risk_score : 0;
    const y = padT + innerH - (score / 100) * innerH;
    return [x, y, score, p] as const;
  });
  const path = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `0,${padT + innerH} ` + path + ` ${w},${padT + innerH}`;
  const dots = coords
    .map(([x, y, score, p]) => {
      const color =
        score >= 75 ? "#fb6d82"
        : score >= 55 ? "#fb923c"
        : score >= 35 ? "#fbbf24"
        : score >= 15 ? "#facc15"
        : "#4ade80";
      const leftPct = n === 1 ? 0 : (x / w) * 100;
      const topPct = (y / h) * 100;
      return `<div class="dot-marker" style="left:${leftPct.toFixed(2)}%;top:${topPct.toFixed(2)}%;background:${color}" title="#${p.number} · risk ${score} · ${p.created_at.slice(0, 10)}"></div>`;
    })
    .join("");
  const axis = [0, 25, 50, 75, 100]
    .map((pct) => {
      const yPx = padT + innerH - (pct / 100) * innerH;
      const topPct = (yPx / h) * 100;
      return `<div class="gridline" style="top:${topPct.toFixed(2)}%"></div>
              <div class="ylabel" style="top:${topPct.toFixed(2)}%">${pct}</div>`;
    })
    .join("");
  return `<div class="risk-chart-wrap">
    <div class="axis">${axis}</div>
    <div class="plot">
      <svg viewBox="0 0 ${w} ${h}" class="risk-chart" preserveAspectRatio="none">
        <defs>
          <linearGradient id="riskGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#5a8dff" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="#5a8dff" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <polygon points="${areaPath}" class="area"/>
        <polyline points="${path}" class="line"/>
      </svg>
    </div>
    <div class="dots">${dots}</div>
  </div>`;
}

/** Horizontal bar row — critical+major split. */
export function hbar(opts: { label: string; critical: number; major: number; total: number; href?: string; max: number }): string {
  const pctCrit = opts.max > 0 ? (opts.critical / opts.max) * 100 : 0;
  const pctMaj = opts.max > 0 ? (opts.major / opts.max) * 100 : 0;
  const labelHtml = opts.href
    ? `<a class="path" href="${esc(opts.href)}" style="color:inherit">${esc(opts.label)}</a>`
    : `<span class="path">${esc(opts.label)}</span>`;
  return `<div class="hbar-row">
    <div class="label">
      ${labelHtml}
      <div class="hb-track">
        ${opts.critical > 0 ? `<div class="hb-seg crit" style="width:${pctCrit.toFixed(1)}%"></div>` : ""}
        ${opts.major > 0 ? `<div class="hb-seg major" style="width:${pctMaj.toFixed(1)}%"></div>` : ""}
      </div>
    </div>
    <div class="num">${opts.total}</div>
  </div>`;
}

/** Donut chart — for approval ratios and similar. */
export function donut(slices: { label: string; value: number; color: string }[], size = 88): string {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const segs = total === 0
    ? `<circle class="bg" cx="${size / 2}" cy="${size / 2}" r="${r}"></circle>`
    : slices
        .map((s) => {
          if (s.value === 0) return "";
          const frac = s.value / total;
          const dash = frac * c;
          const seg = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${s.color}" stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}"></circle>`;
          offset += dash;
          return seg;
        })
        .join("");
  const legend = slices
    .map(
      (s) => `<div class="it"><span class="sw" style="background:${s.color}"></span>
        <span>${esc(s.label)}</span>
        <span class="mono" style="margin-left:auto;color:var(--text-1)">${s.value}</span>
      </div>`,
    )
    .join("");
  return `<div class="donut-wrap">
    <svg viewBox="0 0 ${size} ${size}" class="donut" aria-hidden="true">
      <circle class="bg" cx="${size / 2}" cy="${size / 2}" r="${r}"></circle>
      ${segs}
    </svg>
    <div class="donut-legend">${legend}</div>
  </div>`;
}

/** Classify a repo's 7d activity into a health tier for card coloring. */
export function repoHealth(prs: number, findings: number, critical: number): "idle" | "good" | "warn" | "crit" {
  if (prs === 0) return "idle";
  if (critical > 0) return "crit";
  if (findings > 4) return "warn";
  return "good";
}
