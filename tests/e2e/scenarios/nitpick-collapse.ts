import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "nitpick-collapse",
  description:
    "Style-only diff under assertive profile — review summary should include a 🧹 Nitpick comments collapse with per-file grouping.",
  prTitle: "Add string utility helpers",
  prBody:
    "Adds a couple of small string helpers used by the upcoming logging refactor.",
  files: [
    {
      path: ".diffsentry.yaml",
      content: `reviews:
  profile: "assertive"
`,
    },
    {
      path: "src/util/strings.ts",
      content: `// utility helpers
export function CapitalizeFirstLetter( str:string ):string{
return str.charAt(0).toUpperCase()+str.slice(1)
}

export function repeat_string(s:string,n:number):string{
let out=''
for(let i=0;i<n;i++){out=out+s}
return out
}
`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    reviewBodyContains: [
      "🧹 Nitpick comments",
      "Prompt for all review comments",
    ],
  },
};
