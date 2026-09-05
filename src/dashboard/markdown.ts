import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// The bot's review summaries + finding bodies are GitHub-flavored markdown
// with inline <details>/<summary> blocks. Parse to HTML so the dashboard
// matches what GitHub shows instead of a wall of raw markdown.
//
// The output runs through an allowlist sanitizer before leaving the server.
// Markdown rendered here is not always bot-authored: issue bodies and PR
// descriptions are stored verbatim from the webhook, so anyone who can open
// an issue on an installed repo authors content an operator's browser will
// render. A regex blacklist is the wrong tool for that — entity-encoded
// payloads (`javascript&colon;`, `<iframe srcdoc="&#60;script&#62;">`) slip
// past pattern matching but not a parse-and-rebuild sanitizer.

marked.setOptions({ gfm: true, breaks: false });

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  // GFM output plus the raw-HTML surfaces our own comments rely on:
  // <details>/<summary> collapsibles and task-list checkboxes.
  allowedTags: [
    "p", "br", "hr",
    "em", "strong", "del", "s", "sub", "sup", "span",
    "code", "pre", "blockquote",
    "ul", "ol", "li",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "a", "img",
    "details", "summary",
    "input",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    // Belt-and-braces alongside the transformTags rule below: even if an
    // input element survives the transform, its type can only be "checkbox".
    input: ["checked", "disabled", { name: "type", values: ["checkbox"] }],
    th: ["align"],
    td: ["align"],
    code: ["class"], // language-* classes emitted by fenced code blocks
    details: ["open"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  // Tags without a per-tag entry fall back to the global list above, which
  // already covers img — but spelling out img keeps the policy pinned even if
  // a future sanitize-html version ships its own img-specific scheme defaults.
  allowedSchemesByTag: { img: ["http", "https"] },
  allowProtocolRelative: false,
  transformTags: {
    input: (_tagName, attribs) => {
      // GFM task lists are the only input element our rendered content relies
      // on, and they always emit <input ... type="checkbox">. Any other input
      // — text boxes, radios, submits, or a typeless <input> (which browsers
      // default to "text") — is attacker dressing rather than bot content.
      // A plain values-constraint is not enough on its own: sanitize-html
      // responds to a disallowed value by emptying the attribute but keeping
      // the element, and type="" still renders as a visible text box. Fold
      // non-checkbox inputs into an attribute-less span instead so no form
      // control survives.
      if ((attribs.type || "") !== "checkbox") {
        return { tagName: "span", attribs: {} };
      }
      return { tagName: "input", attribs };
    },
  },
};

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
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
