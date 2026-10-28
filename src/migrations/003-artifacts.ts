import { appendJsonc, parseJsonc, setJsonc } from "../config/jsonc.ts";
import type { Migration } from "./types.ts";

/**
 * v3 → v4: tracked artifacts. The new `artifacts` block defaults to local, so the migration
 * writes it explicitly (to make the switch discoverable) and keeps records out of the graph.
 */
export const artifactsV4: Migration = {
  from: 3,
  to: 4,
  name: "artifacts",
  migrate(text) {
    const value = parseJsonc(text).value as { graph?: { exclude?: unknown } };
    let out = setJsonc(text, ["artifacts"], {
      mode: "local",
      reports: true,
      approvals: true,
      usage: true,
    });
    const exclude = value.graph?.exclude;
    if (Array.isArray(exclude) && !exclude.includes("factory-records/**")) {
      out = appendJsonc(out, ["graph", "exclude"], "factory-records/**");
    }
    return setJsonc(out, ["schemaVersion"], 4);
  },
};
