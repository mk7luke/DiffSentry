import { useMemo } from "react";
import { renderMarkdown } from "../lib/markdown";

// Renders bot-authored GitHub-flavored markdown. renderMarkdown() parses with
// marked and sanitizes the result with DOMPurify before it reaches the DOM.
export function Markdown({ source, maxHeight }: { source: string | null | undefined; maxHeight?: number }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className="md-body md-rendered"
      style={maxHeight ? { maxHeight, overflow: "auto" } : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
