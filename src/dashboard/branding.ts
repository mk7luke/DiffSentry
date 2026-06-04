import { applySettingOverrides, getSettingOverride, type SettingOverrideOp } from "../storage/dao.js";

// ─────────────────────────────────────────────────────────────────────────────
// Instance branding — the self-hoster-facing "make it theirs" knobs: the
// instance name (shown in the sidebar wordmark + document title) and the accent
// color (the brand hue the whole UI derives its accent shades from).
//
// Resolution precedence (first wins):
//   1. settings_overrides (admin-set in the UI, persisted in SQLite)  — scope 'global'
//   2. DASHBOARD_INSTANCE_NAME / DASHBOARD_ACCENT_COLOR env defaults
//   3. built-in defaults (DiffSentry / #5a8dff)
//
// Persistence is optional everywhere: when the DB is disabled getSettingOverride
// returns undefined, so resolution simply falls through to env / built-ins.
// ─────────────────────────────────────────────────────────────────────────────

export const BRANDING_SCOPE = "global";
export const KEY_INSTANCE_NAME = "branding.instanceName";
export const KEY_ACCENT_COLOR = "branding.accentColor";

export const DEFAULT_INSTANCE_NAME = "DiffSentry";
export const DEFAULT_ACCENT_COLOR = "#5a8dff";

/** A 3- or 6-digit hex color, with leading '#'. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Cap the instance name so a stray paste can't blow out the sidebar/title. */
const MAX_INSTANCE_NAME = 48;

export interface Branding {
  instanceName: string;
  accentColor: string;
}

/** True when `value` is a syntactically valid hex color string. */
export function isValidAccent(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value.trim());
}

/** Canonical lowercase form of a (already-validated) hex color. */
export function normalizeAccent(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Clean an instance-name input: collapse internal whitespace, trim, and cap the
 * length. Returns null when the result is empty (caller treats that as "unset").
 */
export function sanitizeInstanceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_INSTANCE_NAME);
}

function envInstanceName(): string {
  return sanitizeInstanceName(process.env.DASHBOARD_INSTANCE_NAME) ?? DEFAULT_INSTANCE_NAME;
}

function envAccentColor(): string {
  const raw = process.env.DASHBOARD_ACCENT_COLOR;
  return isValidAccent(raw) ? normalizeAccent(raw) : DEFAULT_ACCENT_COLOR;
}

/** Resolve the effective branding (override → env → built-in). Never throws. */
export function resolveBranding(): Branding {
  const nameOverride = getSettingOverride<string>(BRANDING_SCOPE, KEY_INSTANCE_NAME);
  const accentOverride = getSettingOverride<string>(BRANDING_SCOPE, KEY_ACCENT_COLOR);
  const instanceName =
    typeof nameOverride === "string" && nameOverride.trim().length > 0 ? nameOverride : envInstanceName();
  const accentColor =
    typeof accentOverride === "string" && isValidAccent(accentOverride)
      ? normalizeAccent(accentOverride)
      : envAccentColor();
  return { instanceName, accentColor };
}

/**
 * A set of branding changes to apply. A `string` sets that override, `null`
 * clears it (revert to env / built-in), and `undefined` (field omitted) leaves
 * it untouched.
 */
export interface BrandingChanges {
  instanceName?: string | null;
  accentColor?: string | null;
}

/**
 * Apply branding changes atomically — both fields in one transaction, so a
 * two-field update can't half-apply. Returns false only on an actual write
 * error (see applySettingOverrides); true when applied or when persistence is
 * disabled. The caller should audit + broadcast only on a true result.
 */
export function applyBrandingOverrides(changes: BrandingChanges, updatedBy: string | null): boolean {
  const ops: SettingOverrideOp[] = [];
  if (changes.instanceName !== undefined) {
    ops.push(
      changes.instanceName === null
        ? { key: KEY_INSTANCE_NAME, clear: true }
        : { key: KEY_INSTANCE_NAME, value: changes.instanceName },
    );
  }
  if (changes.accentColor !== undefined) {
    ops.push(
      changes.accentColor === null
        ? { key: KEY_ACCENT_COLOR, clear: true }
        : { key: KEY_ACCENT_COLOR, value: changes.accentColor },
    );
  }
  return applySettingOverrides(BRANDING_SCOPE, ops, updatedBy);
}
