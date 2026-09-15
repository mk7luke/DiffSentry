import { describe, it, expect } from "vitest";
import {
  classifySurface,
  selectForSpread,
  scrubSecrets,
  renderCorpusMarkdown,
  type CapturedComment,
  type Candidate,
} from "../../src/parity/corpus.js";

function c(over: Partial<CapturedComment>): CapturedComment {
  return { kind: "issue", body: "", author: "coderabbitai[bot]", createdAt: "2026-09-01T00:00:00Z", url: "u", ...over };
}

describe("classifySurface", () => {
  // Fixtures below are copied verbatim from tests/e2e/reference/2026-09/*/raw.json
  // (captured 2026-09-15). The original fixture for the status branch was
  // invented and matched no real bot output, which is how a regex anchored
  // to the wrong shape shipped green — see task-5-report.md fix round 2.

  it("identifies a walkthrough by its heading", () => {
    const body = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- review_stack_entry_start -->\n\n<a href=\"https://app.coderabbit.ai/change-stack/LerianStudio/helm/pull/2124#gh-light-mode-only\"><img src=\"https://storage.googleapis.com/coderabbit_public_assets/review-stack-in-coderabbit-ui.svg\" alt=\"Review Change Stack\" width=\"202\" height=\"32\"></a><a href=\"https://app.coderabbit.ai/change-stack/LerianStudio/helm/pull/2124#gh-dark-mode-only\"><img src=\"https://storage.googleapis.com/coderabbit_public_assets/review-stack-in-coderabbit-ui-dark.svg\" alt=\"Review Change Stack\" width=\"202\" height=\"32\"></a>\n\n<!-- review_stack_entry_end -->\n<!-- walkthrough_start -->\n\n<details>\n<summary>📝 Walkthrough</summary>\n\n## Walkthrough\n\nThe Reporter chart now supports an optional reserved CRM datasource. It validates CRM configuration and chart-managed secrets, supports externally managed Secrets, documents the required values, and adds Helm rendering regression tests.\n\n### Changes\n\n**Reporter CRM datasource**\n\n|Layer / File(s)|Summary|\n|---|---|\n|**CRM configuration contract and validation** <br> `charts/reporter/templates/_helpers.tpl`, `charts/reporter/values.yaml`, `charts/reporter/values-template.yaml`, `charts/reporter/README.md`|The chart detects CRM declarations, validates required datasource fields and reserved values, rejects sensitive ConfigMap entries, and documents the configuration and secret requirements.|\n|**CRM secret validation in components** <br> `charts/reporter/templates/manager/secrets.yaml`, `charts/reporter/templates/worker/secrets.yaml`, `charts/reporter/templates/_helpers.tpl`|Manager and worker Secret rendering validates required chart-managed CRM secrets while leaving externally managed Secret configurations outside that validation.|\n|**CRM rendering regression coverage** <br> `charts/reporter/tests/test_crm_config.py`|Tests cover absent, incomplete, misplaced-secret, chart-managed Secret, and externally managed Secret configurations, including rendered manifest contents and references.|\n\n### Sequence Diagram(s)\n\n```mermaid\nsequenceDiagram\n  participant HelmValues\n  participant ReporterTemplates\n  participant KubernetesManifests\n  participant RegressionTest\n  HelmValues->>ReporterTemplates: provide CRM configuration\n  ReporterTemplates->>ReporterTemplates: validate datasource and secrets\n  ReporterTemplates->>KubernetesManifests: render ConfigMaps and Secrets\n  RegressionTest->>ReporterTemplates: render test cases\n  ReporterTemplates-->>RegressionTest: return success or validation error\n```\n\n</details>\n\n<!-- walkthrough_end -->\n<!-- change_assessment_start -->\n**Priority:** ⬇️ Low\n\n<!-- change_assessment_commit:\"e7ae3b952cf66b0de35b6625bee7849cf7da9c1c\" -->\n\n<!-- change_assessment_end -->\n<!-- final_review_risk_start -->\n**Merge Risk:** _🔵 Low_ · up to `e7ae3`\n<!-- final_review_risk_coverage:{\"sourceCommitId\":\"e7ae3b952cf66b0de35b6625bee7849cf7da9c1c\",\"coveredCommitId\":\"e7ae3b952cf66b0de35b6625bee7849cf7da9c1c\",\"kind\":\"reviewed\"} -->\n\nChart-managed CRM deployments lack regression coverage for missing required Secret values. Add the focused failing render case before merge to protect the new validation contract.\n<!-- final_review_risk_end -->\n<!-- finishing_touch_checkbox_start -->\n\n<details>\n<summary>✨ Finishing Touches</summary>\n\n<details>\n<summary>✨ Simplify code</summary>\n\n- [ ] <!-- {\"checkboxId\": \"f120d606-b0e2-4b7d-8316-181794555b43\", \"radioGroupId\": \"simplify-output-choice-group-5685845119\"} -->   Create PR with simplified code\n- [ ] <!-- {\"checkboxId\": \"9a4e3077-58f6-4eba-b7ee-62e936ea00ea\", \"radioGroupId\": \"simplify-output-choice-group-5685845119\"} -->   Commit simplified code in branch `fix/reporter-crm-config`\n\n</details>\n\n</details>\n\n<!-- finishing_touch_checkbox_end -->\n### Usage-based review receipt\n\n- Mode: Continue automatically\n- Reviewed files: 7\n- Charged: $1.75\n- [View usage details](https://app.coderabbit.ai/settings/billing?tab=usage&orgId=2f937319-62d6-41df-a399-defafae944f5)\n\n> [!NOTE]\n> This review was completed with usage-based billing: files reviewed beyond your plan's included limits are billed at $0.25/file. [View usage-based billing](https://app.coderabbit.ai/settings/billing?tab=usage&orgId=2f937319-62d6-41df-a399-defafae944f5).\n<!-- tips_start -->\n\n---\n\n\n\n\n<sub>Comment `@coderabbitai help` to get the list of available commands.</sub>\n\n<!-- tips_end -->";
    expect(classifySurface(c({ body }))).toBe("walkthrough");
  });

  it("identifies a review summary by the actionable-comments wrapper", () => {
    expect(classifySurface(c({ kind: "review", body: "**Actionable comments posted: 3**" }))).toBe("review-summary");
  });

  it("identifies any inline-kind comment as inline", () => {
    expect(classifySurface(c({ kind: "inline", body: "_:warning: Potential issue_", path: "a.ts", line: 4 }))).toBe("inline");
  });

  it("identifies a DiffSentry status comment by its plain marker", () => {
    const body = "<!-- DiffSentry Status -->\n> :eyes: **DiffSentry** is reviewing this update... hang tight.";
    expect(classifySurface(c({ author: "diffsentry[bot]", body }))).toBe("status");
  });

  it("identifies a DiffSentry status comment by its sticky-status marker", () => {
    const body = "<!-- DiffSentry Sticky Status -->\n\n# 📌 Status — last updated [`94e9faf`](https://github.com/mk7luke/DiffSentry/commit/94e9fafc8114ac0f87d33fcb234cdbbf11157883)\n\n🟢 **Approved**\n\n| | |\n|---|---|\n| **Risk score** | 0/100 (Low) ▁ |\n| **Unresolved threads** | 0 |\n| **Failing checks** | 0 |\n| **Pending checks** | 1 |\n| **Files reviewed** | 1 |\n| **Updated** | <code>2026-09-14 21:39Z</code> |\n\n<sub>Live-updated by DiffSentry on every push. Use `@diffsentry ship` for a verdict, `@diffsentry timeline` for full history.</sub>";
    expect(classifySurface(c({ author: "diffsentry[bot]", body }))).toBe("status");
  });

  it("prefers review-summary over status when a DiffSentry review-summary carries the review-status marker", () => {
    // Precedence case: this body has BOTH the actionable-comments wrapper
    // AND a trailing "<!-- ... for review status -->" marker, because
    // DiffSentry edits its in-progress comment in place as the review
    // completes. It must classify by its final shape (review-summary), not
    // by the marker it was born with.
    const body = "**Actionable comments posted: 0**\n\nThis Dependabot update correctly advances `trufflesecurity/trufflehog` from v3.97.0 to v3.97.1 and updates the immutable commit SHA consistently with the version comment. The workflow remains pinned to a full commit digest, preserving supply-chain integrity. No issues found.\n\n---\n\n<details>\n<summary>ℹ️ Review info</summary>\n\n<details>\n<summary>⚙️ Run configuration</summary>\n\n**Configuration used**: `.diffsentry.yaml`\n\n**Review profile**: ASSERTIVE\n\n**Run ID**: `6ea2900c-5704-4691-b885-5bbe01b6d8a7`\n\n</details>\n\n<details>\n<summary>📥 Commits</summary>\n\nReviewing files at [`874649b`](https://github.com/mk7luke/DiffSentry/commit/874649b178ea46f43fb0bcc6891934a176f3f572) (base SHA unavailable).\n\n</details>\n\n<details>\n<summary>📒 Files selected for processing (1)</summary>\n\n* `.github/workflows/secret-scan.yml`\n\n</details>\n\n</details>\n\n<!-- This is an auto-generated comment by DiffSentry for review status -->";
    expect(classifySurface(c({ author: "diffsentry[bot]", body }))).toBe("review-summary");
  });

  it("prefers review-summary over status when a CodeRabbit review-summary carries the review-status marker", () => {
    // Same precedence rule, CodeRabbit's shape: no real captured CodeRabbit
    // comment combines a "## Walkthrough" heading with the status marker
    // (its walkthrough comment does not retain that marker in this corpus),
    // but its review-summary comment does — this is the real, observed
    // collision the precedence rule exists for on this bot.
    const body = "**Actionable comments posted: 1**\n\n---\n\n<details>\n<summary>ℹ️ Review info</summary>\n\n<details>\n<summary>⚙️ Run configuration</summary>\n\n**Configuration used**: Path: .coderabbit.yaml\n\n**Review profile**: ASSERTIVE\n\n**Plan**: Team\n\n**Run ID**: `cee80118-f13d-40d1-9937-5d962c1f3bf1`\n\n</details>\n\n<details>\n<summary>📥 Commits</summary>\n\nReviewing files that changed from the base of the PR and between fb73b185c68ddc387509fe5a666f225b222100bf and 3ccd66f6f1460e16749e7c9b0f50f48bad53f8e5.\n\n</details>\n\n<details>\n<summary>📒 Files selected for processing (22)</summary>\n\n* `.github/workflows/clang-nightly.yaml`\n* `docs/dev/testing.md`\n* `ent/encryption/encryption.cc`\n* `install-dependencies.sh`\n* `test/boost/aws_error_injection_test.cc`\n* `test/boost/s3_test.cc`\n* `test/cluster/object_store/conftest.py`\n* `test/cluster/object_store/test_backup.py`\n* `test/cluster/object_store/test_basic.py`\n* `test/cluster/test_refresh.py`\n* `test/cqlpy/conftest.py`\n* `test/cqlpy/run`\n* `test/lib/aws_kms_fixture.hh`\n* `test/lib/test_utils.cc`\n* `test/pylib/dockerized_service.py`\n* `test/pylib/minio_server.py`\n* `test/pylib/object_storage.py`\n* `test/pylib/runner.py`\n* `test/pylib/s3_proxy.py`\n* `test/pylib/s3mock_server.py`\n* `test/pylib/start_s3_proxy.py`\n* `utils/s3/client.cc`\n\n</details>\n\n<details>\n<summary>💤 Files with no reviewable changes (4)</summary>\n\n* .github/workflows/clang-nightly.yaml\n* test/pylib/minio_server.py\n* test/cluster/test_refresh.py\n* install-dependencies.sh\n\n</details>\n\n**Included review availability:** Your plan provides up to 10 included reviews per hour; 9 remain after this review.\n\n</details>\n\n<!-- This is an auto-generated comment by CodeRabbit for review status -->";
    expect(classifySurface(c({ body }))).toBe("review-summary");
  });

  it("treats a bot reply that is none of the above as chat", () => {
    expect(classifySurface(c({ body: "@someone Good question — the reason is..." }))).toBe("chat");
  });

  it("classifies a human comment as other", () => {
    expect(classifySurface(c({ body: "lgtm", author: "octocat" }))).toBe("other");
  });
});

function cand(repo: string, number: number, language: string | null): Candidate {
  return { repo, number, title: `pr ${number}`, language, updatedAt: "2026-09-01T00:00:00Z" };
}

describe("selectForSpread", () => {
  it("caps how many PRs any single repo contributes", () => {
    const out = selectForSpread(
      [cand("a/a", 1, "TS"), cand("a/a", 2, "TS"), cand("a/a", 3, "TS"), cand("b/b", 4, "Go")],
      { limit: 10, maxPerRepo: 2 },
    );
    expect(out.filter((c) => c.repo === "a/a")).toHaveLength(2);
    expect(out.map((c) => c.repo)).toContain("b/b");
  });

  it("prefers an unseen language over a second PR in a seen one", () => {
    const out = selectForSpread(
      [cand("a/a", 1, "TS"), cand("b/b", 2, "TS"), cand("c/c", 3, "Python")],
      { limit: 2, maxPerRepo: 1 },
    );
    expect(out.map((c) => c.language)).toEqual(["TS", "Python"]);
  });

  it("honours the overall limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => cand(`r${i}/r`, i, `L${i}`));
    expect(selectForSpread(many, { limit: 5, maxPerRepo: 1 })).toHaveLength(5);
  });

  it("returns an empty array for no candidates", () => {
    expect(selectForSpread([], { limit: 5, maxPerRepo: 2 })).toEqual([]);
  });
});

describe("scrubSecrets", () => {
  it("redacts a GitHub token", () => {
    expect(scrubSecrets("use ghp_" + "a".repeat(36) + " here")).toBe("use [REDACTED] here");
  });

  it("redacts an AWS access key id", () => {
    expect(scrubSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]");
  });

  it("redacts a private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(pem)).toBe("[REDACTED]");
  });

  it("leaves ordinary prose untouched", () => {
    expect(scrubSecrets("This adds a token bucket rate limiter.")).toBe("This adds a token bucket rate limiter.");
  });
});

describe("renderCorpusMarkdown", () => {
  it("emits one section per comment with provenance and scrubbed body", () => {
    const out = renderCorpusMarkdown("Walkthroughs", [
      { kind: "issue", body: "## Walkthrough\nghp_" + "b".repeat(36), author: "coderabbitai[bot]", createdAt: "2026-09-01T00:00:00Z", url: "https://x/1" },
    ]);
    expect(out).toContain("# Walkthroughs");
    expect(out).toContain("https://x/1");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ghp_");
  });

  it("says so explicitly when nothing was captured", () => {
    expect(renderCorpusMarkdown("Empty", [])).toContain("_No comments captured._");
  });
});
