import { useEffect, useState, type ComponentType, type CSSProperties, type SVGProps } from "react";
import { useTheme } from "../theme/useTheme";
import { accentVars, canonicalHex, DEFAULT_ACCENT, DEFAULT_INSTANCE_NAME } from "../theme/theme";
import { useBranding, useSetBranding } from "../api/hooks";
import { useInstanceBranding } from "../theme/useBranding";
import { useAuth } from "../auth/useAuth";
import { useToast } from "../realtime/toast";
import { ApiError } from "../api/client";
import type { Density, ThemePref } from "../theme/theme";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";

// ─────────────────────────────────────────────────────────────────────────────
// Appearance controls — theme + density (per-browser, localStorage) and the
// admin-only instance branding (name + accent, persisted server-side).
// ─────────────────────────────────────────────────────────────────────────────

interface SegOption<T extends string> {
  value: T;
  label: string;
  Icon?: ComponentType<SVGProps<SVGSVGElement>>;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`seg-btn${value === opt.value ? " active" : ""}`}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.Icon ? <opt.Icon /> : null}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const THEME_OPTIONS: SegOption<ThemePref>[] = [
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
];

const DENSITY_OPTIONS: SegOption<Density>[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

/** The per-user theme + density picker (Settings → Appearance). */
export function ThemeControls() {
  const { theme, density, setTheme, setDensity } = useTheme();
  return (
    <>
      <div className="appearance-row">
        <div className="label">
          <span className="name">Theme</span>
          <span className="hint">Dark, light, or follow your operating system.</span>
        </div>
        <Segmented value={theme} options={THEME_OPTIONS} onChange={setTheme} ariaLabel="Theme" />
      </div>
      <div className="appearance-row">
        <div className="label">
          <span className="name">Density</span>
          <span className="hint">Compact tightens spacing to fit more on screen.</span>
        </div>
        <Segmented value={density} options={DENSITY_OPTIONS} onChange={setDensity} ariaLabel="Density" />
      </div>
    </>
  );
}

/** Sidebar icon button that flips dark ⇄ light. */
export function SidebarThemeToggle() {
  const { resolvedTheme, toggleTheme } = useTheme();
  const next = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** Admin-only branding editor: instance name + accent color. */
export function BrandingForm() {
  const { capabilities } = useAuth();
  const query = useBranding();
  const live = useInstanceBranding();
  const setBranding = useSetBranding();
  const { push } = useToast();

  const serverName = query.data?.instanceName ?? live.instanceName;
  const serverAccent = query.data?.accentColor ?? live.accentColor;

  const [name, setName] = useState(serverName);
  const [accent, setAccent] = useState(serverAccent);

  // Sync local inputs when the server values change (initial load / live update),
  // unless the user is mid-edit with unsaved changes.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) {
      setName(serverName);
      setAccent(serverAccent);
    }
  }, [serverName, serverAccent, dirty]);

  if (!capabilities.manageConfig) return null;

  // Canonical #rrggbb (accepts hashless / 3-digit input); falls back to the
  // applied color while the field holds a malformed value.
  const previewAccent = canonicalHex(accent) ?? serverAccent;
  // Derive the full accent var set so the preview chip (bg/border/text/swatch)
  // reflects the candidate color, not the currently-applied one.
  const previewStyle = accentVars(previewAccent) as unknown as CSSProperties;

  function update(vars: { instanceName?: string | null; accentColor?: string | null }, successMsg: string) {
    setBranding.mutate(vars, {
      onSuccess: (data) => {
        setDirty(false);
        setName(data.instanceName);
        setAccent(data.accentColor);
        push({ tone: "success", title: successMsg });
      },
      onError: (err) => {
        const message =
          err instanceof ApiError
            ? err.code === "forbidden"
              ? "You don't have permission to change branding."
              : err.message
            : "Failed to save branding.";
        push({ tone: "danger", title: "Branding not saved", body: message });
      },
    });
  }

  function onSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      push({ tone: "danger", title: "Instance name required", body: "Enter a name or use Reset to defaults." });
      return;
    }
    // Send the canonical #rrggbb form so the server's (#-required) validation
    // accepts hashless / 3-digit input the user may have typed.
    const canonical = canonicalHex(accent);
    if (!canonical) {
      push({ tone: "danger", title: "Invalid accent color", body: "Use a hex color like #5a8dff." });
      return;
    }
    update({ instanceName: trimmed, accentColor: canonical }, "Branding saved");
  }

  function onReset() {
    update({ instanceName: null, accentColor: null }, "Branding reset to defaults");
  }

  const pending = setBranding.isPending;

  return (
    <div className="branding-form">
      <div className="row">
        <label className="field grow">
          Instance name
          <input
            type="text"
            value={name}
            maxLength={48}
            placeholder={DEFAULT_INSTANCE_NAME}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="field">
          Accent color
          <span className="color-field">
            <input
              type="color"
              aria-label="Accent color picker"
              value={previewAccent}
              onChange={(e) => {
                setAccent(e.target.value);
                setDirty(true);
              }}
            />
            <input
              type="text"
              aria-label="Accent color hex"
              value={accent}
              spellCheck={false}
              placeholder={DEFAULT_ACCENT}
              onChange={(e) => {
                setAccent(e.target.value);
                setDirty(true);
              }}
            />
          </span>
        </label>
      </div>
      <div className="branding-actions">
        <span className="branding-preview" style={previewStyle}>
          <span className="swatch" />
          {name.trim() || DEFAULT_INSTANCE_NAME}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={pending} aria-busy={pending}>
          {pending ? <span className="spinner btn-spinner" /> : null}
          Save branding
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onReset}
          disabled={pending}
          title="Clear the saved branding and revert to the instance default"
        >
          Reset to defaults
        </button>
      </div>
      <p className="muted" style={{ fontSize: 11.5 }}>
        Branding is instance-wide and applies to everyone. The accent recolors the whole UI; per-user theme and
        density above are stored only in this browser.
      </p>
    </div>
  );
}
