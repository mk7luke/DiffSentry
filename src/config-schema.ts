// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema for .diffsentry.yaml (RepoConfig) + a dependency-free validator.
//
// The schema is hand-mirrored from `RepoConfig` in src/types.ts. It is the
// contract shared with the SPA: the config editor ships it to the browser to
// drive the schema-aware form and run the same structural checks client-side for
// instant feedback. The server re-validates authoritatively on PUT before it
// will commit anything — the client copy is purely for UX.
//
// We deliberately avoid pulling in ajv (or any runtime schema lib): the schema
// uses only a small, well-understood subset (type/enum/properties/items/
// required/additionalProperties), and `validateRepoConfig` walks exactly that
// subset. Keep the two in lockstep — if you extend the schema with a keyword the
// walker doesn't know, it is simply ignored (fail-open), so only add keywords
// the walker handles.
// ─────────────────────────────────────────────────────────────────────────────

export type JsonSchema = {
  type?: "object" | "array" | "string" | "boolean" | "number" | "integer";
  enum?: readonly (string | number)[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minimum?: number;
  /** Human-readable hint surfaced by the form. Ignored by the validator. */
  description?: string;
  /** Render hint for the SPA form (e.g. "glob", "multiline"). Validator-ignored. */
  widget?: "glob" | "multiline" | "regex";
};

const SEVERITY_ENUM = ["critical", "major", "minor", "trivial"] as const;
const COMMENT_TYPE_ENUM = ["issue", "suggestion", "nitpick", "documentation", "security"] as const;
const CHECK_MODE_ENUM = ["off", "warning", "error"] as const;

const checkSection: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: CHECK_MODE_ENUM, description: "off | warning | error" },
    requirements: { type: "string", widget: "multiline", description: "What the check looks for." },
  },
};

export const REPO_CONFIG_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: { type: "string", description: "Natural language for review comments (e.g. en, es)." },
    tone_instructions: { type: "string", widget: "multiline", description: "Extra tone guidance for the reviewer." },

    reviews: {
      type: "object",
      additionalProperties: false,
      properties: {
        profile: { type: "string", enum: ["chill", "assertive"], description: "Overall review strictness." },
        request_changes_workflow: { type: "boolean", description: "Use REQUEST_CHANGES instead of COMMENT." },
        high_level_summary: { type: "boolean", description: "Post a high-level summary comment." },
        auto_apply_labels: { type: "boolean", description: "Apply suggested labels automatically." },
        auto_assign_reviewers: { type: "boolean", description: "Assign suggested reviewers automatically." },
        commit_status: { type: "boolean", description: "Set a commit status for the review." },
        abort_on_close: { type: "boolean", description: "Abort in-flight reviews when the PR closes." },
        builtin_patterns: { type: "boolean", description: "Run built-in performance / footgun checks." },

        walkthrough: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            collapse: { type: "boolean", description: "Collapse the walkthrough by default." },
            changed_files_summary: { type: "boolean" },
            sequence_diagrams: { type: "boolean" },
            estimate_effort: { type: "boolean" },
            suggested_labels: { type: "boolean" },
            suggested_reviewers: { type: "boolean" },
            poem: { type: "boolean", description: "Include a closing poem." },
          },
        },

        auto_review: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean", description: "Review PRs automatically on open/sync." },
            drafts: { type: "boolean", description: "Also review draft PRs." },
            auto_incremental_review: { type: "boolean", description: "Re-review on each push." },
            auto_pause_after_reviewed_commits: { type: "integer", minimum: 0, description: "Pause after N reviewed commits (0 = never)." },
            base_branches: { type: "array", items: { type: "string", widget: "regex" }, description: "Regex patterns for base branches to review." },
            labels: { type: "array", items: { type: "string" }, description: "Label rules; prefix with ! to exclude." },
            ignore_title_keywords: { type: "array", items: { type: "string" }, description: "Skip PRs whose title contains any of these." },
            ignore_usernames: { type: "array", items: { type: "string" }, description: "Skip PRs opened by these authors." },
          },
        },

        path_filters: {
          type: "array",
          items: { type: "string", widget: "glob" },
          description: "Include/exclude globs; prefix with ! to exclude.",
        },

        path_instructions: {
          type: "array",
          description: "Per-path reviewer instructions.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "instructions"],
            properties: {
              path: { type: "string", widget: "glob" },
              instructions: { type: "string", widget: "multiline" },
            },
          },
        },

        anti_patterns: {
          type: "array",
          description: "User-defined pattern checks run against added lines.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "pattern"],
            properties: {
              name: { type: "string", description: "Short label shown in the comment header." },
              pattern: { type: "string", widget: "regex", description: "Regex source tested against added lines." },
              flags: { type: "string", description: "Optional regex flags (e.g. i, m)." },
              severity: { type: "string", enum: SEVERITY_ENUM },
              type: { type: "string", enum: COMMENT_TYPE_ENUM },
              message: { type: "string", widget: "multiline" },
              advice: { type: "string", widget: "multiline" },
              path: { type: "string", widget: "glob", description: "Optional glob restricting where this applies." },
            },
          },
        },

        license_header: {
          type: "object",
          additionalProperties: false,
          required: ["required"],
          properties: {
            required: { type: "string", widget: "multiline", description: "Header text checked against new source files." },
            paths: { type: "array", items: { type: "string", widget: "glob" }, description: "Globs this applies to." },
          },
        },

        pre_merge_checks: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: checkSection,
            description: checkSection,
            custom_checks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "mode", "instructions"],
                properties: {
                  name: { type: "string" },
                  mode: { type: "string", enum: CHECK_MODE_ENUM },
                  instructions: { type: "string", widget: "multiline" },
                },
              },
            },
          },
        },
      },
    },

    chat: {
      type: "object",
      additionalProperties: false,
      properties: {
        auto_reply: { type: "boolean", description: "Reply to @bot mentions on PRs." },
      },
    },

    issues: {
      type: "object",
      additionalProperties: false,
      properties: {
        auto_summary: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean", description: "Summarize new issues when opened." },
            on_edit: { type: "boolean", description: "Re-summarize when the issue body is edited." },
          },
        },
        chat: {
          type: "object",
          additionalProperties: false,
          properties: {
            auto_reply: { type: "boolean", description: "Reply to @bot mentions on issues." },
          },
        },
      },
    },
  },
};

// ─── Validator ──────────────────────────────────────────────────────────────

export interface ConfigValidationError {
  /** Dotted path to the offending value, e.g. "reviews.profile" or "reviews.anti_patterns[0].pattern". */
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: NonNullable<JsonSchema["type"]>): boolean {
  switch (type) {
    case "object":
      return typeOf(value) === "object";
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
  }
}

function walk(value: unknown, schema: JsonSchema, path: string, errors: ConfigValidationError[]): void {
  // Null/undefined means "not set" — every property is optional unless listed
  // in a parent's `required`, which is checked at the object level below.
  if (value === undefined || value === null) return;

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push({ path: path || "(root)", message: `expected ${schema.type}, got ${typeOf(value)}` });
    return; // further checks assume the type matched
  }

  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push({ path: path || "(root)", message: `must be one of: ${schema.enum.join(", ")}` });
  }

  if (schema.type === "integer" || schema.type === "number") {
    if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
      errors.push({ path: path || "(root)", message: `must be >= ${schema.minimum}` });
    }
  }

  if (schema.type === "object" && typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined || obj[req] === null) {
        errors.push({ path: path ? `${path}.${req}` : req, message: "is required" });
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      const childPath = path ? `${path}.${key}` : key;
      const childSchema = props[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          errors.push({ path: childPath, message: "unknown option" });
        }
        continue;
      }
      walk(child, childSchema, childPath, errors);
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => walk(item, schema.items as JsonSchema, `${path}[${i}]`, errors));
  }
}

/**
 * Structurally validate a parsed .diffsentry.yaml object against the schema.
 * Returns an empty array when the config is valid. Does not mutate the input.
 */
export function validateRepoConfig(value: unknown): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];
  if (typeOf(value) !== "object") {
    return [{ path: "(root)", message: `expected a YAML mapping, got ${typeOf(value)}` }];
  }
  walk(value, REPO_CONFIG_SCHEMA, "", errors);
  return errors;
}
