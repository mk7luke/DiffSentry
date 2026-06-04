import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyTheme,
  asDensity,
  asThemePref,
  DENSITY_KEY,
  resolveTheme,
  THEME_KEY,
  writeStored,
  readStored,
  type Density,
  type ResolvedTheme,
  type ThemePref,
} from "./theme";

// ─────────────────────────────────────────────────────────────────────────────
// Theme + density context.
//
// The no-flash inline script in index.html already applied the persisted theme
// to <html> before React mounted; this provider re-reads the same localStorage
// keys so its state matches that initial paint exactly (no flash, no mismatch),
// then owns subsequent changes. When the preference is "system" it tracks the OS
// color-scheme media query live.
// ─────────────────────────────────────────────────────────────────────────────

interface ThemeContextValue {
  /** The user's stored preference: dark | light | system. */
  theme: ThemePref;
  /** The concrete theme currently applied (system resolved against the OS). */
  resolvedTheme: ResolvedTheme;
  density: Density;
  setTheme: (pref: ThemePref) => void;
  setDensity: (density: Density) => void;
  /** Convenience: flip between dark and light (collapsing "system" to its current resolution). */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>(() => asThemePref(readStored(THEME_KEY)));
  const [density, setDensityState] = useState<Density>(() => asDensity(readStored(DENSITY_KEY)));
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme));

  // Apply (and re-apply) whenever the preference or density changes.
  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyTheme(resolved, density);
  }, [theme, density]);

  // Track the OS color scheme while the preference is "system".
  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      const resolved = mq.matches ? "light" : "dark";
      setResolvedTheme(resolved);
      applyTheme(resolved, density);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme, density]);

  const setTheme = useCallback((pref: ThemePref) => {
    setThemeState(pref);
    writeStored(THEME_KEY, pref);
  }, []);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    writeStored(DENSITY_KEY, next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: ThemePref = resolveTheme(prev) === "dark" ? "light" : "dark";
      writeStored(THEME_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, density, setTheme, setDensity, toggleTheme }),
    [theme, resolvedTheme, density, setTheme, setDensity, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
