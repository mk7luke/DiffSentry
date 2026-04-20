import { marked } from "marked";

// The bot's review summaries + finding bodies are GitHub-flavored markdown
// with inline <details>/<summary> blocks. Parse to HTML so the dashboard
// matches what GitHub shows instead of a wall of raw markdown.

marked.setOptions({ gfm: true, breaks: false });

const STRIP_SCRIPT = /<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi;
const STRIP_IFRAME = /<\s*iframe[\s\S]*?<\s*\/\s*iframe\s*>/gi;
const STRIP_OBJECT = /<\s*(object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi;
const STRIP_ON_HANDLER = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_HREF = /\b(href|src)\s*=\s*("|')\s*javascript:[^"']*("|')/gi;

/**
 * Render markdown to HTML. Not a bulletproof sanitizer — the dashboard is
 * operator-only and the content is authored by the bot, so we just strip
 * the obvious XSS vectors (scripts, iframes, inline event handlers,
 * javascript: URLs) and let the rest through so <details>/<summary>,
 * tables, code blocks, and GFM autolinks all render as on GitHub.
 */
export function renderMarkdown(input: string | null | undefined): string {
  if (!input) return "";
  let html: string;
  try {
    html = marked.parse(input, { async: false }) as string;
  } catch {
    // Fall back to plaintext with line breaks
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }
  return html
    .replace(STRIP_SCRIPT, "")
    .replace(STRIP_IFRAME, "")
    .replace(STRIP_OBJECT, "")
    .replace(STRIP_ON_HANDLER, "")
    .replace(JS_HREF, '$1="#"');
}
