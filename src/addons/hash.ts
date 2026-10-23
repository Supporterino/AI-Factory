import { createHash } from "node:crypto";

/**
 * Ponytail content hash (versions.ts): sha256 over the concatenated `shasum -a 256` lines
 * ("<hex>  <path>\n") of the vendored files, sorted by path in byte order.
 */
export function contentHash(
  files: readonly { path: string; content: string | Uint8Array }[],
): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${createHash("sha256").update(f.content).digest("hex")}  ${f.path}\n`)
    .join("");
  return createHash("sha256").update(lines).digest("hex");
}

/** Text only: no NUL bytes and valid UTF-8 (the add-on must never ship binaries). */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
