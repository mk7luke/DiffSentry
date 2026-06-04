import { useMemo, type ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// <JsonView> — a tiny, dependency-free syntax-highlighted JSON renderer.
//
// Pretty-prints a JSON string (2-space indent) and spans-wraps each token type
// (key / string / number / boolean / null / punctuation) so base.css can color
// them. Falls back to rendering the raw text verbatim if it isn't valid JSON.
// ─────────────────────────────────────────────────────────────────────────────

// Matches one JSON token at a time: strings (with the trailing `:` that marks a
// key), numbers, booleans, and null. Punctuation/whitespace falls through.
const TOKEN_RE =
  /("(?:\\.|[^"\\])*"\s*:?)|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b)|(\bnull\b)/g;

function highlight(pretty: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(pretty)) !== null) {
    if (m.index > last) out.push(pretty.slice(last, m.index));
    const [tok, str, num, bool, nul] = m;
    if (str !== undefined) {
      // A string token ending in `:` (ignoring trailing space) is an object key.
      const isKey = /:\s*$/.test(str);
      out.push(
        <span key={key++} className={isKey ? "jv-key" : "jv-str"}>
          {str}
        </span>,
      );
    } else if (num !== undefined) {
      out.push(
        <span key={key++} className="jv-num">
          {num}
        </span>,
      );
    } else if (bool !== undefined) {
      out.push(
        <span key={key++} className="jv-bool">
          {bool}
        </span>,
      );
    } else if (nul !== undefined) {
      out.push(
        <span key={key++} className="jv-null">
          {nul}
        </span>,
      );
    } else {
      out.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < pretty.length) out.push(pretty.slice(last));
  return out;
}

export function JsonView({ json }: { json: string }) {
  const content = useMemo<ReactNode[]>(() => {
    try {
      const pretty = JSON.stringify(JSON.parse(json), null, 2);
      return highlight(pretty);
    } catch {
      // Not valid JSON — show it raw rather than erroring.
      return [json];
    }
  }, [json]);

  return (
    <pre className="jsonview" aria-label="Payload JSON">
      <code>{content}</code>
    </pre>
  );
}
