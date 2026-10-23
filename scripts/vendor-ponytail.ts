/**
 * Vendors the pinned Ponytail release into templates/addons/ponytail/ (ADR-0008, §12).
 * Fetches only github.com/DietrichGebert/ponytail at the pinned tag, checks the tag's commit,
 * refuses binaries and verifies the content hash before writing anything. The factory never
 * loads Ponytail at runtime; upgrades bump versions.ts and re-run this script.
 *
 *   bun run vendor:ponytail
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentHash, isText } from "../src/addons/hash.ts";
import { execOk } from "../src/exec.ts";
import { PONYTAIL } from "../src/versions.ts";

export const VENDOR_DIR = join(import.meta.dir, "..", "templates", "addons", "ponytail");

if (import.meta.main) {
  const tmp = mkdtempSync(join(tmpdir(), "ponytail-"));
  try {
    await execOk(
      ["git", "clone", "-q", "--depth", "1", "--branch", PONYTAIL.tag, `${PONYTAIL.repo}.git`, tmp],
      { cwd: tmpdir(), timeoutMs: 120_000 },
    );
    const commit = await execOk(["git", "rev-parse", "HEAD"], { cwd: tmp });
    if (commit !== PONYTAIL.commit)
      throw new Error(`tag ${PONYTAIL.tag} is ${commit}, expected ${PONYTAIL.commit}`);
    const files = PONYTAIL.files.map((path) => ({ path, content: readFileSync(join(tmp, path)) }));
    for (const f of files)
      if (!isText(f.content)) throw new Error(`refusing binary file ${f.path}`);
    const hash = contentHash(files);
    if (hash !== PONYTAIL.contentSha256)
      throw new Error(`content hash ${hash} does not match the pin ${PONYTAIL.contentSha256}`);
    rmSync(VENDOR_DIR, { recursive: true, force: true });
    for (const f of files) {
      mkdirSync(dirname(join(VENDOR_DIR, f.path)), { recursive: true });
      writeFileSync(join(VENDOR_DIR, f.path), f.content);
    }
    console.log(
      `vendored Ponytail ${PONYTAIL.tag} (${PONYTAIL.commit.slice(0, 12)}), hash ${hash.slice(0, 12)}…`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
