/**
 * Writes dist/package.json so the standalone CLI bundle is treated as ESM even when it is
 * executed outside the package root (for example from the CI artifact, which only contains dist/).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dir, "..", "dist", "package.json");
writeFileSync(out, `${JSON.stringify({ type: "module" }, null, 2)}\n`);
console.log(`wrote ${out}`);
