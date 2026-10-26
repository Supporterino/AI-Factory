/**
 * Prints the CHANGELOG section for one version, without its heading.
 * Used for GitHub Release notes.
 *
 *   bun scripts/changelog-section.ts 0.2.0
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function changelogSection(markdown: string, version: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);

  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  if (body === "") throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return body;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (version === undefined || version === "") {
    console.error("usage: bun scripts/changelog-section.ts <version>");
    process.exit(1);
  }
  const text = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");
  process.stdout.write(`${changelogSection(text, version)}\n`);
}
