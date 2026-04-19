import type { FileChange } from "./types.js";

/**
 * Detect dependency-manifest changes and surface the added / removed /
 * version-changed packages so reviewers don't have to diff JSON by hand.
 * Pure-text parsing — no network calls and no resolution. Output is
 * intended to be folded into the walkthrough as a sibling block.
 */
export type DepDelta = {
  manifest: string;
  added: Array<{ name: string; version: string }>;
  removed: Array<{ name: string; version: string }>;
  changed: Array<{ name: string; from: string; to: string }>;
};

const NPM_MANIFESTS = ["package.json"];
const PY_MANIFESTS = ["requirements.txt", "Pipfile", "pyproject.toml"];
const RUST_MANIFESTS = ["Cargo.toml"];
const GO_MANIFESTS = ["go.mod"];
const RUBY_MANIFESTS = ["Gemfile"];

function isManifest(filename: string): boolean {
  const base = filename.split("/").pop() || filename;
  return (
    NPM_MANIFESTS.includes(base) ||
    PY_MANIFESTS.includes(base) ||
    RUST_MANIFESTS.includes(base) ||
    GO_MANIFESTS.includes(base) ||
    RUBY_MANIFESTS.includes(base)
  );
}

/**
 * Parse a unified-diff patch and return added/removed dependency lines.
 * Heuristic: split each ADDED/REMOVED line into a (name, version) pair
 * using the manifest format hints. Lines we can't classify are dropped.
 */
function parseManifestPatch(filename: string, patch: string): DepDelta {
  const base = filename.split("/").pop() || filename;
  const added: Array<{ name: string; version: string }> = [];
  const removed: Array<{ name: string; version: string }> = [];

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@") || raw.startsWith("---") || raw.startsWith("+++")) continue;
    if (!raw.startsWith("+") && !raw.startsWith("-")) continue;
    const isAdd = raw.startsWith("+");
    const line = raw.slice(1).trim();
    if (!line || line === "{" || line === "}" || line.startsWith("//") || line.startsWith("#")) continue;

    let parsed: { name: string; version: string } | null = null;

    if (NPM_MANIFESTS.includes(base)) {
      // package.json: "name": "version",
      const m = line.match(/^"([^"]+)"\s*:\s*"([^"]+)"\s*,?$/);
      if (m && !["version", "name", "description", "main", "module", "type", "license", "author", "repository", "homepage", "scripts", "private", "engines"].includes(m[1])) {
        parsed = { name: m[1], version: m[2] };
      }
    } else if (PY_MANIFESTS.includes(base) && base === "requirements.txt") {
      // requirements.txt: package==version  (or other operators)
      const m = line.match(/^([A-Za-z0-9._-]+)\s*([=<>!~]+)\s*([A-Za-z0-9._*+-]+)\s*(?:#.*)?$/);
      if (m) parsed = { name: m[1], version: `${m[2]}${m[3]}` };
    } else if (RUST_MANIFESTS.includes(base)) {
      // Cargo.toml: name = "version"  or name = { version = "x", ... }
      const m1 = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"\s*$/);
      const m2 = line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/);
      if (m1) parsed = { name: m1[1], version: m1[2] };
      else if (m2) parsed = { name: m2[1], version: m2[2] };
    } else if (GO_MANIFESTS.includes(base)) {
      // go.mod: \trequire path version
      const m = line.match(/^(?:require\s+)?([\w./-]+)\s+(v[\w.+-]+)\s*$/);
      if (m) parsed = { name: m[1], version: m[2] };
    } else if (RUBY_MANIFESTS.includes(base)) {
      // Gemfile: gem 'name', 'version'
      const m = line.match(/^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
      if (m) parsed = { name: m[1], version: m[2] ?? "(unpinned)" };
    } else if (PY_MANIFESTS.includes(base) && base === "pyproject.toml") {
      // pyproject.toml: name = "version" inside [tool.poetry.dependencies] etc.
      const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"\s*$/);
      if (m) parsed = { name: m[1], version: m[2] };
    }

    if (parsed) {
      (isAdd ? added : removed).push(parsed);
    }
  }

  // Pair adds/removes by name → "changed"
  const removedByName = new Map(removed.map((r) => [r.name, r]));
  const changed: DepDelta["changed"] = [];
  const addedFinal: DepDelta["added"] = [];
  for (const a of added) {
    const r = removedByName.get(a.name);
    if (r) {
      if (r.version !== a.version) {
        changed.push({ name: a.name, from: r.version, to: a.version });
      }
      removedByName.delete(a.name);
    } else {
      addedFinal.push(a);
    }
  }
  const removedFinal = Array.from(removedByName.values());

  return { manifest: filename, added: addedFinal, removed: removedFinal, changed };
}

export function scanDependencyChanges(files: FileChange[]): DepDelta[] {
  const out: DepDelta[] = [];
  for (const f of files) {
    if (!isManifest(f.filename)) continue;
    if (!f.patch) continue;
    const delta = parseManifestPatch(f.filename, f.patch);
    if (delta.added.length || delta.removed.length || delta.changed.length) {
      out.push(delta);
    }
  }
  return out;
}

export function renderDepBlock(deltas: DepDelta[]): string {
  if (deltas.length === 0) return "";
  const lines: string[] = [];
  lines.push("## 📦 Dependency Changes");
  lines.push("");
  for (const d of deltas) {
    lines.push(`### \`${d.manifest}\``);
    if (d.added.length) {
      lines.push("");
      lines.push("**Added**");
      for (const a of d.added) lines.push(`- ➕ \`${a.name}\` @ \`${a.version}\``);
    }
    if (d.removed.length) {
      lines.push("");
      lines.push("**Removed**");
      for (const r of d.removed) lines.push(`- ➖ \`${r.name}\` @ \`${r.version}\``);
    }
    if (d.changed.length) {
      lines.push("");
      lines.push("**Version changed**");
      for (const c of d.changed) lines.push(`- 🔁 \`${c.name}\`: \`${c.from}\` → \`${c.to}\``);
    }
    lines.push("");
  }
  lines.push(
    "<sub>Verify the new versions don't introduce breaking changes or known CVEs. " +
      "Pinned versions are recommended for production.</sub>",
  );
  return lines.join("\n");
}
