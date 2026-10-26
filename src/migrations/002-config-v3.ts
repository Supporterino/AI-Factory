import { parseJsonc, setJsonc } from "../config/jsonc.ts";
import type { Migration } from "./types.ts";

/**
 * v2 → v3: context and workflow features. The new fields all have schema defaults, so the
 * migration only bumps the version; a user's existing values and comments stay untouched.
 */
export const configV3: Migration = {
  from: 2,
  to: 3,
  name: "config-v3",
  migrate(text) {
    parseJsonc(text);
    return setJsonc(text, ["schemaVersion"], 3);
  },
};
