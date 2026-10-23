import { appendJsonc, setJsonc } from "../config/jsonc.ts";
import { parseConfigText } from "../config/load.ts";
import { CONFIG_FILE, type FactoryConfig } from "../config/schema.ts";
import { contractKey } from "./contracts.ts";
import type { Change } from "./diff.ts";

/**
 * Applies detection changes to the config text with targeted JSONC edits, so comments and
 * unrelated formatting survive. Returns the new text after validating it.
 */
export function applyChanges(
  text: string,
  config: FactoryConfig,
  changes: readonly Change[],
): string {
  let out = text;
  const repoIndex = (path: string): number => config.repos.findIndex((r) => r.path === path);
  const contractIndex = (c: Parameters<typeof contractKey>[0]): number =>
    config.contracts.findIndex((x) => contractKey(x) === contractKey(c));

  // 1. In-place edits: indices still match the original arrays.
  for (const change of changes) {
    if (change.kind === "layout") {
      out = setJsonc(out, ["layout"], change.to);
    } else if (change.kind === "repo-changed") {
      const empty =
        Array.isArray(change.to) && change.to.length === 0 && change.field === "subPaths";
      out = setJsonc(
        out,
        ["repos", repoIndex(change.path), change.field],
        empty ? undefined : change.to,
      );
    } else if (change.kind === "contract-consumers") {
      out = setJsonc(out, ["contracts", contractIndex(change.contract), "consumers"], change.to);
    }
  }

  // 2. Removals, highest index first so earlier indices stay valid.
  const repoRemovals = changes
    .flatMap((c) => (c.kind === "repo-removed" ? [repoIndex(c.path)] : []))
    .sort((a, b) => b - a);
  for (const i of repoRemovals) out = setJsonc(out, ["repos", i], undefined);
  const contractRemovals = changes
    .flatMap((c) => (c.kind === "contract-removed" ? [contractIndex(c.contract)] : []))
    .sort((a, b) => b - a);
  for (const i of contractRemovals) out = setJsonc(out, ["contracts", i], undefined);

  // 3. Additions.
  for (const change of changes) {
    if (change.kind === "repo-added") out = appendJsonc(out, ["repos"], change.repo);
    if (change.kind === "contract-added") {
      out =
        config.contracts.length === 0 && !/"contracts"\s*:/.test(out)
          ? setJsonc(out, ["contracts"], [change.contract])
          : appendJsonc(out, ["contracts"], change.contract);
    }
  }

  parseConfigText(out, CONFIG_FILE);
  return out;
}
