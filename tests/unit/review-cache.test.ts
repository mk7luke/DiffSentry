import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { reviewCacheKey, primaryModelId } from "../../src/ai/review-cache.js";
import { normalizePatchForHash } from "../../src/reviewer.js";
import type { Config } from "../../src/types.js";

function digest(filename: string, patch: string): string {
  return createHash("sha256").update(normalizePatchForHash(filename, patch)).digest("hex").slice(0, 16);
}

const PATCH_AT_LINE_10 = `@@ -10,3 +10,4 @@ function f() {
   const a = 1;
+  const b = 2;
   return a;`;

// Byte-for-byte the same change, rebased onto a base where the function moved.
const PATCH_AT_LINE_84 = `@@ -84,3 +84,4 @@ function f() {
   const a = 1;
+  const b = 2;
   return a;`;

function keyFor(patch: string, opts: { system?: string; title?: string } = {}): string {
  const system = opts.system ?? "SYSTEM PROMPT";
  const user = `Title: ${opts.title ?? "Add b"}\n\n### src/f.ts\n\`\`\`diff\n${patch}\n\`\`\`\n`;
  return reviewCacheKey({
    model: "anthropic:claude-x",
    system,
    user,
    patches: [{ text: patch, digest: digest("src/f.ts", patch) }],
  });
}

describe("review cache key", () => {
  // The whole point: a rebase rewrites every hunk header without changing a
  // line of code, and that is the most common reason a diff is reviewed twice.
  it("survives a rebase that only moves line numbers", () => {
    expect(keyFor(PATCH_AT_LINE_10)).toBe(keyFor(PATCH_AT_LINE_84));
  });

  it("changes when the code changes", () => {
    const edited = PATCH_AT_LINE_10.replace("const b = 2;", "const b = 3;");
    expect(keyFor(edited)).not.toBe(keyFor(PATCH_AT_LINE_10));
  });

  // The system prompt carries the profile and the review instructions, so a
  // future edit to either must invalidate every row without this module
  // knowing it happened.
  it("changes when the system prompt changes", () => {
    expect(keyFor(PATCH_AT_LINE_10, { system: "SYSTEM PROMPT v2" })).not.toBe(keyFor(PATCH_AT_LINE_10));
  });

  // Anything else the user prompt carries — title, description, learnings,
  // related context — is hashed verbatim.
  it("changes when the rest of the prompt changes", () => {
    expect(keyFor(PATCH_AT_LINE_10, { title: "Add c" })).not.toBe(keyFor(PATCH_AT_LINE_10));
  });

  it("changes when the model changes", () => {
    const args = { system: "s", user: "u", patches: [] };
    expect(reviewCacheKey({ ...args, model: "a:1" })).not.toBe(reviewCacheKey({ ...args, model: "a:2" }));
  });

  it("names the primary provider's model", () => {
    const base = { anthropicModel: "claude-x", openaiModel: "gpt-x", localAiModel: "llama-x" } as Config;
    expect(primaryModelId({ ...base, aiProvider: "anthropic" })).toBe("anthropic:claude-x");
    expect(primaryModelId({ ...base, aiProvider: "openai" })).toBe("openai:gpt-x");
    expect(primaryModelId({ ...base, aiProvider: "openai-compatible" })).toBe("openai-compatible:llama-x");
  });
});
