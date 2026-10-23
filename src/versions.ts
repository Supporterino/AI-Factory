// Pinned tool versions. Every value here was verified in Phase 0 (2026-10-23);
// see docs/research/tooling.md for the source of each one.

export interface VersionRange {
  /** Lowest version the factory supports (inclusive). */
  readonly min: string;
  /** First version the factory does NOT support (exclusive). */
  readonly maxExclusive: string;
  /** Version the factory was verified against. */
  readonly tested: string;
}

/** opencode v2 runtime. 2.1.0 broke plugin/SDK contracts on purpose, so stay within one minor. */
export const OPENCODE: VersionRange & { readonly npmCli: string } = {
  min: "2.1.2",
  maxExclusive: "2.2.0",
  tested: "2.1.2",
  npmCli: "@opencode/cli",
};

/** npm packages the factory itself depends on; kept equal to OPENCODE.tested. */
export const OPENCODE_CLIENT_PACKAGE = { name: "@opencode/client", version: "2.1.2" } as const;
export const OPENCODE_PLUGIN_PACKAGE = { name: "@opencode/plugin", version: "2.1.2" } as const;

/** OpenSpec CLI. Behaviour checked on 1.10.0 (installed) and 1.14.3 (latest). */
export const OPENSPEC: VersionRange & { readonly npm: string } = {
  min: "1.10.0",
  maxExclusive: "2.0.0",
  tested: "1.14.3",
  npm: "@fission-ai/openspec",
};

/** Graphify (PyPI package is "graphifyy"). */
export const GRAPHIFY: VersionRange & { readonly pypi: string; readonly graphSchemaVersion: number } = {
  min: "0.9.93",
  maxExclusive: "0.10.0",
  tested: "0.9.93",
  pypi: "graphifyy",
  graphSchemaVersion: 1,
};

/** git: GIT_CONFIG_COUNT env injection needs >= 2.31. */
export const GIT = { min: "2.31.0", tested: "2.54.0" } as const;

export const BUN = { min: "1.3.0", tested: "1.3.11" } as const;

/** Ponytail add-on, vendored at an exact commit and verified by content hash. */
export const PONYTAIL = {
  repo: "https://github.com/DietrichGebert/ponytail",
  npm: "@dietrichgebert/ponytail",
  tag: "v5.3.2",
  commit: "16352ac229eb08a9598dcae48fe9f2b342567d86",
  /**
   * sha256 over the concatenated `shasum -a 256 <path>` lines ("<hex>  <path>\n")
   * of `files`, sorted with LC_ALL=C.
   */
  contentSha256: "e7a219f6eea3af5bc5338b05838ca63b9cf4797beeb589abc120b98fdd57efb9",
  files: [
    ".opencode/command/ponytail-review.md",
    "AGENTS.md",
    "LICENSE",
    "skills/ponytail-review/SKILL.md",
    "skills/ponytail/SKILL.md",
  ],
} as const;
