import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { git } from "../exec.ts";
import type { Profile } from "../profiles/index.ts";
import { isWithinDir, type Target } from "./targets.ts";

/**
 * Affected-file selection for per-task gates. "Changed" means: differs from the base commit,
 * committed or not, plus untracked files that are not ignored.
 */
export async function changedFiles(worktree: string, base: string): Promise<string[]> {
  const diff = await git(["diff", "--name-only", "--no-renames", base, "--"], { cwd: worktree });
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], { cwd: worktree });
  if (diff.code !== 0) throw new Error(`git diff ${base} failed: ${diff.stderr.trim()}`);
  const all = `${diff.stdout}\n${untracked.stdout}`.split("\n").filter((l) => l.trim() !== "");
  return [...new Set(all)].sort();
}

/** opencode-style glob (`*` matches `/` too) to a regex. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

export function isTestFile(profile: Profile, path: string): boolean {
  return profile.testGlobs.some((g) => globToRegExp(g).test(path));
}

export function shellQuote(arg: string): string {
  return /^[\w./@%+=:,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

const hasExt = (profile: Profile, path: string): boolean =>
  profile.extensions.some((ext) => path.endsWith(ext));

const stem = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
};

/** Changed files a target cares about (worktree-relative). */
export function targetChanges(target: Target, changed: readonly string[]): string[] {
  const roots =
    target.charts.length > 0 ? target.charts.map((c) => join(target.dir, c)) : [target.dir];
  return changed.filter(
    (f) =>
      roots.some((r) => isWithinDir(f, r)) &&
      (target.charts.length > 0 || hasExt(target.profile, f)),
  );
}

function crateName(cargoToml: string): string | undefined {
  try {
    const text = readFileSync(cargoToml, "utf8");
    const pkg = text.split(/^\[/m).find((section) => section.startsWith("package]"));
    return pkg?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  } catch {
    return undefined;
  }
}

/** Directories containing `path`, nearest first, ending with ".". */
function ancestorDirs(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  const dirs: string[] = [];
  for (let i = parts.length; i > 0; i--) dirs.push(parts.slice(0, i).join("/"));
  return [...dirs, "."];
}

export interface PlaceholderValues {
  readonly files: string[];
  readonly testFiles: string[];
  readonly packages: string[];
  readonly crates: string[];
  readonly charts: string[];
  readonly base: string;
}

/**
 * Placeholder values for one target, relative to the target dir. In full mode only
 * {charts} and {base} matter; the others describe the task's changes.
 */
export function placeholderValues(
  worktree: string,
  target: Target,
  changed: readonly string[],
  allFiles: readonly string[],
  base: string,
  mode: "task" | "full",
): PlaceholderValues {
  const rel = (p: string): string => (target.dir === "." ? p : relative(target.dir, p));
  const mine = targetChanges(target, changed);
  const existing = mine.filter((f) => existsSync(join(worktree, f)));

  const tests = new Set(existing.filter((f) => isTestFile(target.profile, f)));
  const stems = new Set(existing.filter((f) => !isTestFile(target.profile, f)).map(stem));
  for (const f of allFiles) {
    if (isWithinDir(f, target.dir) && isTestFile(target.profile, f) && stems.has(stem(f)))
      tests.add(f);
  }

  const packages = [...new Set(existing.filter((f) => f.endsWith(".go")).map((f) => rel(f)))]
    .map((f) => (f.includes("/") ? `./${f.slice(0, f.lastIndexOf("/"))}` : "."))
    .filter((p, i, all) => all.indexOf(p) === i);

  const crates = new Set<string>();
  for (const f of existing.filter((x) => x.endsWith(".rs"))) {
    const name = ancestorDirs(f)
      .map((dir) => crateName(join(worktree, dir, "Cargo.toml")))
      .find((n) => n !== undefined);
    if (name) crates.add(name);
  }

  const charts =
    mode === "full"
      ? [...target.charts]
      : target.charts.filter((c) => mine.some((f) => isWithinDir(f, join(target.dir, c))));

  return {
    files: existing.map(rel),
    testFiles: [...tests].sort().map(rel),
    packages: packages.sort(),
    crates: [...crates].sort().map((c) => `-p ${c}`),
    charts,
    base,
  };
}

const PLACEHOLDER = /\{(files|testFiles|packages|crates|charts|base)\}/g;

/** Fills placeholders. Returns undefined when a list placeholder is empty (nothing affected). */
export function fillPlaceholders(command: string, values: PlaceholderValues): string | undefined {
  let empty = false;
  const out = command.replace(PLACEHOLDER, (_, name: keyof PlaceholderValues) => {
    if (name === "base") return shellQuote(values.base);
    const list = values[name];
    if (list.length === 0) empty = true;
    // crates entries are already "-p name" flags.
    return name === "crates" ? list.join(" ") : list.map(shellQuote).join(" ");
  });
  return empty ? undefined : out;
}
