import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Minimal, non-bikeshed lint baseline: the typescript-eslint *recommended*
// (non-type-checked) ruleset. Intentionally not the type-aware tier — it's
// slower and far noisier on an existing codebase. CI runs this non-blocking
// (continue-on-error) for now, so the team can adopt it incrementally rather
// than being walled off by red on day one.
export default tseslint.config(
  {
    ignores: ["dist/**", "web/**", "node_modules/**", "coverage/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Pragmatic relaxations so the first run is signal, not noise. Tighten
      // these as the codebase is cleaned up.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
);
