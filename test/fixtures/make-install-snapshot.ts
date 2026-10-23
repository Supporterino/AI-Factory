/**
 * Writes test/fixtures/install-<version>.json: every tracked file of the single-repo fixture
 * right after `ai-factory init` (no graph). The update tests replay it as "a workspace
 * installed by the previous factory version". Regenerate only when cutting a release:
 *
 *   GIT_CONFIG_GLOBAL=$PWD/test/fixtures/gitconfig AI_FACTORY_OPENSPEC_BIN=$PWD/node_modules/.bin/openspec \
 *     AI_FACTORY_GRAPHIFY_BIN=$PWD/test/fixtures/bin/graphify AI_FACTORY_OPENCODE_BIN=$PWD/test/fixtures/bin/opencode bun test/fixtures/make-install-snapshot.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { gitOk } from "../../src/exec.ts";
import { FACTORY_VERSION } from "../../src/version.ts";
import { createSingleRepoFixture } from "./workspaces.ts";

const fx = await createSingleRepoFixture();
try {
  const code = await runCli(["init", "--no-graph"], {
    cwd: fx.root,
    out: () => {},
    err: (t) => console.error(t),
  });
  if (code !== 0) throw new Error(`init failed (${code})`);
  const files = (await gitOk(["ls-files"], { cwd: fx.root })).split("\n").filter(Boolean);
  const snapshot = Object.fromEntries(
    files.map((f) => [f, readFileSync(join(fx.root, f), "utf8")]),
  );
  const out = join(import.meta.dir, `install-${FACTORY_VERSION}.json`);
  writeFileSync(out, `${JSON.stringify({ version: FACTORY_VERSION, files: snapshot }, null, 1)}\n`);
  console.log(`wrote ${out} (${files.length} files)`);
} finally {
  fx.cleanup();
}
