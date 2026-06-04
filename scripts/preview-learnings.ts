/**
 * Local preview of the Learnings SPA page with seeded data. Open mode (no
 * OAuth) so the operator is admin and the write controls are visible.
 * Run: npx tsx scripts/preview-learnings.ts  → prints a URL to open.
 *
 * Requires the SPA to be built first: npm run build:web
 */
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-learnings-preview-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;

  const { openDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  openDatabase();

  const learningsDir = path.join(os.tmpdir(), `ds-learnings-preview-store-${Date.now()}`);
  fs.mkdirSync(path.join(learningsDir, "mk7luke"), { recursive: true });

  const now = Date.now();
  const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();

  fs.writeFileSync(
    path.join(learningsDir, "__global__.json"),
    JSON.stringify(
      [
        { id: "g1", repo: "*", content: "Never log secrets, tokens, or full request bodies.", createdAt: iso(20) },
        { id: "g2", repo: "*", content: "Prefer dependency injection over module-level singletons.", createdAt: iso(8) },
        { id: "g3", repo: "*", content: "All new endpoints must be covered by a smoke test.", path: "src/api/**", createdAt: iso(3) },
      ],
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(learningsDir, "mk7luke", "diffsentry-sandbox.json"),
    JSON.stringify(
      [
        { id: "r1", repo: "mk7luke/diffsentry-sandbox", content: "Prefer async/await over .then() chains in services.", path: "src/**/*.ts", createdAt: iso(14) },
        { id: "r2", repo: "mk7luke/diffsentry-sandbox", content: "Never log secrets, tokens or credentials anywhere.", createdAt: iso(6) },
        { id: "r3", repo: "mk7luke/diffsentry-sandbox", content: "Keep React components under 200 lines; split otherwise.", path: "web/src/**/*.tsx", createdAt: iso(1) },
      ],
      null,
      2,
    ),
  );

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir }));

  const webDist = path.join(process.cwd(), "web", "dist");
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  console.log(`\n  Learnings preview → http://localhost:${port}/learnings\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
