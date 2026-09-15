import { defineConfig } from "vitest/config";

/**
 * Source is authored in NodeNext style: relative imports carry an explicit
 * `.js` extension that maps to the sibling `.ts` source (e.g. `./store.js` →
 * `./store.ts`). Vite/esbuild does not rewrite `.js` → `.ts` on its own, so
 * this small `pre` resolver does it, letting tests import the real source
 * modules unchanged, exactly as `tsc` compiles them.
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
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
