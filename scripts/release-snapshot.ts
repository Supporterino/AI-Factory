/**
 * Regenerates test/fixtures/install-<version>.json for the current FACTORY_VERSION.
 * It wraps test/fixtures/make-install-snapshot.ts with the same isolated tool paths as
 * test/setup.ts, so `bun run release:version` works without a prepared shell.
 *
 *   bun scripts/release-snapshot.ts
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const result = Bun.spawnSync(["bun", join(root, "test/fixtures/make-install-snapshot.ts")], {
  cwd: root,
  env: {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "test/fixtures/gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    AI_FACTORY_OPENSPEC_BIN: join(root, "node_modules/.bin/openspec"),
    AI_FACTORY_OPENCODE_BIN: join(root, "test/fixtures/bin/opencode"),
    AI_FACTORY_GRAPHIFY_BIN: join(root, "test/fixtures/bin/graphify"),
  },
  stdio: ["inherit", "inherit", "inherit"],
});

if (result.exitCode !== 0) process.exit(result.exitCode);
