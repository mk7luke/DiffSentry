import { defineConfig } from "vitest/config";

/**
 * The source compiles with `tsc` (module: commonjs) but is authored in
 * NodeNext style: relative imports carry an explicit `.js` extension that maps
 * to the sibling `.ts` source (e.g. `../storage/dao.js` → `../storage/dao.ts`).
 * Vite/esbuild does not rewrite `.js` → `.ts` on its own, so this small `pre`
 * resolver does it — letting the unit tests import the real source modules
 * unchanged, exactly as the server compiles them.
 */
function resolveTsJsExtension() {
  return {
    name: "resolve-ts-js-extension",
    enforce: "pre" as const,
    async resolveId(source: string, importer: string | undefined) {
      if (importer && source.endsWith(".js") && (source.startsWith("./") || source.startsWith("../"))) {
        const candidate = source.slice(0, -3) + ".ts";
        const resolved = await this.resolve(candidate, importer, { skipSelf: true });
        if (resolved) return resolved;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [resolveTsJsExtension()],
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // Each file in its own process: db.test.ts mutates the db singleton and
    // process.env (DB_PATH), so it must not bleed into other files.
    pool: "forks",
    clearMocks: true,
  },
});
