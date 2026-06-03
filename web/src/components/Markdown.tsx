import { useMemo } from "react";
import { renderMarkdown } from "../lib/markdown";

// Renders bot-authored GitHub-flavored markdown. Content is operator-only and
// bot-authored; renderMarkdown() strips the obvious XSS vectors (see
// src/dashboard/markdown.ts for the same posture).
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
