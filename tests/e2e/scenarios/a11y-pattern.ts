import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "a11y-pattern",
  description:
    "JSX with <img> missing alt and onClick on <div>. The built-in accessibility patterns should fire.",
  prTitle: "Add card component",
  prBody: "Adds a small card with a clickable wrapper and a thumbnail.",
  files: [
    {
      path: "src/ui/Card.tsx",
      content: `export function Card({ src, onClick }: { src: string; onClick: () => void }) {\n  return (\n    <div onClick={onClick} style={{ cursor: "pointer" }}>\n      <img src={src} />\n      <span>Card</span>\n    </div>\n  );\n}\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, inlineCommentsAtLeast: 2, timeoutMs: 240_000 },
  expect: {
    inlineCommentsContain: [
      { pathContains: "Card.tsx", bodyContains: ["<img> without alt"] },
      { pathContains: "Card.tsx", bodyContains: ["onClick on non-interactive element"] },
    ],
  },
};
