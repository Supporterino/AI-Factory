/**
 * Bundles src/plugin/entry.ts into one self-contained file (opencode cannot resolve packages
 * from .opencode/plugins/). Output: templates/plugin/factory-plugin.txt, rendered by init
 * into .opencode/plugins/factory.js. A test fails when the committed bundle is stale.
 *
 *   bun run build:plugin
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_OUT = join(import.meta.dir, "..", "templates", "plugin", "factory-plugin.txt");

export async function bundlePlugin(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "src", "plugin", "entry.ts")],
    target: "bun",
    format: "esm",
    minify: false,
  });
  if (!result.success || result.outputs[0] === undefined) {
    throw new Error(`plugin build failed:\n${result.logs.join("\n")}`);
  }
  const code = await result.outputs[0].text();
  return `// ai-factory opencode plugin — generated from src/plugin/entry.ts; do not edit.\n${code}`;
}

if (import.meta.main) {
  writeFileSync(PLUGIN_OUT, await bundlePlugin());
  console.log(`wrote ${PLUGIN_OUT}`);
}
