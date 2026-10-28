import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { realPathOf } from "./realpath.ts";

/**
 * OS sandbox for code agents control: their shell commands and the gates (ADR-0026). The
 * shell parser judges what a command says; the sandbox enforces what any program it starts
 * may do, however it was written (Python, a script, a symlink trick).
 *
 * macOS: `sandbox-exec` with a Seatbelt profile. Other platforms: none yet (`doctor` warns).
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export type SandboxSetting = "auto" | "off";

/** Whether to sandbox on this machine. */
export function sandboxEnabled(
  setting: SandboxSetting,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): boolean {
  return setting !== "off" && platform === "darwin" && exists(SANDBOX_EXEC);
}

export interface SandboxPolicy {
  /** The workspace root: nothing in it is writable except `writable`. */
  readonly workspace: string;
  /** Directories the sandboxed programs may write (the session's worktree, caches, …). */
  readonly writable: readonly string[];
  /** Paths inside `writable` that stay read-only (factory files, `.git`). */
  readonly readOnly?: readonly string[];
  /** Paths inside `readOnly` that are writable again (git's index and objects, caches). */
  readonly writableInside?: readonly string[];
  readonly home?: string;
  /**
   * Agent shells: secret files in the workspace (`.env`, keys, `.netrc`) are unreadable, so
   * globs, recursive greps and scripts cannot reach them either (audit S11). Gates keep reading
   * them: test runners such as Vite load `.env` on their own.
   */
  readonly denySecretReads?: boolean;
}

const regexPath = (p: string): string => realPathOf(p).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Seatbelt regexes for secret files under the workspace, and the example files re-allowed. */
function secretReadRules(workspace: string): string[] {
  const ws = regexPath(workspace);
  const under = `^${ws}/(.*/)?`;
  const secret = [
    "\\.env(\\.[^/]*)?",
    "\\.netrc",
    "\\.git-credentials",
    "\\.pypirc",
    "id_(rsa|dsa|ecdsa|ed25519)[^/]*",
    "[^/]*kubeconfig[^/]*",
    "[^/]*\\.tfstate(\\.backup)?",
  ];
  return [
    `(deny file-read-data ${secret.map((s) => `(regex #"${under}${s}$")`).join(" ")})`,
    `(allow file-read-data (regex #"${under}\\.env\\.(example|sample|template|dist|defaults)$"))`,
  ];
}

/** User files that would run code later or hand out identity if an agent rewrote them. */
const HOME_WRITE_DENY = [
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".gitconfig",
  ".config/git",
  ".config/fish",
  ".ssh",
  ".npmrc",
  ".config/opencode",
  ".local/share/opencode",
  ".opencode",
  "Library/LaunchAgents",
  ".config/autostart",
  ".config/systemd",
  ".local/bin",
  "bin",
  ".bun/bin",
  ".cargo/bin",
  "go/bin",
];

/** Directories on PATH where a planted binary would shadow a tool the factory runs. */
const SYSTEM_WRITE_DENY = ["/opt/homebrew", "/usr/local/bin", "/usr/local/sbin"];

/** Credentials no agent program may read. */
const HOME_READ_DENY = [
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
  ".gnupg",
  ".config/gcloud",
  ".config/gh",
  ".config/op",
  ".local/share/opencode",
  ".docker/config.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".vault-token",
  ".pgpass",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".terraform.d/credentials.tfrc.json",
  "Library/Keychains",
];

const sbString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const subpath = (p: string): string => `(subpath ${sbString(realPathOf(p))})`;

/** A Seatbelt profile: everything allowed except the writes, reads and exits below. */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const home = policy.home;
  const lines = [
    "(version 1)",
    "(allow default)",
    // The workspace holds run state, approvals, other worktrees and the AI repo itself.
    `(deny file-write* ${subpath(policy.workspace)})`,
  ];
  if (policy.writable.length > 0)
    lines.push(`(allow file-write* ${policy.writable.map(subpath).join(" ")})`);
  if ((policy.readOnly ?? []).length > 0)
    lines.push(`(deny file-write* ${(policy.readOnly ?? []).map(subpath).join(" ")})`);
  if ((policy.writableInside ?? []).length > 0)
    lines.push(`(allow file-write* ${(policy.writableInside ?? []).map(subpath).join(" ")})`);
  if (home !== undefined) {
    lines.push(
      `(deny file-write* ${HOME_WRITE_DENY.map((p) => subpath(join(home, p))).join(" ")})`,
    );
    lines.push(`(deny file-read* ${HOME_READ_DENY.map((p) => subpath(join(home, p))).join(" ")})`);
  }
  lines.push(`(deny file-write* ${SYSTEM_WRITE_DENY.map(subpath).join(" ")})`);
  if (policy.denySecretReads === true) lines.push(...secretReadRules(policy.workspace));
  // Pushing needs credentials or ssh: no credential helpers, no ssh connections.
  lines.push('(deny process-exec (regex #"/git-credential-[^/]*$"))');
  lines.push('(deny network-outbound (remote tcp "*:22"))');
  return lines.join("\n");
}

/** `argv` run under the profile. */
export function sandboxArgv(profile: string, argv: readonly string[]): string[] {
  return [SANDBOX_EXEC, "-p", profile, ...argv];
}

const shQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** A shell command line that runs `command` with `shell -c` under the profile. */
export function sandboxCommand(profile: string, shell: string, command: string): string {
  return `exec ${shQuote(SANDBOX_EXEC)} -p ${shQuote(profile)} ${shQuote(shell)} -c ${shQuote(command)}`;
}

/**
 * Git directories a worktree needs to write for `git status`/`git add`: its own admin dir
 * (`.git` file → gitdir) and the shared object store. Refs, config and hooks stay read-only.
 */
export function gitWritableDirs(worktree: string): string[] {
  const dotGit = join(worktree, ".git");
  let gitDir = dotGit;
  try {
    const text = readFileSync(dotGit, "utf8");
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (m?.[1]) gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(worktree, m[1].trim());
  } catch {
    // `.git` is a directory (a plain checkout): its index and objects live there.
    return [join(dotGit, "index"), join(dotGit, "index.lock"), join(dotGit, "objects")];
  }
  let common = gitDir;
  try {
    const rel = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    common = isAbsolute(rel) ? rel : resolve(gitDir, rel);
  } catch {
    // Not a linked worktree: the gitdir is the common dir.
  }
  return [gitDir, join(common, "objects")];
}

/** Factory-owned paths inside a worktree (single-repo layout) that agents must not write. */
export function protectedInWorktree(worktree: string): string[] {
  return [
    ".git",
    ".opencode",
    ".factory",
    "factory-records",
    "AGENTS.md",
    "factory.config.jsonc",
    "factory.lock.json",
    "openspec/specs",
    ".gitmodules",
  ].map((p) => join(worktree, p));
}

/**
 * The policy for programs working in one checkout (an agent's worktree, or a gate's): write
 * the checkout except factory files and `.git`, plus git's index/objects and `extra`.
 */
export function checkoutPolicy(
  workspace: string,
  dir: string,
  extra: readonly string[] = [],
  home: string | undefined = process.env.HOME,
): SandboxPolicy {
  return {
    workspace,
    writable: [dir],
    readOnly: protectedInWorktree(dir),
    writableInside: [...gitWritableDirs(dir), ...extra],
    ...(home === undefined ? {} : { home }),
  };
}
