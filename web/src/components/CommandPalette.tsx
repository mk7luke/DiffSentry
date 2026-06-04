import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSearch } from "../api/hooks";
import { apiSend, ApiError } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { useToast } from "../realtime/toast";
import type { Capabilities, SearchResult, SearchResultType } from "../api/types";
import {
  AuditIcon,
  CheckIcon,
  FindingsIcon,
  LearningIcon,
  OpsIcon,
  OverviewIcon,
  PatternsIcon,
  PauseIcon,
  PlayIcon,
  PullRequestIcon,
  RepoIcon,
  SearchIcon,
  SettingsIcon,
} from "./icons";

// ─────────────────────────────────────────────────────────────────────────────
// <CommandPalette> — a keyboard-first Cmd-K palette mounted once in the Shell.
//
// Combines three sources into one ranked, arrow-navigable list:
//   1. Navigation — jump to any top-level screen (capability-filtered).
//   2. Quick actions — contextual, role-gated commands for the PR you're on
//      (re-review / resolve / pause / resume / cancel), driven through the same
//      author+ command endpoints as <ActionButton> (requireRole + CSRF + audit
//      + SSE on the server).
//   3. Search — mixed repo / PR / finding / learning hits from /api/v1/search,
//      each deep-linking to its screen.
//
// Hand-rolled (no new deps) to honour the single-container / minimal-surface
// constraint. Enter runs the highlighted item; Esc closes; Cmd/Ctrl-K toggles.
// ─────────────────────────────────────────────────────────────────────────────

/** Dispatch this on `window` to open the palette from anywhere (e.g. the
 * sidebar trigger): `window.dispatchEvent(new Event(PALETTE_OPEN_EVENT))`. */
export const PALETTE_OPEN_EVENT = "diffsentry:open-command-palette";

/** Fire the open event — used by the sidebar's "Search" affordance. */
export function openCommandPalette() {
  window.dispatchEvent(new Event(PALETTE_OPEN_EVENT));
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

interface Item {
  id: string;
  group: "Actions" | "Navigation" | "Results";
  label: ReactNode;
  /** Plain-text label used for substring filtering of nav/action items. */
  text: string;
  sublabel?: string;
  Icon: Icon;
  tag?: { label: string; tone: string };
  danger?: boolean;
  run: () => void;
}

const NAV: Array<{ to: string; label: string; Icon: Icon; cap?: keyof Capabilities }> = [
  { to: "/ops", label: "Ops Console", Icon: OpsIcon },
  { to: "/overview", label: "Overview", Icon: OverviewIcon },
  { to: "/findings", label: "Findings", Icon: FindingsIcon },
  { to: "/patterns", label: "Patterns", Icon: PatternsIcon },
  { to: "/audit", label: "Audit log", Icon: AuditIcon, cap: "viewAudit" },
  { to: "/settings", label: "Settings", Icon: SettingsIcon },
];

/** Icon + chip styling per search-result type. */
const TYPE_META: Record<SearchResultType, { Icon: Icon; tag: string }> = {
  repo: { Icon: RepoIcon, tag: "repo" },
  pr: { Icon: PullRequestIcon, tag: "pr" },
  finding: { Icon: FindingsIcon, tag: "finding" },
  learning: { Icon: LearningIcon, tag: "learning" },
};

interface PrContext {
  owner: string;
  repo: string;
  number: number;
}

/** Pull `{owner, repo, number}` out of a `/repos/:owner/:repo/pr/:number` path. */
function parsePrContext(pathname: string): PrContext | null {
  const m = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pr\/(\d+)\/?$/);
  if (!m) return null;
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), number: Number.parseInt(m[3], 10) };
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { push } = useToast();
  const { capabilities } = useAuth();

  const close = useCallback(() => setOpen(false), []);

  // Search only while the palette is open and the (debounced) query is non-blank.
  const deferredQuery = useDeferredValue(query);
  const searchQ = open ? deferredQuery.trim() : "";
  const search = useSearch(searchQ, open);

  // Reset state each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus after the dialog paints.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Global toggle: Cmd/Ctrl-K from anywhere, plus a custom event so the sidebar
  // trigger (and any other UI) can open it without faking a keystroke. Esc is
  // handled on the dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
    };
  }, []);

  // ── Quick actions (contextual + role-gated) ──────────────────────────────
  const runAction = useCallback(
    async (opts: {
      ctx: PrContext;
      action: string;
      body?: unknown;
      successTitle: string;
      confirm?: string;
    }) => {
      const { ctx, action, body, successTitle, confirm } = opts;
      if (confirm && !window.confirm(confirm)) return;
      const enc = `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/prs/${ctx.number}`;
      try {
        const data = await apiSend<{ result?: string; detail?: string }>(`${enc}/${action}`, { body });
        push({
          tone: data?.result === "accepted" ? "info" : "success",
          title: successTitle,
          body: data?.detail,
        });
        void qc.invalidateQueries({ queryKey: ["pr", ctx.owner, ctx.repo, ctx.number] });
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.code === "forbidden"
              ? "You don't have permission for this action."
              : err.message
            : "Action failed.";
        push({ tone: "danger", title: "Action failed", body: message });
      }
    },
    [push, qc],
  );

  const actionItems = useMemo<Item[]>(() => {
    const ctx = parsePrContext(location.pathname);
    if (!ctx || !capabilities.triggerReview) return [];
    const ref = `${ctx.owner}/${ctx.repo}#${ctx.number}`;
    const mk = (
      id: string,
      label: string,
      Icon: Icon,
      run: () => void,
      danger = false,
    ): Item => ({ id, group: "Actions", label, text: label, sublabel: ref, Icon, run, danger });
    return [
      mk("act-review", "Re-review (full)", PlayIcon, () => {
        close();
        void runAction({ ctx, action: "review", body: { mode: "full" }, successTitle: "Re-review queued" });
      }),
      mk("act-resolve", "Resolve review threads", CheckIcon, () => {
        close();
        void runAction({ ctx, action: "resolve", successTitle: "Threads resolved" });
      }),
      mk("act-pause", "Pause reviews", PauseIcon, () => {
        close();
        void runAction({ ctx, action: "pause", successTitle: "Reviews paused" });
      }),
      mk("act-resume", "Resume reviews", PlayIcon, () => {
        close();
        void runAction({ ctx, action: "resume", successTitle: "Reviews resumed" });
      }),
      mk(
        "act-cancel",
        "Cancel in-flight review",
        PauseIcon,
        () => {
          close();
          void runAction({
            ctx,
            action: "cancel",
            successTitle: "Review canceled",
            confirm: `Abort any in-flight review for ${ref}?`,
          });
        },
        true,
      ),
    ];
  }, [location.pathname, capabilities.triggerReview, runAction, close]);

  // ── Navigation ───────────────────────────────────────────────────────────
  const navItems = useMemo<Item[]>(
    () =>
      NAV.filter((n) => !n.cap || capabilities[n.cap]).map((n) => ({
        id: `nav-${n.to}`,
        group: "Navigation",
        label: `Go to ${n.label}`,
        text: n.label,
        Icon: n.Icon,
        run: () => {
          close();
          navigate(n.to);
        },
      })),
    [capabilities, navigate, close],
  );

  // ── Search results ───────────────────────────────────────────────────────
  const resultItems = useMemo<Item[]>(() => {
    const results = (search.data?.results ?? []) as SearchResult[];
    return results.map((r, i) => {
      const meta = TYPE_META[r.type];
      return {
        id: `res-${r.type}-${r.to}-${i}`,
        group: "Results" as const,
        label: r.title,
        text: r.title,
        sublabel: r.subtitle ?? undefined,
        Icon: meta.Icon,
        tag: { label: r.severity ?? meta.tag, tone: r.severity ? `sev-${r.severity}` : "muted" },
        run: () => {
          close();
          navigate(r.to);
        },
      };
    });
  }, [search.data, navigate, close]);

  // ── Compose the visible list ─────────────────────────────────────────────
  // Nav + actions are filtered locally by the typed text; results come pre-
  // ranked from the server. With no query we show actions + nav as a launcher.
  const items = useMemo<Item[]>(() => {
    const needle = query.trim().toLowerCase();
    const match = (it: Item) => needle === "" || it.text.toLowerCase().includes(needle);
    return [...actionItems.filter(match), ...navItems.filter(match), ...resultItems];
  }, [query, actionItems, navItems, resultItems]);

  // Keep the active index in range as the list changes.
  useEffect(() => {
    setActive((a) => (items.length === 0 ? 0 : Math.min(a, items.length - 1)));
  }, [items.length]);

  // Scroll the active row into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (items.length === 0 ? 0 : (a + 1) % items.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (items.length === 0 ? 0 : (a - 1 + items.length) % items.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        items[active]?.run();
      }
    },
    [items, active, close],
  );

  if (!open) return null;

  // Build the flat list with group headers, tracking the running flat index so
  // arrow navigation and the rendered rows stay in lockstep.
  let flat = -1;
  let lastGroup: Item["group"] | null = null;
  const rows: ReactNode[] = [];
  for (const it of items) {
    if (it.group !== lastGroup) {
      lastGroup = it.group;
      rows.push(
        <div className="cmdk-group" key={`grp-${it.group}`}>
          {it.group}
        </div>,
      );
    }
    flat += 1;
    const idx = flat;
    const Icon = it.Icon;
    rows.push(
      <button
        type="button"
        key={it.id}
        data-idx={idx}
        className={`cmdk-row${idx === active ? " active" : ""}${it.danger ? " danger" : ""}`}
        onMouseMove={() => setActive(idx)}
        onClick={it.run}
      >
        <span className="cmdk-row-icon">
          <Icon />
        </span>
        <span className="cmdk-row-text">
          <span className="cmdk-row-label">{it.label}</span>
          {it.sublabel ? <span className="cmdk-row-sub">{it.sublabel}</span> : null}
        </span>
        {it.tag ? <span className={`chip ${it.tag.tone} uppercase`}>{it.tag.label}</span> : null}
      </button>,
    );
  }

  const showEmpty = items.length === 0;
  const searching = searchQ.length > 0 && search.isFetching;

  return (
    <div className="cmdk-overlay" role="presentation" onMouseDown={close}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cmdk-input-row">
          <span className="cmdk-input-icon">
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="cmdk-input"
            placeholder="Search repos, PRs, findings, learnings — or jump to a screen…"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
          />
          {searching ? <span className="spinner cmdk-spinner" /> : null}
          <kbd className="cmdk-kbd">esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {showEmpty ? (
            <div className="cmdk-empty">
              {searchQ.length > 0 ? (search.isFetching ? "Searching…" : `No matches for “${query.trim()}”.`) : "Type to search."}
            </div>
          ) : (
            rows
          )}
        </div>
        <div className="cmdk-foot">
          <span>
            <kbd className="cmdk-kbd">↑</kbd>
            <kbd className="cmdk-kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="cmdk-kbd">↵</kbd> open
          </span>
          <span>
            <kbd className="cmdk-kbd">⌘K</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}
