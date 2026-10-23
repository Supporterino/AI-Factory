import { parseJsonc, setJsonc } from "../config/jsonc.ts";
import { DEFAULT_GRAPH_EXCLUDE } from "../config/schema.ts";
import type { Migration } from "./types.ts";

/** The `graph.exclude` that factory 0.1.0 wrote into new configs. */
export const V1_GRAPH_EXCLUDE = [
  "**/node_modules/**",
  "**/target/**",
  "**/dist/**",
  "**/.venv/**",
  ".factory/**",
  "graphify-out/**",
] as const;

/**
 * v1 → v2: the default graph excludes grew (vendored deps, build output, coverage, caches).
 * A config that still has the v1 default list gets the v2 list; a customised list is kept.
 */
export const graphExcludeDefaults: Migration = {
  from: 1,
  to: 2,
  name: "graph-exclude-defaults",
  migrate(text) {
    const value = parseJsonc(text).value as { graph?: { exclude?: unknown } };
    const exclude = value.graph?.exclude;
    let out = text;
    if (JSON.stringify(exclude) === JSON.stringify(V1_GRAPH_EXCLUDE)) {
      out = setJsonc(out, ["graph", "exclude"], [...DEFAULT_GRAPH_EXCLUDE]);
    }
    return setJsonc(out, ["schemaVersion"], 2);
  },
};
