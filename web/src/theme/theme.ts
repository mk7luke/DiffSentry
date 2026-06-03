// ─────────────────────────────────────────────────────────────────────────────
// Theme primitives — pure, framework-free helpers shared by the React providers
// and (a hand-mirrored subset of) the no-flash inline script in index.html.
//
// The whole UI reads colors through CSS variables defined in tokens.css. Theme
// (dark/light) and density flip via the data-theme / data-density attributes on
// <html>; an admin-set brand color is applied as inline --accent* overrides on
// <html>, which therefore win over the per-theme accent tuning in tokens.css.
//
// KEEP IN SYNC: the accent-derivation math + storage keys here are duplicated in
// the inline <script> in web/index.html so the first paint already shows the
// right theme + brand. If you change derivation, update both.
// ─────────────────────────────────────────────────────────────────────────────

export type ThemePref = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export type Density = "comfortable" | "compact";

export const THEME_KEY = "ds-theme";
export const DENSITY_KEY = "ds-density";
export const ACCENT_KEY = "ds-accent";
export const INSTANCE_KEY = "ds-instance";

export const DEFAULT_THEME: ThemePref = "dark";
export const DEFAULT_DENSITY: Density = "comfortable";
/** Built-in accent — must match --accent in tokens.css and the backend default.
 * When branding equals this we let CSS own the accent (so per-theme tuning
 * applies); only a *custom* accent is pinned via inline vars. */
export const DEFAULT_ACCENT = "#5a8dff";
export const DEFAULT_INSTANCE_NAME = "DiffSentry";

const THEME_PREFS: ResolvedTheme[] = ["dark", "light"];

/** Coerce an arbitrary stored value to a valid theme preference. */
export function asThemePref(value: unknown): ThemePref {
  return value === "dark" || value === "light" || value === "system" ? value : DEFAULT_THEME;
}

/** Coerce an arbitrary stored value to a valid density. */
export function asDensity(value: unknown): Density {
  return value === "compact" ? "compact" : DEFAULT_DENSITY;
}

/** Resolve a preference to a concrete theme, consulting the OS for "system". */
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "system") {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    return "dark";
  }
  return THEME_PREFS.includes(pref) ? pref : "dark";
}

// ── Color math (small, dependency-free) ──────────────────────────────

type Rgb = [number, number, number];

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Parse #rgb / #rrggbb → [r,g,b], or null when malformed. */
export function parseHex(hex: string): Rgb | null {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb: Rgb): string {
  return "#" + rgb.map((c) => clamp255(c).toString(16).padStart(2, "0")).join("");
}

/** Linearly mix `rgb` toward `target` by `amt` (0..1). */
function mix(rgb: Rgb, target: Rgb, amt: number): Rgb {
  return [
    rgb[0] + (target[0] - rgb[0]) * amt,
    rgb[1] + (target[1] - rgb[1]) * amt,
    rgb[2] + (target[2] - rgb[2]) * amt,
  ];
}

function rgba(rgb: Rgb, a: number): string {
  return `rgba(${clamp255(rgb[0])}, ${clamp255(rgb[1])}, ${clamp255(rgb[2])}, ${a})`;
}

const ACCENT_VAR_NAMES = [
  "--accent",
  "--accent-bright",
  "--accent-deep",
  "--accent-glow",
  "--accent-soft",
  "--accent-line",
] as const;

/** Derive the full accent var set from a single brand hex. Falls back to the
 * built-in accent for a malformed input. */
export function accentVars(hex: string): Record<string, string> {
  const rgb = parseHex(hex) ?? (parseHex(DEFAULT_ACCENT) as Rgb);
  const bright = mix(rgb, [255, 255, 255], 0.18);
  const deep = mix(rgb, [0, 0, 0], 0.16);
  return {
    "--accent": toHex(rgb),
    "--accent-bright": toHex(bright),
    "--accent-deep": toHex(deep),
    "--accent-glow": rgba(rgb, 0.32),
    "--accent-soft": rgba(rgb, 0.1),
    "--accent-line": rgba(rgb, 0.28),
  };
}

function root(): HTMLElement | null {
  return typeof document !== "undefined" ? document.documentElement : null;
}

/** Apply a resolved theme + density to <html>. */
export function applyTheme(resolved: ResolvedTheme, density: Density): void {
  const el = root();
  if (!el) return;
  el.setAttribute("data-theme", resolved);
  el.setAttribute("data-density", density);
  el.style.colorScheme = resolved;
}

/** Pin a custom accent on <html>, or clear it (revert to CSS/theme accent) when
 * the color is the built-in default or malformed. */
export function applyAccent(hex: string | null | undefined): void {
  const el = root();
  if (!el) return;
  const normalized = typeof hex === "string" ? hex.trim().toLowerCase() : "";
  const isCustom = !!parseHex(normalized) && normalized !== DEFAULT_ACCENT;
  if (!isCustom) {
    for (const name of ACCENT_VAR_NAMES) el.style.removeProperty(name);
    return;
  }
  const vars = accentVars(normalized);
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
}

/** Best-effort localStorage read (private-mode / disabled storage → fallback). */
export function readStored(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** Best-effort localStorage write. */
export function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    // ignore — theming still works for the session, just won't persist
  }
}
