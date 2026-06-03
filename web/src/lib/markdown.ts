import { marked } from "marked";

// Mirror of src/dashboard/markdown.ts. The bot's summaries + finding bodies are
// GitHub-flavored markdown with inline <details>/<summary>; parse to HTML so the
// SPA matches GitHub. Not a bulletproof sanitizer — the dashboard is
// operator-only and content is bot-authored, so we strip the obvious XSS
// vectors and let the rest render.

marked.setOptions({ gfm: true, breaks: false });

const STRIP_SCRIPT = /<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi;
const STRIP_IFRAME = /<\s*iframe[\s\S]*?<\s*\/\s*iframe\s*>/gi;
const STRIP_OBJECT = /<\s*(object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi;
const STRIP_ON_HANDLER = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_HREF = /\b(href|src)\s*=\s*("|')\s*javascript:[^"']*("|')/gi;

export function renderMarkdown(input: string | null | undefined): string {
  if (!input) return "";
  let html: string;
  try {
    html = marked.parse(input, { async: false }) as string;
  } catch {
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
