import { join } from "node:path";

// Tool binaries for tests: the pinned OpenSpec devDependency, and version stubs for tools
// whose behaviour the tests do not exercise yet (opencode, graphify).
const root = join(import.meta.dir, "..");
process.env.AI_FACTORY_OPENSPEC_BIN ??= join(root, "node_modules/.bin/openspec");
process.env.AI_FACTORY_OPENCODE_BIN ??= join(root, "test/fixtures/bin/opencode");
process.env.AI_FACTORY_GRAPHIFY_BIN ??= join(root, "test/fixtures/bin/graphify");

// Isolate every git call (fixtures and the CLI under test) from the developer's config:
// no global hooksPath, signing, templates or identity leak into the tests.
process.env.GIT_CONFIG_GLOBAL = join(root, "test/fixtures/gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
