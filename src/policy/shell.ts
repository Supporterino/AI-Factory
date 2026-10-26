import { isAbsolute, normalize, relative, resolve } from "node:path";
import { isProtectedPath, isSecretPath } from "./paths.ts";
import {
  type Command,
  type Pipeline,
  parseScript,
  type Redirect,
  type Script,
  ShellParseError,
  type SimpleCommand,
} from "./shell-parse.ts";

/**
 * The shell blocklist (§8). Commands are judged on their parsed structure after unwrapping
 * `env`, `xargs`, `nohup`, `timeout`, `sh -c`, `eval`, aliases, `find -exec`, here-docs,
 * pipes into shells and scripts executed by path. Blocked:
 * - git push / remote changes / force operations / history rewrites / branch and tag
 *   deletion / config writes / unknown subcommands (git aliases);
 * - `rm` outside the session directory, writes to protected or outside paths;
 * - sudo and friends; `curl | sh`-style pipes; reading or writing secret files;
 * - environment dumps and tampering with the factory's git environment;
 * - graph updates (the CLI owns them) and publishing.
 */

export interface ShellContext {
  /** Absolute directory the command runs in (the session directory). */
  readonly cwd: string;
  /** Absolute directory writes must stay inside (worktree, or the workspace for the architect). */
  readonly root: string;
  /** Reads a file for script inspection; undefined when missing or not text. */
  readonly readFile?: (abs: string) => string | undefined;
  readonly exists?: (abs: string) => boolean;
  /** For `~` / `$HOME` / `$TMPDIR` resolution. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type ShellVerdict = { allowed: true } | { allowed: false; reason: string };

class Blocked extends Error {}

function block(reason: string): never {
  throw new Blocked(reason);
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
/** Commands xargs may run with arguments it reads from unknown input: they only read. */
const XARGS_SAFE = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "cat",
  "head",
  "tail",
  "wc",
  "ls",
  "stat",
  "file",
  "echo",
  "printf",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sort",
  "uniq",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "shasum",
  "du",
  "test",
  "[",
  "true",
]);
/** Run, schedule or script arbitrary commands in ways the parser cannot follow. */
const COMMAND_RUNNERS = new Set([
  "parallel",
  "xjobs",
  "osascript",
  "at",
  "batch",
  "crontab",
  "launchctl",
  "systemd-run",
  "expect",
  "tmux",
  "screen",
  "ed",
  "ex",
]);
const EDITORS = new Set(["vim", "vi", "nvim", "view", "gvim", "emacs"]);
const AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);
const INTERPRETERS: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
};
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "http", "https", "aria2c"]);
const PRIVILEGE = new Set(["sudo", "doas", "su", "pkexec", "runas"]);
const ENV_DUMPS = new Set(["printenv"]);
const PROTECTED_ENV = /^(AI_FACTORY_|GIT_CONFIG_|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$)/;
/**
 * Variables an agent may not set: they make trusted tools run other programs (git's
 * GIT_EXTERNAL_DIFF/GIT_SSH_COMMAND, pagers, editors, dynamic loaders, BASH_ENV) or move their
 * configuration (HOME, XDG_CONFIG_HOME, PATH).
 */
const DANGEROUS_ENV =
  /^(GIT_|AI_FACTORY_|OPENCODE_|SSH_|LD_|DYLD_)|^(PAGER|MANPAGER|EDITOR|VISUAL|BASH_ENV|ENV|HOME|ZDOTDIR|XDG_CONFIG_HOME|XDG_DATA_HOME|PATH|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|IFS|CDPATH|PS4)$/;

function checkSetEnv(name: string): void {
  if (PROTECTED_ENV.test(name)) block(`overrides the factory's environment (${name})`);
  if (DANGEROUS_ENV.test(name)) block(`setting ${name} is not allowed (it changes what tools run)`);
}
const SAFE_WRITE_TARGETS = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/** Literal text checks for code we cannot parse (inline Python/Node, interpreter scripts). */
function scanText(text: string): string | undefined {
  if (/\bgit\b[\s"',[\]()]+push\b/.test(text)) return "embedded code runs `git push`";
  if (/\b(curl|wget)\b[^\n|]*\|\s*(ba|z|da)?sh\b/.test(text))
    return "embedded code pipes a download into a shell";
  return undefined;
}

interface State {
  readonly ctx: ShellContext;
  readonly aliases: Map<string, string[]>;
  depth: number;
  /** Paths this command line writes (to catch write-then-execute in one go). */
  readonly written: Set<string>;
}

function home(state: State): string | undefined {
  return state.ctx.env?.HOME;
}

/** Resolves a path word; undefined when it depends on an unknown variable. */
function resolvePath(state: State, word: string): string | undefined {
  let w = word;
  if (w === "~" || w.startsWith("~/")) {
    const h = home(state);
    if (h === undefined) return undefined;
    w = h + w.slice(1);
  }
  w = w.replace(/\$\{?(HOME|TMPDIR|PWD)\}?/g, (m, name: string) => {
    if (name === "PWD") return state.ctx.cwd;
    return state.ctx.env?.[name] ?? m;
  });
  if (w.includes("$")) return undefined;
  return normalize(isAbsolute(w) ? w : resolve(state.ctx.cwd, w));
}

const within = (abs: string, dir: string): boolean => {
  const rel = relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function tempDirs(state: State): string[] {
  return ["/tmp", "/private/tmp", state.ctx.env?.TMPDIR]
    .filter((d): d is string => !!d)
    .map((d) => normalize(d));
}

/** A file the command writes: must be inside the root (or a temp dir), not protected or secret. */
function checkWrite(state: State, word: string, what: string): void {
  if (SAFE_WRITE_TARGETS.test(word)) return;
  const abs = resolvePath(state, word);
  if (abs === undefined) block(`${what} \`${word}\` depends on an unknown variable`);
  else {
    if (tempDirs(state).some((t) => within(abs, t))) return;
    if (!within(abs, state.ctx.root)) block(`${what} \`${word}\` is outside the session directory`);
    const rel = relative(state.ctx.root, abs);
    if (rel === "") block(`${what} the session directory itself`);
    if (isProtectedPath(rel)) block(`${what} protected path \`${rel}\``);
    if (isSecretPath(rel)) block(`${what} secret file \`${rel}\``);
    state.written.add(abs);
  }
}

/** Any argument that names a secret file blocks the command (read or write). */
function checkSecretArgs(words: readonly string[]): void {
  for (const w of words) {
    const value = w.startsWith("-") ? (w.includes("=") ? w.slice(w.indexOf("=") + 1) : "") : w;
    if (value !== "" && isSecretPath(value)) block(`touches secret file \`${value}\``);
  }
}

function checkRedirects(state: State, redirects: readonly Redirect[]): void {
  for (const r of redirects) {
    if (r.op === "<<" || r.op === "<<-" || r.op === "<<<") continue;
    if (r.op === ">&" || r.op === "<&") {
      if (/^\d+-?$|^-$/.test(r.target)) continue;
    }
    if (isSecretPath(r.target)) block(`redirects to or from secret file \`${r.target}\``);
    if (r.op !== "<") checkWrite(state, r.target, "writes");
  }
}

/** Splits `-abc` style flags and `--long[=value]`. */
const flags = (words: readonly string[]): Set<string> => {
  const out = new Set<string>();
  for (const w of words) {
    if (w === "--") break;
    if (w.startsWith("--")) out.add(w.split("=")[0] ?? w);
    else if (w.startsWith("-") && w.length > 1) for (const ch of w.slice(1)) out.add(`-${ch}`);
  }
  return out;
};

const positionals = (words: readonly string[]): string[] => {
  const out: string[] = [];
  let dashdash = false;
  for (const w of words) {
    if (!dashdash && w === "--") dashdash = true;
    else if (dashdash || !w.startsWith("-") || w === "-") out.push(w);
  }
  return out;
};

const GIT_READ_ONLY = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "grep",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "rev-parse",
  "rev-list",
  "merge-base",
  "cat-file",
  "describe",
  "shortlog",
  "show-ref",
  "for-each-ref",
  "name-rev",
  "check-ignore",
  "check-attr",
  "var",
  "help",
  "version",
  "whatchanged",
  "range-diff",
  "count-objects",
  "verify-commit",
  "verify-tag",
  "cherry",
  "show-branch",
  "hash-object",
  "archive",
  "format-patch",
  "annotate",
  "patch-id",
  "fsck",
]);
const GIT_LOCAL_WRITES = new Set([
  "add",
  "rm",
  "mv",
  "restore",
  "stash",
  "apply",
  "fetch",
  "commit",
  "clean",
  "reset",
  "checkout",
]);
/** `git -c` keys that only change presentation; everything else can run programs or move refs. */
const SAFE_GIT_CONFIG_KEYS =
  /^(color\.[a-z.]+|core\.quotepath|advice\.[a-z]+|log\.(date|decorate|abbrevcommit|follow|showroot|mailmap)|format\.pretty|grep\.(linenumber|patterntype|extendedregexp|fullname)|status\.(short|branch|showuntrackedfiles|relativepaths)|diff\.(noprefix|mnemonicprefix|renames|algorithm|context|interhunkcontext|relative|statgraphwidth|colormoved|indentheuristic|suppressblankempty|ignoresubmodules))$/i;

/** Subcommand options that run programs or write files outside the normal flow. */
function checkGitOptions(state: State, sub: string, rest: readonly string[], f: Set<string>): void {
  const has = (...names: string[]): boolean =>
    names.some((n) => f.has(n) || rest.some((a) => a.startsWith(`${n}=`)));
  if (has("--upload-pack", "--receive-pack", "--exec") || (sub === "ls-remote" && f.has("-u")))
    block(
      `git ${sub} with a program option (--upload-pack, --receive-pack, --exec) is not allowed`,
    );
  if (sub === "archive" && has("--remote")) block("git archive --remote is not allowed");
  if (sub === "grep" && (has("--open-files-in-pager") || rest.some((a) => /^-[^-]*O/.test(a))))
    block("git grep -O runs a pager program");
  if (sub === "apply" && f.has("--unsafe-paths"))
    block("git apply --unsafe-paths writes outside the repo");
  // Options that write files: check where.
  rest.forEach((a, i) => {
    let target: string | undefined;
    if (
      a === "--output" ||
      a === "--output-directory" ||
      (sub === "format-patch" && a === "-o") ||
      (sub === "archive" && a === "-o")
    )
      target = rest[i + 1];
    else if (a.startsWith("--output=") || a.startsWith("--output-directory="))
      target = a.slice(a.indexOf("=") + 1);
    if (target !== undefined) checkWrite(state, target, `git ${sub} writes`);
  });
}

function checkGit(state: State, args: readonly string[]): undefined {
  let i = 0;
  // Global options before the subcommand.
  while (i < args.length) {
    const a = args[i] ?? "";
    if (a === "-C") {
      const dir = args[i + 1] ?? "";
      const abs = resolvePath(state, dir);
      if (abs === undefined || !within(abs, state.ctx.root))
        block(`git -C \`${dir}\` points outside the session directory`);
      i += 2;
    } else if (a === "-c") {
      const kv = args[i + 1] ?? "";
      const key = kv.split("=")[0] ?? "";
      if (!SAFE_GIT_CONFIG_KEYS.test(key)) block(`git -c ${key} is not allowed`);
      i += 2;
    } else if (/^--(git-dir|work-tree|namespace|exec-path|config-env|super-prefix)/.test(a)) {
      block(`git ${a.split("=")[0]} is not allowed`);
    } else if (a.startsWith("-")) {
      i += 1;
    } else {
      break;
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined || sub === "--version" || sub === "--help") return;
  const f = flags(rest);
  const pos = positionals(rest);
  checkGitOptions(state, sub, rest, f);
  switch (sub) {
    case "push":
      return block("git push is not allowed: the factory never pushes");
    case "remote": {
      const action = pos[0];
      if (
        action === undefined ||
        ["show", "get-url"].includes(action) ||
        (f.has("-v") && pos.length === 0)
      )
        return;
      return block(`git remote ${action} changes remotes`);
    }
    case "config": {
      const writes = [
        "--unset",
        "--unset-all",
        "--remove-section",
        "--rename-section",
        "--add",
        "--replace-all",
        "--edit",
        "-e",
      ];
      if (
        writes.some((w) => f.has(w)) ||
        ["set", "unset", "rename-section", "remove-section", "edit"].includes(pos[0] ?? "")
      )
        return block("git config writes are not allowed");
      const reads = [
        "--get",
        "--get-all",
        "--get-regexp",
        "--list",
        "-l",
        "--get-urlmatch",
        "--show-origin",
        "--show-scope",
      ];
      if (reads.some((r) => f.has(r)) || pos[0] === "get" || pos[0] === "list" || pos.length === 1)
        return;
      return block("git config writes are not allowed");
    }
    case "fetch": {
      // Only `git fetch [options] [<remote>]`: refspecs can create, force or (with --prune) delete branches.
      const forcing = ["-f", "--force", "-u", "--update-head-ok", "--refmap"];
      if (forcing.some((x) => f.has(x)) || rest.some((a) => a.startsWith("--refmap")))
        return block("git fetch with refspec or force options rewrites branches");
      if (pos.length > 1)
        return block("git fetch with a refspec writes branches (fetch a remote by name)");
      const remote = pos[0];
      if (
        remote !== undefined &&
        (remote === "." || /[:/+*]/.test(remote) || remote.startsWith("."))
      )
        return block(
          "git fetch from a path or with a refspec is not allowed (fetch a remote by name)",
        );
      return;
    }
    case "difftool":
      return block("git difftool runs external tools");
    case "reset":
      if (f.has("--hard") || f.has("--merge") || f.has("--keep") || f.has("--soft"))
        return block(`git reset ${[...f].join(" ")} rewrites the branch`);
      if (rest.includes("--") || pos.length === 0 || (pos[0] === "HEAD" && pos.length > 1)) return;
      return block("git reset to another commit rewrites the branch");
    case "clean":
      if (f.has("-f") || f.has("--force")) return block("git clean -f deletes untracked files");
      return;
    case "checkout": {
      if (
        f.has("-f") ||
        f.has("--force") ||
        f.has("-b") ||
        f.has("-B") ||
        f.has("--orphan") ||
        f.has("--detach")
      ) {
        return block("git checkout may only restore files");
      }
      if (rest.includes("--")) return;
      const exists = state.ctx.exists;
      if (pos.length > 0 && exists && pos.every((p) => exists(resolvePath(state, p) ?? ""))) return;
      return block("git checkout may only restore files (use `git checkout -- <path>`)");
    }
    case "switch":
      return block("switching branches is the factory's job");
    case "branch": {
      const mutating = [
        "-d",
        "-D",
        "--delete",
        "-m",
        "-M",
        "--move",
        "-c",
        "-C",
        "--copy",
        "-f",
        "--force",
        "-u",
        "--set-upstream-to",
        "--unset-upstream",
        "--edit-description",
      ];
      if (mutating.some((m) => f.has(m))) return block("git branch may only list branches");
      if (
        pos.length > 0 &&
        !f.has("--list") &&
        !f.has("-l") &&
        !f.has("--contains") &&
        !f.has("--merged") &&
        !f.has("--no-merged") &&
        !f.has("--points-at")
      ) {
        return block("creating branches is the factory's job");
      }
      return;
    }
    case "tag":
      if (f.has("-d") || f.has("--delete") || f.has("-f") || f.has("--force"))
        return block("git tag deletion/force is not allowed");
      if (pos.length > 0 && !f.has("-l") && !f.has("--list"))
        return block("creating tags is not allowed");
      return;
    case "commit":
      if (f.has("--amend") || f.has("--fixup") || f.has("--squash"))
        return block("rewriting commits is not allowed");
      if (f.has("--no-verify") || f.has("-n")) return block("skipping commit hooks is not allowed");
      return;
    case "reflog":
      if (pos[0] === "expire" || pos[0] === "delete")
        return block("expiring the reflog destroys history");
      return;
    case "stash":
      if (pos[0] === "clear" || pos[0] === "drop")
        return block(`git stash ${pos[0]} discards work`);
      return;
    case "worktree":
      if (pos[0] === "list") return;
      return block("worktrees are managed by the factory");
    case "submodule":
      if (pos[0] === undefined || pos[0] === "status" || pos[0] === "summary") return;
      return block(`git submodule ${pos[0]} is managed by the factory`);
    case "lfs":
      if (["ls-files", "status", "env", "version"].includes(pos[0] ?? "")) return;
      return block(`git lfs ${pos[0] ?? ""} is not allowed`);
    case "gc":
    case "prune":
    case "repack":
      if ([...f].some((x) => x.startsWith("--prune")))
        return block("pruning objects destroys history");
      return sub === "prune" ? block("git prune destroys history") : undefined;
    case "rebase":
    case "filter-branch":
    case "filter-repo":
    case "replace":
    case "update-ref":
    case "symbolic-ref":
    case "merge":
    case "pull":
    case "cherry-pick":
    case "revert":
    case "am":
    case "bisect":
    case "init":
    case "clone":
    case "sparse-checkout":
    case "notes":
    case "mergetool":
    case "send-email":
    case "request-pull":
    case "daemon":
    case "http-push":
    case "send-pack":
      return block(
        `git ${sub} is not allowed for agents (history and branches belong to the factory)`,
      );
    default:
      if (GIT_READ_ONLY.has(sub) || GIT_LOCAL_WRITES.has(sub)) return;
      return block(`unknown git subcommand \`${sub}\` (git aliases are not allowed for agents)`);
  }
}

function checkRm(state: State, args: readonly string[]): undefined {
  for (const t of positionals(args)) {
    const abs = resolvePath(state, t);
    if (abs === undefined) block(`rm \`${t}\` depends on an unknown variable`);
    else if (!within(abs, state.ctx.root) && !tempDirs(state).some((d) => within(abs, d))) {
      block(`rm \`${t}\` is outside the session directory`);
    } else if (within(abs, state.ctx.root)) {
      const rel = relative(state.ctx.root, abs);
      if (rel === "" || rel === ".") block("rm of the whole session directory");
      if (isProtectedPath(rel)) block(`rm of protected path \`${rel}\``);
    }
  }
}

/** Inspects a script file the command executes. */
function checkScriptFile(state: State, word: string, interpreter: "shell" | "other"): undefined {
  const abs = resolvePath(state, word);
  if (abs === undefined) return block(`executes \`${word}\`, which depends on an unknown variable`);
  if (state.written.has(abs)) return block(`executes \`${word}\`, which this same command writes`);
  const text = state.ctx.readFile?.(abs);
  if (text === undefined) return; // missing or binary: nothing to inspect
  const shebang = text.startsWith("#!") ? (text.split("\n")[0] ?? "") : "";
  const isShell =
    interpreter === "shell" ? shebang === "" || /\b(sh|bash|zsh|dash|ksh)\b/.test(shebang) : false;
  if (isShell) {
    checkScript(state, text);
  } else {
    const found = scanText(text);
    if (found) block(`${word}: ${found}`);
  }
}

/**
 * `xargs` appends what it reads to the command. Literal input (`echo … |`) is appended and
 * checked like any argument; unknown input may only feed read-only commands.
 */
function xargs(state: State, rest: readonly string[], stdin: string | undefined | null): string[] {
  let i = 0;
  let replace: string | undefined;
  let argFile = false;
  while (i < rest.length && (rest[i] ?? "").startsWith("-")) {
    const a = rest[i] ?? "";
    if (a === "--") {
      i += 1;
      break;
    }
    if (a === "-I" || a === "--replace") {
      replace = rest[i + 1] ?? "{}";
      i += 2;
    } else if (a.startsWith("-I")) {
      replace = a.slice(2);
      i += 1;
    } else if (a.startsWith("--replace=")) {
      replace = a.slice("--replace=".length);
      i += 1;
    } else if (/^-i/.test(a)) {
      replace = a.length > 2 ? a.slice(2) : "{}";
      i += 1;
    } else if (a === "-a" || a === "--arg-file" || a.startsWith("--arg-file=")) {
      argFile = true;
      i += a.includes("=") ? 1 : 2;
    } else {
      i +=
        /^-[dEnLPs]$/.test(a) ||
        /^--(delimiter|eof|max-args|max-lines|max-procs|max-chars)$/.test(a)
          ? 2
          : 1;
    }
  }
  const cmd = rest.slice(i).length > 0 ? rest.slice(i) : ["echo"];
  const base = (cmd[0] ?? "").slice((cmd[0] ?? "").lastIndexOf("/") + 1);
  if (typeof stdin !== "string" || argFile) {
    if (!XARGS_SAFE.has(base))
      block(`xargs feeds input it cannot see to \`${base}\` (use find -exec or list the files)`);
    return cmd;
  }
  if (replace !== undefined) {
    const marker = replace;
    for (const line of stdin.split("\n").filter((l) => l.trim() !== "")) {
      checkSimple(
        state,
        {
          kind: "simple",
          assigns: [],
          words: cmd.map((word) => word.split(marker).join(line)),
          redirects: [],
          substitutions: [],
        },
        undefined,
      );
    }
    return [];
  }
  return [...cmd, ...stdin.split(/\s+/).filter(Boolean)];
}

function unwrap(state: State, words: string[], stdin: string | undefined | null): string[] {
  // Returns the words of the command that actually runs, checking wrappers on the way.
  let w = words;
  for (let guard = 0; guard < 20 && w.length > 0; guard++) {
    const [head = "", ...rest] = w;
    const alias = state.aliases.get(head);
    if (alias) {
      state.aliases.delete(head); // no recursion through the same alias
      w = [...alias, ...rest];
      continue;
    }
    const base = head.slice(head.lastIndexOf("/") + 1);
    if (PRIVILEGE.has(base)) return block(`${base} is not allowed`);
    if (base === "env") {
      let i = 0;
      while (i < rest.length) {
        const a = rest[i] ?? "";
        if (a === "-u" || a === "--unset") {
          if (PROTECTED_ENV.test(rest[i + 1] ?? ""))
            block(`unsets the factory's environment (${rest[i + 1]})`);
          i += 2;
        } else if (a.startsWith("--unset=")) {
          if (PROTECTED_ENV.test(a.slice(8))) block("unsets the factory's environment");
          i += 1;
        } else if (a === "-C" || a === "--chdir") i += 2;
        else if (a === "-S" || a === "--split-string") {
          w = [...(rest[i + 1] ?? "").split(/\s+/).filter(Boolean), ...rest.slice(i + 2)];
          i = -1;
          break;
        } else if (a.startsWith("-")) i += 1;
        else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
          checkSetEnv(a.split("=")[0] ?? "");
          i += 1;
        } else break;
      }
      if (i === -1) continue;
      if (i >= rest.length) return block("printing the environment may expose secrets");
      w = rest.slice(i);
      continue;
    }
    if (base === "busybox") {
      w = rest; // `busybox <applet> …` runs the applet
      continue;
    }
    if (
      [
        "nohup",
        "time",
        "command",
        "builtin",
        "exec",
        "chronic",
        "caffeinate",
        "unbuffer",
        "setsid",
      ].includes(base)
    ) {
      if (base === "command" && (rest[0] === "-v" || rest[0] === "-V")) return [];
      let i = 0;
      while (i < rest.length && (rest[i] ?? "").startsWith("-")) {
        if (rest[i] === "--") {
          i += 1;
          break;
        }
        i += base === "exec" && rest[i] === "-a" ? 2 : 1; // `exec -a NAME`
      }
      w = rest.slice(i);
      continue;
    }
    if (
      base === "nice" ||
      base === "ionice" ||
      base === "stdbuf" ||
      base === "timeout" ||
      base === "flock"
    ) {
      let i = 0;
      while (i < rest.length && (rest[i] ?? "").startsWith("-")) {
        const a = rest[i] ?? "";
        i +=
          /^-(n|c|p|k|s|i|o|e|w)$/.test(a) ||
          ["--signal", "--kill-after", "--adjustment"].includes(a)
            ? 2
            : 1;
      }
      if (base === "timeout") i += 1; // duration
      if (base === "flock") {
        const c = rest.indexOf("-c");
        if (c !== -1) {
          checkScript(state, rest[c + 1] ?? "");
          return [];
        }
        i += 1; // lock file
      }
      w = rest.slice(i);
      continue;
    }
    if (base === "xargs") return xargs(state, rest, stdin);
    if (base === "watch") {
      let i = 0;
      while (i < rest.length && (rest[i] ?? "").startsWith("-"))
        i += /^-(n|d)$/.test(rest[i] ?? "") ? 2 : 1;
      checkScript(state, rest.slice(i).join(" "));
      return [];
    }
    return w;
  }
  return w;
}

/** awk programs may run commands (`system`, pipes, `getline`) or write files (`>`). */
function checkAwk(state: State, args: readonly string[]): void {
  let program: string | undefined;
  let inplace = false;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-F" || a === "-v") i += 1;
    else if (a === "-f" || a === "--file") {
      program = state.ctx.readFile?.(resolvePath(state, args[i + 1] ?? "") ?? "") ?? "";
      i += 1;
    } else if (a === "-i" || a === "--include") {
      if (args[i + 1] === "inplace") inplace = true;
      i += 1;
    } else if (a.startsWith("-")) continue;
    else if (program === undefined) program = a;
    else files.push(a);
  }
  const text = program ?? "";
  if (/\bsystem\s*\(|\|\s*&?\s*["$a-zA-Z_]|"\s*\|&?\s*getline|\bgetline\b[^;]*</.test(text))
    block("awk program runs commands (system, pipes or getline)");
  if (/>{1,2}\s*(?!"\/dev\/(stderr|stdout|null)")["$a-zA-Z_]/.test(text.replace(/"[^"]*"/g, '""')))
    block("awk program writes files (use shell redirection instead)");
  const found = scanText(text);
  if (found) block(found);
  if (inplace) for (const f of files) checkWrite(state, f, "edits");
}

/** sed scripts may execute commands (`e`, `s///e`), write (`w`, `W`) or read (`r`, `R`) files. */
function checkSed(state: State, args: readonly string[]): void {
  const scripts: string[] = [];
  let explicit = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-e" || a === "--expression") {
      scripts.push(args[i + 1] ?? "");
      explicit = true;
      i += 1;
    } else if (a.startsWith("--expression=")) {
      scripts.push(a.slice("--expression=".length));
      explicit = true;
    } else if (a === "-f" || a === "--file") {
      scripts.push(state.ctx.readFile?.(resolvePath(state, args[i + 1] ?? "") ?? "") ?? "");
      explicit = true;
      i += 1;
    }
  }
  if (!explicit) {
    const first = positionals(args)[0];
    if (first !== undefined) scripts.push(first);
  }
  for (const script of scripts) {
    // s/…/…/flags: an `e` flag executes the pattern space; a `w` flag writes a file.
    for (const m of script.matchAll(
      /s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1([a-zA-Z0-9]*)\s*([^;\n}]*)/g,
    )) {
      const flagText = m[2] ?? "";
      if (flagText.includes("e")) block("sed s///e executes commands");
      if (flagText.includes("w")) checkWrite(state, (m[3] ?? "").trim(), "sed writes");
    }
    const withoutS = script.replace(/s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-zA-Z0-9]*/g, "");
    for (const m of withoutS.matchAll(
      /(?:^|[;\n{}])\s*(?:[0-9$]+|\/[^/]*\/)?(?:\s*,\s*(?:[0-9$]+|\/[^/]*\/))?\s*!?\s*([ewWrR])(?:\s+([^;\n}]*))?/g,
    )) {
      const op = m[1];
      const target = (m[2] ?? "").trim();
      if (op === "e") block("sed e executes commands");
      if ((op === "w" || op === "W") && target !== "") checkWrite(state, target, "sed writes");
      if ((op === "r" || op === "R") && isSecretPath(target))
        block(`sed reads secret file \`${target}\``);
    }
  }
}

function checkSimple(
  state: State,
  cmd: SimpleCommand,
  stdin: string | undefined | null,
): undefined {
  for (const sub of cmd.substitutions) checkScriptAst(state, sub);
  checkRedirects(state, cmd.redirects);
  for (const a of cmd.assigns) checkSetEnv(a.split("=")[0] ?? "");
  const words = unwrap(state, cmd.words, stdin);
  if (words.length === 0) return;
  checkSecretArgs(words);
  const [head = "", ...args] = words;
  if (head.includes("$")) block(`runs a command whose name is generated at run time (\`${head}\`)`);
  const base = head.slice(head.lastIndexOf("/") + 1);
  const heredoc = cmd.redirects.find((r) => r.body !== undefined)?.body;

  if (base === "alias") {
    for (const def of args) {
      const m = def.match(/^([^=]+)=(.*)$/s);
      if (m?.[1] && m[2] !== undefined) {
        const value = m[2];
        checkScript(state, value);
        state.aliases.set(m[1], value.split(/\s+/).filter(Boolean));
      }
    }
    return;
  }
  if (
    base === "unset" ||
    base === "export" ||
    base === "declare" ||
    base === "typeset" ||
    base === "readonly"
  ) {
    if (args.length === 0 || args.every((a) => a.startsWith("-")))
      block(`${base} without names dumps the environment`);
    for (const a of args.filter((x) => !x.startsWith("-"))) {
      const name = a.split("=")[0] ?? "";
      if (base === "unset" ? PROTECTED_ENV.test(name) : DANGEROUS_ENV.test(name))
        block(`changes the factory's environment (${name})`);
    }
    return;
  }
  if (base === "set" && args.length === 0) block("set without arguments dumps the environment");
  if (ENV_DUMPS.has(base)) block("printing the environment may expose secrets");

  const inputFile = cmd.redirects.find((r) => r.op === "<" || r.op === "<>")?.target;
  if (SHELLS.has(base)) {
    // Options first: -c makes the first operand the script, -s reads the script from stdin.
    let c = false;
    let fromStdin = false;
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a === "--" || a === "-") {
        i += 1;
        break;
      }
      if (a === "-o" || a === "+o" || a === "--rcfile" || a === "--init-file") {
        i += 1;
        continue;
      }
      if (/^[-+][A-Za-z]+$/.test(a)) {
        if (a.startsWith("-") && a.includes("c")) c = true;
        if (a.startsWith("-") && a.includes("s")) fromStdin = true;
        continue;
      }
      if (a.startsWith("--")) continue;
      break;
    }
    const operand = args[i];
    if (c) return checkScript(state, operand ?? "");
    if (!fromStdin && operand !== undefined) return checkScriptFile(state, operand, "shell");
    if (heredoc !== undefined) return checkScript(state, heredoc);
    if (inputFile !== undefined) return checkScriptFile(state, inputFile, "shell");
    if (stdin === null) block(`pipes generated input into ${base}`);
    if (stdin !== undefined) checkScript(state, stdin);
    return;
  }
  if (base === "source" || base === ".") {
    if (args[0] !== undefined) checkScriptFile(state, args[0], "shell");
    return;
  }
  if (base === "eval") return checkScript(state, args.join(" "));
  const inline = INTERPRETERS[base.replace(/\d+(\.\d+)*$/, "")] ?? INTERPRETERS[base];
  if (inline) {
    const i = args.findIndex((a) => inline.includes(a));
    const joined = args.find((a) =>
      inline.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)),
    );
    if (i !== -1 || joined !== undefined) {
      const code =
        joined !== undefined ? joined.slice(joined.indexOf("=") + 1) : (args[i + 1] ?? "");
      const found = scanText(code);
      if (found) block(found);
      return;
    }
    const file = args.find((a) => !a.startsWith("-"));
    if (file !== undefined) return checkScriptFile(state, file, "other");
    // `python3 -`, `node -` or no operand: the program comes from stdin.
    if (heredoc !== undefined) {
      const found = scanText(heredoc);
      if (found) block(found);
      return;
    }
    if (inputFile !== undefined) return checkScriptFile(state, inputFile, "other");
    if (stdin === null) block(`pipes generated input into ${base}`);
    if (stdin !== undefined) {
      const found = scanText(stdin);
      if (found) block(found);
    }
    return;
  }
  if (COMMAND_RUNNERS.has(base)) block(`${base} runs commands the factory cannot inspect`);
  if (EDITORS.has(base) && args.some((a) => /^(-c|--cmd|-S|-s|\+.*|--eval|-l|--load|-x)$/.test(a)))
    block(`${base} with commands is not allowed (edit files directly)`);
  if (AWKS.has(base)) checkAwk(state, args);
  if (base === "sed" || base === "gsed") checkSed(state, args);
  if (base === "script") {
    const c = args.findIndex((a) => a === "-c" || a === "--command");
    if (c !== -1) return checkScript(state, args[c + 1] ?? "");
  }
  if (base === "fd" || base === "fdfind") {
    const x = args.findIndex((a) => ["-x", "--exec", "-X", "--exec-batch"].includes(a));
    if (x !== -1) {
      checkSimple(
        state,
        { kind: "simple", assigns: [], words: args.slice(x + 1), redirects: [], substitutions: [] },
        undefined,
      );
      return;
    }
  }
  if (head.includes("/")) checkScriptFile(state, head, "shell");

  switch (base) {
    case "git":
      return checkGit(state, args);
    case "rm":
    case "rmdir":
    case "unlink":
    case "shred":
      return checkRm(state, args);
    case "find": {
      const exec = args.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
      if (exec !== -1) {
        const end = args.findIndex((a, i) => i > exec && (a === ";" || a === "+"));
        checkSimple(
          state,
          {
            kind: "simple",
            assigns: [],
            words: args.slice(exec + 1, end === -1 ? undefined : end),
            redirects: [],
            substitutions: [],
          },
          undefined,
        );
      }
      if (args.includes("-delete"))
        for (const p of args.filter((a) => !a.startsWith("-")).slice(0, 1)) checkRm(state, [p]);
      return;
    }
    case "tee":
      for (const p of positionals(args)) checkWrite(state, p, "writes");
      return;
    case "cp":
    case "install":
    case "ln":
    case "rsync": {
      const p = positionals(args);
      const dest = p.at(-1);
      if (dest !== undefined && p.length > 1) checkWrite(state, dest, "writes");
      return;
    }
    case "mv":
      for (const p of positionals(args)) checkWrite(state, p, "moves");
      return;
    case "touch":
    case "mkdir":
    case "truncate":
    case "chmod":
    case "chown":
    case "chgrp": {
      const p = positionals(args);
      for (const t of base === "chmod" || base === "chown" || base === "chgrp" ? p.slice(1) : p)
        checkWrite(state, t, "writes");
      return;
    }
    case "sed":
    case "perl":
      if (flags(args).has("-i") || args.some((a) => a.startsWith("-i"))) {
        for (const p of positionals(args).slice(1)) checkWrite(state, p, "edits");
      }
      return;
    case "dd":
      for (const a of args.filter((x) => x.startsWith("of=")))
        checkWrite(state, a.slice(3), "writes");
      return;
    case "graphify": {
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub && ["query", "explain", "path", "affected", "god-nodes"].includes(sub)) return;
      return block(`graphify ${sub ?? ""} is not allowed: the factory updates the graph`);
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (
        args.some(
          (a) =>
            a === "publish" ||
            a === "login" ||
            a === "adduser" ||
            a === "unpublish" ||
            a === "deprecate",
        )
      ) {
        return block(`${base} publishing is not allowed`);
      }
      return;
    case "cargo":
    case "twine":
    case "gem":
    case "poetry":
    case "uv":
      if (args.some((a) => a === "publish" || a === "upload" || a === "push" || a === "yank"))
        return block(`${base} publishing is not allowed`);
      return;
    case "gh":
    case "glab":
      return block(`${base} is not available to agents (no MRs, no remote changes)`);
    case "ssh":
    case "scp":
    case "sftp":
      return block(`${base} is not allowed`);
    default:
      return;
  }
}

function literalOutput(cmd: Command): string | undefined {
  // `echo …` / `printf …` with literal arguments: we know what goes down the pipe.
  if (cmd.kind !== "simple" || cmd.substitutions.length > 0) return undefined;
  const [head, ...args] = cmd.words;
  if (head === "echo") return args.filter((a) => !/^-[neE]+$/.test(a)).join(" ");
  if (head === "printf") return args[0]?.replace(/\\n/g, "\n");
  if (head === "cat" && args.length === 0)
    return cmd.redirects.find((r) => r.body !== undefined)?.body;
  return undefined;
}

function checkPipeline(state: State, pipeline: Pipeline): void {
  const { commands } = pipeline;
  commands.forEach((cmd, i) => {
    // stdin of a pipe stage: known text, null (generated, unknown) or undefined (none).
    const prev = commands[i - 1];
    let stdin: string | undefined | null;
    if (prev !== undefined) {
      const prevWords = prev.kind === "simple" ? prev.words : [];
      const prevBase = (prevWords[0] ?? "").slice((prevWords[0] ?? "").lastIndexOf("/") + 1);
      if (DOWNLOADERS.has(prevBase) && cmd.kind === "simple") {
        const base = (cmd.words[0] ?? "").slice((cmd.words[0] ?? "").lastIndexOf("/") + 1);
        if (SHELLS.has(base) || base in INTERPRETERS || base === "eval" || base === "source") {
          block(`pipes a download (${prevBase}) into ${base}`);
        }
      }
      stdin = literalOutput(prev) ?? null;
    }
    if (cmd.kind === "subshell") {
      checkRedirects(state, cmd.redirects);
      checkScriptAst(state, cmd.script);
    } else {
      checkSimple(state, cmd, stdin);
    }
  });
}

function checkScriptAst(state: State, script: Script): void {
  if (++state.depth > 25) block("command nests too deeply to inspect");
  try {
    for (const p of script.pipelines) checkPipeline(state, p);
  } finally {
    state.depth--;
  }
}

function checkScript(state: State, text: string): undefined {
  checkScriptAst(state, parseScript(text));
  return undefined;
}

export function checkShell(command: string, ctx: ShellContext): ShellVerdict {
  const state: State = { ctx, aliases: new Map(), depth: 0, written: new Set() };
  try {
    checkScript(state, command);
    return { allowed: true };
  } catch (err) {
    if (err instanceof Blocked) return { allowed: false, reason: err.message };
    if (err instanceof ShellParseError)
      return { allowed: false, reason: `cannot parse the command (${err.message}); simplify it` };
    throw err;
  }
}
