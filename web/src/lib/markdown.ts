import { marked } from "marked";
import DOMPurify from "dompurify";

// The bot's summaries + finding bodies are GitHub-flavored markdown with inline
// <details>/<summary>; parse to HTML so the SPA matches GitHub, then run the
// result through DOMPurify before it reaches dangerouslySetInnerHTML.
//
// This mirrors the server-side sanitizer in src/dashboard/markdown.ts (which
// feeds the legacy dashboard): both are allowlist-based, so bot-authored and
// user-authored markdown get equivalent treatment on either rendering path.

marked.setOptions({ gfm: true, breaks: false });

// Allow only http/https/mailto and same-origin relative URLs in URL-bearing
// attributes (href, image src, etc.). This narrows DOMPurify's default scheme
// list (which also permits tel:, sms:, and — for image elements — data:) so
// that data:/javascript:/tel:/etc. cannot survive in any attribute.
//
// The leading guards reject anything a browser could resolve cross-origin via
// the `[^a-z]` relative branch:
//   `(?!\\)`        — no leading backslash (browsers normalize `\` → `/`)
//   `(?![/\\]{2})`  — no protocol-relative `//` or its `/\`, `\/`, `\\` variants
// Same-origin absolute (`/repos`) and relative (`repo/1`) paths are still
// allowed. The hyphen in the char classes is escaped on purpose — an unescaped
// `.-:` would be a range spanning `.`–`:` (i.e. `/` and digits).
const ALLOWED_URI_REGEXP = /^(?!\\)(?![/\\]{2})(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

export function renderMarkdown(input: string | null | undefined): string {
  if (!input) return "";
  let html: string;
  try {
    html = marked.parse(input, { async: false }) as string;
  } catch {
    // Parser blew up — fall back to escaped plaintext (no HTML reaches the DOM).
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }
  return DOMPurify.sanitize(html, {
    // <details>/<summary> + the `open` attribute power our collapsible bodies;
    // they are HTML5-standard and on DOMPurify's default allowlist, but we name
    // them explicitly so the intent survives any future config tightening.
    ADD_TAGS: ["details", "summary"],
    ADD_ATTR: ["open"],
    ALLOWED_URI_REGEXP,
  });
}
