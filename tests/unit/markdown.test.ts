import { describe, expect, it, vi } from "vitest";

import { renderMarkdown } from "../../src/dashboard/markdown.js";

// The legacy dashboard renders stored webhook content — issue bodies, PR
// descriptions, finding bodies — that anyone who can open an issue on an
// installed repo authors. These tests pin the sanitizer against the bypass
// classes the previous regex-blacklist implementation was vulnerable to.

describe("renderMarkdown — XSS vectors", () => {
  it("drops script tags entirely", () => {
    const out = renderMarkdown("hello <script>alert(1)</script> world");
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });

  it("drops iframes including entity-encoded srcdoc payloads", () => {
    // &#60; decodes to '<' at HTML-parse time, and the browser still creates
    // the frame when the closing tag is absent — both defeat a regex stripper
    // that needs to match a literal <iframe ...>...</iframe> pair.
    const out = renderMarkdown(`<iframe srcdoc="&#60;script&#62;alert(1)&#60;/script&#62;">`);
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("srcdoc");
    expect(out).not.toContain("alert");
  });

  it("drops object/embed tags", () => {
    const out = renderMarkdown('<object data="evil.swf"></object><embed src="evil.swf">');
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
  });

  it("blocks javascript: URLs regardless of entity obfuscation", () => {
    for (const href of [
      "javascript:alert(1)",
      "javascript&colon;alert(1)",
      "java\tscript:alert(1)",
      "JaVaScRiPt:alert(1)",
    ]) {
      const out = renderMarkdown(`[click](${href.replace(/\t/g, "%09")})`);
      expect(out).not.toMatch(/href=(["']?)\s*javascript/i);
    }
  });

  it("strips inline event handlers", () => {
    const raw = '<img src="https://example.com/a.png" alt="" onerror="alert(1)">';
    const out = renderMarkdown(raw);
    expect(out).not.toContain("onerror");
    expect(out).toContain("https://example.com/a.png");
  });

  it("blocks protocol-relative URLs", () => {
    const out = renderMarkdown("[x](//evil.example/payload)");
    expect(out).not.toMatch(/href=(["']?)\s*\/\//);
  });

  it("applies the scheme allowlist to image sources too", () => {
    // Pin the img policy explicitly: no data: URLs may survive in src,
    // regardless of what sanitize-html's per-tag defaults do in future
    // versions (DOMPurify, the SPA's sanitizer, permits data: images by
    // default — this server-side config must never drift that way).
    for (const raw of [
      '<img alt="" src="data:image/svg+xml,<svg onload=alert(1)>">',
      '<img alt="" src="DATA:image/png;base64,iVBOR">',
    ]) {
      const out = renderMarkdown(raw);
      expect(out).not.toMatch(/src=/i);
      expect(out).not.toContain("data:");
      expect(out).not.toContain("alert");
    }
  });

  it("neutralizes raw html links whose scheme is not allowlisted", () => {
    const out = renderMarkdown('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(out).not.toContain("data:");
    expect(out).not.toContain("<script>");
  });
});

describe("renderMarkdown — benign markdown survives", () => {
  it("keeps details/summary collapsibles with the open attribute", () => {
    const out = renderMarkdown("<details open>\n<summary>More</summary>\nbody text\n</details>");
    expect(out).toContain("<details open>");
    expect(out).toContain("<summary>More</summary>");
    expect(out).toContain("body text");
  });

  it("keeps tables", () => {
    const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<table>");
    expect(out).toContain("<td>1</td>");
  });

  it("keeps fenced code blocks with their language class", () => {
    const out = renderMarkdown("```js\nlet x = 1;\n```");
    expect(out).toContain('<code class="language-js">');
    expect(out).toContain("let x = 1;");
  });

  it("keeps GFM task-list checkboxes", () => {
    const out = renderMarkdown("- [x] done\n- [ ] todo");
    expect(out).toMatch(/<input checked disabled type="checkbox" \/> done/);
    expect(out).toMatch(/<input disabled type="checkbox" \/> todo/);
  });

  it("collapses non-checkbox inputs into inert spans", () => {
    // The PR surface is input[type=checkbox]; text boxes, radios, submits,
    // and a typeless <input> (browsers default it to "text") must not survive
    // as live form controls.
    for (const raw of [
      '<input type="text" value="pwn">',
      "<input>",
      '<input type="submit" value="Go">',
      '<input type="radio" name="x">',
      '<input type="TEXT">',
    ]) {
      const out = renderMarkdown(raw);
      expect(out).not.toContain("<input");
      expect(out).not.toMatch(/\btype\b/);
      expect(out).not.toContain("pwn");
    }
  });

  it("keeps http, https and mailto links", () => {
    const out = renderMarkdown("[site](https://example.com) [mail](mailto:a@b.c)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="mailto:a@b.c"');
  });

  it("drops disallowed raw html tags while keeping the surrounding prose", () => {
    const out = renderMarkdown("use a <b>bold</b> tag here");
    expect(out).not.toContain("<b>");
    expect(out).toContain("use a");
    expect(out).toContain("tag here");
  });
});

describe("renderMarkdown — edges", () => {
  it("returns empty string for null/undefined/empty input", () => {
    expect(renderMarkdown(null)).toBe("");
    expect(renderMarkdown(undefined)).toBe("");
    expect(renderMarkdown("")).toBe("");
  });

  it("falls back to escaped plaintext when the parser throws", async () => {
    const { marked } = await import("marked");
    const spy = vi.spyOn(marked, "parse").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const out = renderMarkdown("<b>raw & stuff");
      expect(out).toBe("&lt;b&gt;raw &amp; stuff");
    } finally {
      spy.mockRestore();
    }
  });
});
