import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Language } from "../config/schema.ts";
import { listFiles } from "../detect/walk.ts";
import { type Profile, profilesFor, type Requirement } from "../profiles/index.ts";

/** One place a profile's gates run: a package, module, crate, or the chart set of a repo. */
export interface Target {
  readonly profile: Profile;
  /** Worktree-relative directory the gate commands run in ("." for the root). */
  readonly dir: string;
  /** For chart targets: chart dirs relative to `dir`. */
  readonly charts: readonly string[];
}

const WALK = { maxDepth: 8, maxFiles: 50_000 } as const;

export function worktreeFiles(worktree: string): string[] {
  return listFiles(worktree, WALK).map((f) => f.path);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

const within = (path: string, dir: string): boolean =>
  dir === "." || path === dir || path.startsWith(`${dir}/`);

/** An Xcode project bundle marks its parent; any other marker file marks its own dir. */
function markerDir(path: string): string {
  const dir = dirOf(path);
  return dir.endsWith(".xcodeproj") ? dirOf(dir) : dir;
}

function markerDirs(profile: Profile, files: readonly string[]): string[] {
  const dirs = [
    ...new Set(
      files.filter((f) => profile.markers.includes(f.slice(f.lastIndexOf("/") + 1))).map(markerDir),
    ),
  ].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  if (profile.targets === "nested") return dirs;
  // Keep top-most only: a workspace root covers its packages, a chart its subcharts.
  return dirs.filter((d, i) => !dirs.slice(0, i).some((outer) => d !== outer && within(d, outer)));
}

/**
 * Gate targets of a repo worktree. TypeScript and React share one target (same tools), so
 * profiles with identical gate tables are merged per directory.
 */
export function findTargets(languages: readonly Language[], files: readonly string[]): Target[] {
  const targets: Target[] = [];
  for (const profile of profilesFor(languages)) {
    const dirs = markerDirs(profile, files);
    if (dirs.length === 0) continue;
    if (profile.targets === "charts") {
      targets.push({ profile, dir: ".", charts: dirs });
      continue;
    }
    for (const dir of dirs) {
      if (!targets.some((t) => t.dir === dir && t.profile.gates === profile.gates)) {
        targets.push({ profile, dir, charts: [] });
      }
    }
  }
  // A profile that supersedes another in the same directory runs instead of it.
  return targets.filter(
    (t) => !targets.some((o) => o.dir === t.dir && o.profile.supersedes?.includes(t.profile.id)),
  );
}

/** Marker dirs per profile, used by installs (each package/module/chart installs on its own). */
export function installDirs(profile: Profile, files: readonly string[]): string[] {
  return markerDirs(profile, files);
}

function packageDependencies(abs: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(abs, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const names = new Set<string>();
    for (const key of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const deps = pkg[key];
      if (typeof deps === "object" && deps !== null)
        for (const name of Object.keys(deps)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Whether a candidate's requirement holds for a target. Files are looked up in the target
 * dir and, for workspace packages, in the worktree root as well.
 */
export function requirementHolds(
  req: Requirement | undefined,
  worktree: string,
  dir: string,
): boolean {
  if (req === undefined) return true;
  const dirs = dir === "." ? [worktree] : [join(worktree, dir), worktree];
  if ("file" in req) return dirs.some((d) => req.file.some((f) => existsSync(join(d, f))));
  if ("dependency" in req) {
    return dirs.some((d) => {
      const deps = packageDependencies(d);
      return req.dependency.some((name) => deps.has(name));
    });
  }
  return dirs.some((d) => {
    try {
      return readFileSync(join(d, req.fileContains.file), "utf8").includes(req.fileContains.text);
    } catch {
      return false;
    }
  });
}

export { within as isWithinDir };
