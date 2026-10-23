/**
 * Standard globs for task `touches` (relative to the task's repo): `**` matches any number
 * of path segments, `*` and `?` stay within one segment. (opencode permission globs are
 * different: there `*` matches `/` too; see gates/affected.ts.)
 */

const cache = new Map<string, RegExp>();

export function globRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob.charAt(i + 1) === "*") {
      // "**/" matches zero or more directories; a trailing "**" matches everything below.
      if (glob.charAt(i + 2) === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

export function matchGlob(glob: string, path: string): boolean {
  return globRegExp(glob).test(path);
}

export function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((g) => matchGlob(g, path));
}

const hasWildcard = (s: string): boolean => /[*?]/.test(s);

/** Literal part before the first wildcard. */
function literalPrefix(glob: string): string {
  const i = glob.search(/[*?]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/** Literal part after the last wildcard ("*.go" → ".go"). */
function literalSuffix(glob: string): string {
  const i = Math.max(glob.lastIndexOf("*"), glob.lastIndexOf("?"));
  return i === -1 ? glob : glob.slice(i + 1);
}

/**
 * Could two globs match a common path? Conservative: true unless provably disjoint.
 * A false "overlap" only serialises two tasks; a false "disjoint" could let two agents
 * edit the same file, so ties go to overlap.
 */
export function globsOverlap(a: string, b: string): boolean {
  if (!hasWildcard(a)) return hasWildcard(b) ? matchGlob(b, a) : a === b;
  if (!hasWildcard(b)) return matchGlob(a, b);
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  if (!pa.startsWith(pb) && !pb.startsWith(pa)) return false;
  const sa = literalSuffix(a);
  const sb = literalSuffix(b);
  // Different file-name endings ("*.go" vs "*.ts") cannot match the same path.
  if (!sa.includes("/") && !sb.includes("/") && !sa.endsWith(sb) && !sb.endsWith(sa)) return false;
  return true;
}

export function touchesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}

/** opencode permission-glob semantics: `*` matches anything including `/`, `?` one char. */
export function opencodeGlobRegExp(glob: string): RegExp {
  const body = glob
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}
