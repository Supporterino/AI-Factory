import { join } from "node:path";
import { isSecretPath } from "./paths.ts";

/**
 * Secret-file reads the shell parser cannot see by name (audit S11): glob words, recursive
 * searches and file names inside inline code. Shared by the shell policy and the plugin's
 * grep tool check. Pure: directory listings come from the caller.
 */

export type ReadDir = (abs: string) => readonly string[] | undefined;

const GLOB = /[*?[]/;

/** Regex for one glob path segment; like the shell, `*` and `?` never match a leading dot. */
export function segmentRegExp(segment: string): RegExp {
  let body = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] ?? "";
    if (c === "*") body += "[^/]*";
    else if (c === "?") body += "[^/]";
    else if (c === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end === -1) body += "\\[";
      else {
        const set = segment.slice(i + 1, end).replace(/^!/, "^");
        body += `[${set.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else body += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  const dotless = !segment.startsWith(".");
  return new RegExp(`^${dotless ? "(?!\\.)" : ""}${body}$`, "i");
}

/** Names a glob may stand for when the directory cannot be listed. */
const SECRET_SAMPLES: readonly string[] = [
  ".env",
  ".env.local",
  ".env.production",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".aws/credentials",
  ".aws/config",
  ".kube/config",
  ".docker/config.json",
  ".ssh/id_rsa",
  ".ssh/id_ed25519",
];

/**
 * Whether a glob path (absolute, already resolved) can match a secret file: expanded against
 * the filesystem when `readdir` is given, else against well-known secret names.
 */
export function globMatchesSecret(pattern: string, readdir?: ReadDir): string | undefined {
  if (!GLOB.test(pattern)) return undefined;
  const segments = pattern.split("/");
  const first = segments.findIndex((s) => GLOB.test(s));
  if (readdir !== undefined) {
    let paths = [segments.slice(0, first).join("/") || "/"];
    let seen = 0;
    for (const segment of segments.slice(first)) {
      const re = GLOB.test(segment) ? segmentRegExp(segment) : undefined;
      const next: string[] = [];
      for (const dir of paths) {
        if (re === undefined) {
          next.push(join(dir, segment));
          continue;
        }
        for (const name of readdir(dir) ?? []) {
          if (++seen > 5000) return undefined;
          if (re.test(name)) next.push(join(dir, name));
        }
      }
      paths = next;
    }
    return paths.find((p) => isSecretPath(p));
  }
  const tail = segments.slice(first).filter((s) => s !== "");
  for (const sample of SECRET_SAMPLES) {
    const parts = sample.split("/");
    if (parts.length < tail.length) continue;
    const end = parts.slice(parts.length - tail.length);
    if (tail.every((seg, k) => segmentRegExp(seg).test(end[k] ?? ""))) return sample;
  }
  return undefined;
}

/** Directories a recursive search never needs to look into for secrets (generated or VCS). */
const SKIP = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  ".venv",
  "venv",
]);

/**
 * The first secret file under `dir` (depth-first, bounded), as a path relative to `dir`.
 * Past the bounds the walk stops: the OS sandbox is the backstop for very large trees.
 */
export function findSecretUnder(
  dir: string,
  readdir: ReadDir,
  maxEntries = 20_000,
): string | undefined {
  let seen = 0;
  const walk = (abs: string, rel: string, depth: number): string | undefined => {
    if (depth > 10) return undefined;
    for (const name of readdir(abs) ?? []) {
      if (++seen > maxEntries) return undefined;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (isSecretPath(childRel)) return childRel;
      if (SKIP.has(name)) continue;
      const found = walk(join(abs, name), childRel, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(dir, "", 0);
}

/** A secret file named inside inline code (`open('.env')`, `readFileSync('.aws/credentials')`). */
const MENTION =
  /(?:^|[\s'"`/(=,])((?:\.env(?!\.(?:example|sample|template|dist|defaults)\b)(?:\.[\w-]+)*|id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|\.git-credentials|\.aws\/credentials|\.kube\/config|kubeconfig|\.ssh\/[\w.-]+))(?=$|[\s'"`),;])/;

export function mentionedSecret(code: string): string | undefined {
  return code.match(MENTION)?.[1];
}
