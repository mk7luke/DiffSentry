import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { minimatch } from "minimatch";
import { Learning } from "./types.js";

export class LearningsStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private filePath(repo: string): string {
    // repo is "owner/name" → store as {baseDir}/owner/name.json
    const [owner, name] = repo.split("/");
    return path.join(this.baseDir, owner, `${name}.json`);
  }

  async addLearning(
    repo: string,
    content: string,
    filePath?: string,
  ): Promise<Learning> {
    const learning: Learning = {
      id: crypto.randomUUID(),
      repo,
      content,
      createdAt: new Date().toISOString(),
      path: filePath,
    };

    const learnings = await this.getLearnings(repo);
    learnings.push(learning);
    await this.writeLearnings(repo, learnings);

    return learning;
  }

  async getLearnings(repo: string): Promise<Learning[]> {
    const fp = this.filePath(repo);
    try {
      const data = await fs.readFile(fp, "utf-8");
      return JSON.parse(data) as Learning[];
    } catch {
      return [];
    }
  }

  async getRelevantLearnings(
    repo: string,
    filenames: string[],
  ): Promise<Learning[]> {
    const all = await this.getLearnings(repo);

    return all.filter((learning) => {
      // Global learnings (no path) are always relevant
      if (!learning.path) return true;

      // Path-scoped learnings match if their glob matches any reviewed file
      return filenames.some((filename) =>
        minimatch(filename, learning.path!, { matchBase: true }),
      );
    });
  }

  async removeLearning(repo: string, id: string): Promise<boolean> {
    const learnings = await this.getLearnings(repo);
    const filtered = learnings.filter((l) => l.id !== id);

    if (filtered.length === learnings.length) return false;

    await this.writeLearnings(repo, filtered);
    return true;
  }

  formatForPrompt(learnings: Learning[]): string {
    if (learnings.length === 0) return "";

    const items = learnings
      .map((l, i) => `${i + 1}. ${l.content}`)
      .join("\n");

    return `## Repository Learnings\n\nThe team has provided these preferences:\n${items}`;
  }

  private async writeLearnings(
    repo: string,
    learnings: Learning[],
  ): Promise<void> {
    const fp = this.filePath(repo);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, JSON.stringify(learnings, null, 2), "utf-8");
  }
}
