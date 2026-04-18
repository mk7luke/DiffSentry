import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "sql-injection",
  description: "Bot should flag string-concatenation SQL as critical and suggest parameterization.",
  prTitle: "Add user lookup query",
  prBody: "Adds a getUserByName helper used by the new admin route.",
  files: [
    {
      path: "src/db/users.js",
      content: `const db = require("./connection");

async function getUserByName(name) {
  const result = await db.query("SELECT * FROM users WHERE name = '" + name + "'");
  return result.rows[0];
}

module.exports = { getUserByName };
`,
    },
  ],
  waitFor: { walkthrough: true, review: true, inlineCommentsAtLeast: 1 },
  expect: {
    reviewState: "CHANGES_REQUESTED",
    inlineCommentsContain: [
      { pathContains: "users.js", bodyContains: ["SQL"] },
    ],
  },
};
