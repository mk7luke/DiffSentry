import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Persistence off before the reviewer's storage import chain runs.
const ORIGINAL_DB_PATH = process.env.DB_PATH;
process.env.DB_PATH = "";

import { Reviewer } from "../../src/reviewer.js";
import { AUTO_RELEASE_NOTES_MARKER, headMarker } from "../../src/auto-release-notes.js";
import type { Config } from "../../src/types.js";

afterAll(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98";

/**
 * The reviewer only needs enough config to construct. Every GitHub and model
 * call is replaced below, so nothing here reaches the network.
 */
const CONFIG = {
  botName: "diffsentry",
  aiProvider: "anthropic",
  anthropicApiKey: "test-key",
  anthropicModel: "test-model",
  openaiModel: "",
  localAiModel: "",
  localAiJsonMode: true,
  aiRequestTimeoutMs: 1000,
  primaryAiTimeoutMs: 1000,
  learningsDir: "/tmp/diffsentry-test-learnings",
  slashCommands: true,
  bareSlashCommands: true,
} as unknown as Config;

interface Harness {
  reviewer: Reviewer;
  posted: { body: string; marker: string }[];
  chatCalls: number;
  /** Resolves the in-flight model call, so overlapping deliveries can be staged. */
  releaseChat: () => void;
}

function makeHarness(opts: {
  /** `.diffsentry.yaml` on the default branch. */
  yaml?: string;
  /** Body of an existing automatic release-notes comment, if any. */
  existingComment?: string;
  checkRuns?: { name: string; status: string; conclusion: string | null }[];
  statuses?: { context: string; state: string }[];
  /** Head the PR actually has now, if it has moved on from the checked SHA. */
  currentHead?: string;
  /** Hold the model call open until `releaseChat` is called. */
  gateChat?: boolean;
} = {}): Harness {
  const reviewer = new Reviewer(CONFIG);
  const posted: { body: string; marker: string }[] = [];
  const harness = { reviewer, posted, chatCalls: 0 } as Harness;

  let release = () => {};
  harness.releaseChat = () => release();
  const gate = opts.gateChat ? new Promise<void>((r) => { release = r; }) : Promise.resolve();

  const yamlText = opts.yaml ?? "release_notes:\n  auto: true\n";

  const github = {
    findOpenPRsForHeadSha: async () => [7],
    getInstallationOctokit: async () => ({
      repos: {
        getContent: async () => ({
          data: { type: "file", content: Buffer.from(yamlText, "utf-8").toString("base64") },
        }),
      },
    }),
    findCommentByMarker: async () =>
      opts.existingComment ? { id: 1, body: opts.existingComment } : null,
    getCheckSignals: async () => ({
      statuses: opts.statuses ?? [],
      checkRuns: opts.checkRuns ?? [{ name: "build", status: "completed", conclusion: "success" }],
    }),
    getPRContext: async () => ({
      owner: "acme", repo: "app", pullNumber: 7,
      title: "t", description: "d",
      baseBranch: "main", headBranch: "feat", headSha: opts.currentHead ?? SHA,
      defaultBranch: "main", files: [],
    }),
    upsertComment: async (
      _i: number, _o: string, _r: string, _n: number, body: string, marker: string,
    ) => { posted.push({ body, marker }); },
  };

  const ai = {
    chat: async () => {
      harness.chatCalls++;
      await gate;
      return "### Bug fixes\n- Fixed a case where the flag was ignored.";
    },
  };

  (reviewer as unknown as { github: unknown }).github = github;
  (reviewer as unknown as { ai: unknown }).ai = ai;
  return harness;
}

const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  // The in-flight guard is module state, so a leaked key would silently make
  // the next test's first delivery a no-op. Each test uses a distinct SHA or
  // runs to completion, which clears it in the reviewer's finally block.
});

describe("automatic release notes", () => {
  it("posts once when every check has passed", async () => {
    const h = makeHarness();
    await h.reviewer.handleChecksCompleted(1, "acme", "app", SHA);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].marker).toBe(AUTO_RELEASE_NOTES_MARKER);
    expect(h.posted[0].body).toContain(headMarker(SHA));
    expect(h.posted[0].body).toContain("# Release Notes");
  });

  it("posts exactly once when several suites finish while the model is still working", async () => {
    // The main correctness risk. Three suites complete seconds apart, each one
    // satisfying "everything is green", while the first delivery is still
    // waiting on the model and has posted nothing for the others to find.
    const h = makeHarness({ gateChat: true });
    const deliveries = [
      h.reviewer.handleChecksCompleted(1, "acme", "app", SHA),
      h.reviewer.handleChecksCompleted(1, "acme", "app", SHA),
      h.reviewer.handleChecksCompleted(1, "acme", "app", SHA),
    ];
    await settle();
    h.releaseChat();
    await Promise.all(deliveries);

    expect(h.chatCalls).toBe(1);
    expect(h.posted).toHaveLength(1);
  });

  it("does nothing when notes for this commit are already posted", async () => {
    // The durable half of the guard: survives a restart, a redelivery hours
    // later, and a replayed webhook.
    const h = makeHarness({ existingComment: `${AUTO_RELEASE_NOTES_MARKER}\n${headMarker(SHA)}\n\n# Release Notes` });
    await h.reviewer.handleChecksCompleted(1, "acme", "app", SHA);
    expect(h.chatCalls).toBe(0);
    expect(h.posted).toEqual([]);
  });

  it("rewrites the existing comment when the PR has a new head", async () => {
    // A fresh commit is a fresh set of notes, but a long-lived branch must not
    // collect one comment per push.
    const h = makeHarness({ existingComment: `${AUTO_RELEASE_NOTES_MARKER}\n${headMarker(OLD_SHA)}\n\n# Release Notes` });
    await h.reviewer.handleChecksCompleted(1, "acme", "app", SHA);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].marker).toBe(AUTO_RELEASE_NOTES_MARKER);
    expect(h.posted[0].body).toContain(headMarker(SHA));
  });

  it("stays silent unless the repo opted in", async () => {
    for (const yaml of ["# no settings at all\n", "reviews:\n  profile: chill\n", "release_notes:\n  auto: false\n"]) {
      const h = makeHarness({ yaml });
      await h.reviewer.handleChecksCompleted(1, "acme", "app", SHA);
      expect(h.posted).toEqual([]);
      expect(h.chatCalls).toBe(0);
    }
  });

  it("holds while a check is still running, and after one has failed", async () => {
    const pending = makeHarness({ checkRuns: [{ name: "e2e", status: "in_progress", conclusion: null }] });
    await pending.reviewer.handleChecksCompleted(1, "acme", "app", SHA);
    expect(pending.posted).toEqual([]);

    const failed = makeHarness({ checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }] });
    await failed.reviewer.handleChecksCompleted(1, "acme", "app", SHA);
    expect(failed.posted).toEqual([]);
  });

  it("posts even while DiffSentry's own check is red", async () => {
    const h = makeHarness({ statuses: [{ context: "DiffSentry", state: "failure" }] });
    await h.reviewer.handleChecksCompleted(1, "acme", "app", SHA);
    expect(h.posted).toHaveLength(1);
  });

  it("stays silent on a repo with no CI at all", async () => {
    const h = makeHarness({ checkRuns: [], statuses: [] });
    await h.reviewer.handleChecksCompleted(1, "acme", "app", SHA);
    expect(h.posted).toEqual([]);
  });

  it("skips when a push landed while the checks were running", async () => {
    // Those green checks describe a commit that is no longer the PR. The new
    // head's own suites will report in a moment.
    const h = makeHarness({ currentHead: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee" });
    await h.reviewer.handleChecksCompleted(1, "acme", "app", SHA);
    expect(h.posted).toEqual([]);
  });
});
