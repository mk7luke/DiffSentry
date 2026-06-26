/**
 * Interactive first-run setup.
 *
 *   npm run setup            # writes ./.env
 *   npm run setup -- --out /tmp/x.env --force
 *
 * Walks the operator through the minimal required configuration and writes a
 * valid `.env`. The AI provider is validated against the canonical enum in
 * src/config.ts (the same list the runtime loader and diagnostics use), so a
 * typo like "claude" is rejected at setup time instead of silently breaking the
 * app at boot.
 *
 * Flags:
 *   --out <path>   destination file (default ./.env)
 *   --force        overwrite an existing destination without prompting
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  AI_PROVIDERS,
  isAiProvider,
  type AiProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "../src/config.js";

interface CliArgs {
  out: string;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { out: path.resolve(process.cwd(), ".env"), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = path.resolve(process.cwd(), argv[++i] ?? ".env");
    else if (a === "--force") out.force = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: setup.ts [--out <path>] [--force]");
      process.exit(0);
    }
  }
  return out;
}

/** Quote a value for .env only when it contains characters dotenv would mishandle. */
function envValue(raw: string): string {
  if (raw === "") return "";
  return /[\s#"'$]/.test(raw) ? `"${raw.replace(/"/g, '\\"')}"` : raw;
}

/** Read all of stdin to EOF (used for non-interactive / piped invocations). */
function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => (data += chunk));
    stdin.on("end", () => resolve(data));
    stdin.on("error", () => resolve(data));
  });
}

interface Asker {
  question(prompt: string): Promise<string>;
  close(): void;
}

/**
 * A real TTY drives the readline prompt interactively. A piped/redirected stdin
 * (CI, `printf ... | npm run setup`) is consumed up front and answered line by
 * line — otherwise readline's EOF races ahead of the buffered answers and aborts
 * mid-questionnaire. Exhausted queue → empty answers, so defaults still apply.
 */
async function makeAsker(): Promise<Asker> {
  if (stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    return { question: (p) => rl.question(p), close: () => rl.close() };
  }
  const raw = await readAllStdin();
  const queue = raw.split("\n");
  if (queue.length && queue[queue.length - 1] === "") queue.pop(); // drop trailing newline
  return {
    question: (p) => {
      const line = queue.shift() ?? "";
      stdout.write(`${p}${line}\n`);
      return Promise.resolve(line);
    },
    close: () => {},
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rl = await makeAsker();

  async function ask(question: string, fallback = ""): Promise<string> {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback;
  }

  async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
    const def = fallback ? "Y/n" : "y/N";
    const answer = (await rl.question(`${question} [${def}]: `)).trim().toLowerCase();
    if (!answer) return fallback;
    return answer === "y" || answer === "yes";
  }

  try {
    if (fs.existsSync(args.out) && !args.force) {
      const overwrite = await askYesNo(`${path.relative(process.cwd(), args.out)} already exists. Overwrite?`, false);
      if (!overwrite) {
        console.log("Aborted — existing file left untouched.");
        rl.close();
        return;
      }
    }

    console.log("\nDiffSentry setup — answer a few questions to write a .env.\n");

    // ── GitHub App ──────────────────────────────────────────────────
    console.log("GitHub App (from your App's settings page):");
    const githubAppId = await ask("  App ID");
    const githubPrivateKeyPath = await ask("  Private key (.pem) path", "./private-key.pem");
    const githubWebhookSecret = await ask("  Webhook secret");

    // ── AI provider (validated against the canonical enum) ──────────
    console.log(`\nAI provider — one of: ${AI_PROVIDERS.join(", ")}`);
    let aiProvider: AiProvider | undefined;
    while (!aiProvider) {
      const raw = await ask("  AI_PROVIDER", "anthropic");
      if (isAiProvider(raw)) {
        aiProvider = raw;
      } else {
        console.log(`  ✗ "${raw}" is not a valid provider. Choose one of: ${AI_PROVIDERS.join(", ")}.`);
      }
    }

    const lines: string[] = [
      "# === GitHub App ===",
      `GITHUB_APP_ID=${envValue(githubAppId)}`,
      `GITHUB_PRIVATE_KEY_PATH=${envValue(githubPrivateKeyPath)}`,
      `GITHUB_WEBHOOK_SECRET=${envValue(githubWebhookSecret)}`,
      "",
      "# === AI Provider ===",
      `AI_PROVIDER=${aiProvider}`,
    ];

    if (aiProvider === "anthropic") {
      const key = await ask("  ANTHROPIC_API_KEY");
      const model = await ask("  ANTHROPIC_MODEL", DEFAULT_ANTHROPIC_MODEL);
      lines.push(`ANTHROPIC_API_KEY=${envValue(key)}`, `ANTHROPIC_MODEL=${envValue(model)}`);
    } else if (aiProvider === "openai") {
      const key = await ask("  OPENAI_API_KEY");
      const model = await ask("  OPENAI_MODEL", DEFAULT_OPENAI_MODEL);
      lines.push(`OPENAI_API_KEY=${envValue(key)}`, `OPENAI_MODEL=${envValue(model)}`);
    } else {
      // openai-compatible (Ollama, LM Studio, vLLM, ...)
      const baseUrl = await ask("  LOCAL_AI_BASE_URL", "http://localhost:11434/v1");
      const model = await ask("  LOCAL_AI_MODEL", "llama3.1:70b");
      const key = await ask("  LOCAL_AI_API_KEY (optional, blank for most local servers)");
      lines.push(`LOCAL_AI_BASE_URL=${envValue(baseUrl)}`, `LOCAL_AI_MODEL=${envValue(model)}`);
      if (key) lines.push(`LOCAL_AI_API_KEY=${envValue(key)}`);
    }

    // ── Server + dashboard ──────────────────────────────────────────
    const port = await ask("\nServer port", "3005");
    lines.push("", "# === Server ===", `PORT=${envValue(port)}`);

    const enableDashboard = await askYesNo("\nEnable the web dashboard?", false);
    lines.push("", "# === Web Dashboard ===");
    if (enableDashboard) {
      lines.push(
        "ENABLE_DASHBOARD=1",
        "# Dashboard runs in OPEN mode (no auth) until you set OAuth + an allowlist.",
        "# See docs/DEPLOYMENT.md and .env.example for GITHUB_OAUTH_CLIENT_ID,",
        "# GITHUB_OAUTH_CLIENT_SECRET, DASHBOARD_URL, and DASHBOARD_ALLOWED_* vars.",
      );
    } else {
      lines.push("# ENABLE_DASHBOARD=1");
    }

    const content = lines.join("\n") + "\n";
    fs.writeFileSync(args.out, content, { mode: 0o600 });

    // ── Self-check: confirm the file we just wrote is structurally valid. ──
    const problems = validateEnvContent(content);
    if (problems.length) {
      console.error("\n✗ Wrote .env but it is missing required values:");
      for (const p of problems) console.error(`  - ${p}`);
      rl.close();
      process.exit(1);
    }

    console.log(`\n✓ Wrote ${path.relative(process.cwd(), args.out)} (AI_PROVIDER=${aiProvider}).`);
    console.log("Next: docker compose up -d   (or npm run build && npm start)");
    rl.close();
  } catch (err) {
    rl.close();
    throw err;
  }
}

/**
 * Re-parse the written content and confirm every required key is present and
 * non-empty for the chosen provider. Returns a list of problems ([] = valid).
 * This is the same contract the runtime `loadConfig()` enforces, checked here
 * without needing the .pem file or live credentials to exist yet.
 */
export function validateEnvContent(content: string): string[] {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1").trim();
  }
  const problems: string[] = [];
  const required = (k: string) => {
    if (!env[k]) problems.push(`${k} is required but empty`);
  };

  required("GITHUB_APP_ID");
  if (!env.GITHUB_PRIVATE_KEY_PATH && !env.GITHUB_PRIVATE_KEY) {
    problems.push("GITHUB_PRIVATE_KEY_PATH (or GITHUB_PRIVATE_KEY) is required");
  }
  required("GITHUB_WEBHOOK_SECRET");

  const provider = env.AI_PROVIDER ?? "";
  if (!isAiProvider(provider)) {
    problems.push(`AI_PROVIDER must be one of: ${AI_PROVIDERS.join(", ")} (got "${provider}")`);
  } else if (provider === "anthropic") {
    required("ANTHROPIC_API_KEY");
  } else if (provider === "openai") {
    required("OPENAI_API_KEY");
  } else if (provider === "openai-compatible") {
    required("LOCAL_AI_BASE_URL");
    required("LOCAL_AI_MODEL");
  }
  return problems;
}

// Run only as the CLI entrypoint, so the validator above can be imported by
// tests without launching the interactive prompts.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
