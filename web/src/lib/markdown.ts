import { marked } from "marked";
import DOMPurify from "dompurify";

// The bot's summaries + finding bodies are GitHub-flavored markdown with inline
// <details>/<summary>; parse to HTML so the SPA matches GitHub, then run the
// result through DOMPurify before it reaches dangerouslySetInnerHTML.
//
// Unlike the legacy server-rendered dashboard (which strips a few XSS vectors
// with regexes), DOMPurify is a maintained allowlist sanitizer: it drops
// <script>/<iframe>/<object>, event-handler attributes, javascript:/data: URLs,
// and other scriptable vectors the regex approach can miss, while keeping
// normal markdown formatting (and the collapsible blocks we render).

marked.setOptions({ gfm: true, breaks: false });

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
  });
}
