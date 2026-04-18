import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { shx } from "./sh.js";
import { SANDBOX_REPO } from "./gh.js";
import type { FileChange } from "./types.js";

const WORK_ROOT = path.resolve(process.cwd(), "tests/e2e/.work");

export async function pushScenarioBranch(opts: {
  scenarioName: string;
  branch: string;
  files: FileChange[];
  commitMessage: string;
}): Promise<void> {
  const workDir = path.join(WORK_ROOT, opts.scenarioName);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const repoUrl = `https://github.com/${SANDBOX_REPO}.git`;
  await shx("git", ["clone", "--depth", "1", repoUrl, workDir]);
  await shx("git", ["-C", workDir, "checkout", "-b", opts.branch]);
  await shx("git", ["-C", workDir, "config", "user.email", "diffsentry-e2e@interactep.com"]);
  await shx("git", ["-C", workDir, "config", "user.name", "DiffSentry e2e"]);

  for (const f of opts.files) {
    const fullPath = path.join(workDir, f.path);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, f.content);
  }

  await shx("git", ["-C", workDir, "add", "-A"]);
  await shx("git", ["-C", workDir, "commit", "-m", opts.commitMessage]);
  await shx("git", ["-C", workDir, "push", "-u", "origin", opts.branch]);
}
