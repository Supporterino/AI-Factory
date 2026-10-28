import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { isProtectedPath, isSecretPath } from "./paths.ts";
import { findSecretUnder, globMatchesSecret, mentionedSecret } from "./secrets.ts";
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
  /** Lists a directory (glob words and recursive searches are checked for secret files). */
  readonly readdir?: (abs: string) => readonly string[] | undefined;
  /** For `~` / `$HOME` / `$TMPDIR` resolution. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Resolves symlinks (see realpath.ts); without it, paths are judged lexically. */
  readonly realpath?: (abs: string) => string;
  /** The workspace root: never writable outside `root`, even when it lies under a temp dir. */
  readonly workspace?: string;
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

/**
 * OS-managed read-only trees. Recursive searches there are read-only queries, and the few
 * secret-looking files inside them (certificates, editor configs) are not the user's
 * credentials. Explicit secret paths are still blocked by name.
 */
const SYSTEM_READ_ROOTS = ["/Applications", "/Library", "/System", "/usr", "/opt"] as const;
const isSystemReadRoot = (abs: string): boolean =>
  SYSTEM_READ_ROOTS.some((root) => abs === root || abs.startsWith(`${root}/`));

/** Homebrew commands that inspect installed state or formula metadata only. */
const BREW_READ_ONLY_FLAGS = new Set([
  "--prefix",
  "--cellar",
  "--repository",
  "--cache",
  "--env",
  "--version",
  "--help",
]);
const BREW_READ_ONLY_SUBCOMMANDS = new Set([
  "info",
  "list",
  "ls",
  "search",
  "deps",
  "uses",
  "leaves",
  "outdated",
  "config",
  "commands",
  "desc",
  "cat",
  "log",
  "tap-info",
]);
const BREW_GLOBAL_FLAGS = new Set(["-v", "--verbose", "-d", "--debug", "-q", "--quiet"]);

/**
 * Literal text checks for code we cannot parse (inline Python/Node, interpreter scripts).
 * Adjacent string literals joined with `+` are joined first (`'git pu'+'sh'`, audit S14).
 */
function scanText(text: string): string | undefined {
  for (const t of [text, text.replace(/(['"`])\s*\+\s*\1/g, "")]) {
    if (/\bgit\b[\s"',[\]()]+push\b/.test(t)) return "embedded code runs `git push`";
    if (/\b(curl|wget)\b[^\n|]*\|\s*(ba|z|da)?sh\b/.test(t))
      return "embedded code pipes a download into a shell";
  }
  return undefined;
}

/** Inline code (`-c`, `-e`, here-docs, stdin) is also checked for secret file names (S11). */
function scanInline(code: string): string | undefined {
  const found = scanText(code);
  if (found !== undefined) return found;
  const secret = mentionedSecret(code);
  return secret === undefined ? undefined : `embedded code reads secret file \`${secret}\``;
}

interface State {
  readonly ctx: ShellContext;
  readonly aliases: Map<string, string[]>;
  depth: number;
  /** The directory the next command runs in; undefined once `cd` went somewhere unknown. */
  cwd: string | undefined;
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
    if (name === "PWD") return state.cwd ?? m;
    return state.ctx.env?.[name] ?? m;
  });
  if (w.includes("$")) return undefined;
  if (isAbsolute(w)) return normalize(w);
  return state.cwd === undefined ? undefined : normalize(resolve(state.cwd, w));
}

const real = (state: State, abs: string): string => state.ctx.realpath?.(abs) ?? abs;

const within = (abs: string, dir: string): boolean => {
  const rel = relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function tempDirs(state: State): string[] {
  return ["/tmp", "/private/tmp", state.ctx.env?.TMPDIR]
    .filter((d): d is string => !!d)
    .flatMap((d) => [normalize(d), real(state, normalize(d))]);
}

/** Where a path really is (symlinks resolved), relative to the real session root if inside it. */
function locate(state: State, abs: string): { real: string; rel?: string; temp: boolean } {
  const target = real(state, abs);
  const root = real(state, state.ctx.root);
  if (within(target, root)) return { real: target, rel: relative(root, target), temp: false };
  const ws = state.ctx.workspace;
  if (ws !== undefined && within(target, real(state, ws))) return { real: target, temp: false };
  return { real: target, temp: tempDirs(state).some((t) => within(target, t)) };
}

/** A file the command writes: must be inside the root (or a temp dir), not protected or secret. */
function checkWrite(state: State, word: string, what: string): void {
  if (SAFE_WRITE_TARGETS.test(word)) return;
  const abs = resolvePath(state, word);
  if (abs === undefined) block(`${what} \`${word}\` depends on an unknown variable or directory`);
  const where = locate(state, abs);
  if (where.rel === undefined) {
    if (!where.temp) block(`${what} \`${word}\` is outside the session directory`);
  } else {
    if (where.rel === "") block(`${what} the session directory itself`);
    if (isProtectedPath(where.rel)) block(`${what} protected path \`${where.rel}\``);
    if (isSecretPath(where.rel)) block(`${what} secret file \`${where.rel}\``);
  }
  state.written.add(abs);
  state.written.add(where.real);
}

/** `cd`/`pushd`/`env -C`: the new directory must stay inside the session (or a temp dir). */
function changeDir(state: State, word: string | undefined): void {
  if (word === "-") {
    state.cwd = undefined;
    return;
  }
  const abs = resolvePath(state, word ?? "~");
  if (abs === undefined) {
    state.cwd = undefined;
    return;
  }
  const where = locate(state, abs);
  if (where.rel === undefined && !where.temp)
    block(`cd \`${word ?? "~"}\` leaves the session directory`);
  state.cwd = abs;
}

/** Values of options such as `-o FILE`, `-oFILE`, `--output FILE` and `--output=FILE`. */
function optionValues(args: readonly string[], short: string, long: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") break;
    const eq = long.find((l) => a.startsWith(`${l}=`));
    if (eq !== undefined) out.push(a.slice(eq.length + 1));
    else if (long.includes(a)) out.push(args[++i] ?? "");
    else if (/^-[A-Za-z]/.test(a) && !a.startsWith("--")) {
      const j = a.indexOf(short, 1);
      if (short !== "" && j !== -1) {
        const attached = a.slice(j + 1);
        out.push(attached !== "" ? attached : (args[++i] ?? ""));
      }
    }
  }
  return out;
}

/**
 * Any argument that names a secret file blocks the command (read or write): by name, inside a
 * git object (`HEAD:.env`), or through a glob that matches one (audit S11).
 */
function checkSecretArgs(state: State, words: readonly string[]): void {
  for (const w of words) {
    const value = w.startsWith("-") ? (w.includes("=") ? w.slice(w.indexOf("=") + 1) : "") : w;
    if (value === "") continue;
    if (isSecretPath(value)) block(`touches secret file \`${value}\``);
    const object = value.match(/^[^\s:/]*:([^/].*)$/)?.[1];
    if (object !== undefined && isSecretPath(object))
      block(`reads secret file \`${object}\` from git`);
    if (/[*?[]/.test(value)) {
      const abs = resolvePath(state, value);
      const hit = abs === undefined ? undefined : globMatchesSecret(abs, state.ctx.readdir);
      if (hit !== undefined) block(`the pattern \`${value}\` matches secret file \`${hit}\``);
    }
  }
}

/** Recursive searches (`grep -r`, `rg --hidden`) must not run over secret files (S11). */
function checkRecursiveSearch(state: State, base: string, args: readonly string[]): void {
  const f = flags(args);
  const pos = positionals(args);
  let roots: string[];
  if (base === "grep" || base === "egrep" || base === "fgrep") {
    const recursive =
      f.has("-r") ||
      f.has("-R") ||
      f.has("--recursive") ||
      f.has("--dereference-recursive") ||
      optionValues(args, "d", ["--directories"]).includes("recurse");
    if (!recursive) return;
    const explicit = f.has("-e") || f.has("-f") || f.has("--regexp") || f.has("--file");
    roots = explicit ? pos : pos.slice(1);
  } else {
    // rg and ag skip hidden files unless told otherwise; secret files are mostly hidden.
    const unrestricted = args
      .filter((a) => /^-[A-Za-z]+$/.test(a))
      .reduce((n, a) => n + (a.match(/u/g)?.length ?? 0), 0);
    const hidden = f.has("--hidden") || f.has("-.") || f.has("--unrestricted") || unrestricted >= 2;
    if (!hidden) return;
    roots = pos.slice(1);
  }
  const readdir = state.ctx.readdir;
  if (readdir === undefined) return;
  for (const root of roots.length > 0 ? roots : ["."]) {
    const abs = resolvePath(state, root);
    if (abs === undefined) continue;
    // A read-only query over an OS tree: skip the secret walk, but explicit secret args
    // (`grep TOKEN ~/.ssh/id_rsa`) are still blocked before this point.
    if (isSystemReadRoot(abs)) continue;
    const found = findSecretUnder(abs, readdir);
    if (found !== undefined)
      block(
        `searches \`${root}\`, which contains secret file \`${found}\`; search specific directories instead`,
      );
  }
}

/** A project script `npm run X` / `pnpm X` / `yarn X` / `bun run X` runs (with pre/post). */
function checkPackageScript(state: State, tool: string, args: readonly string[]): void {
  const pos = positionals(args);
  const sub = pos[0];
  if (sub === undefined || state.cwd === undefined) return;
  const text = state.ctx.readFile?.(join(state.cwd, "package.json"));
  let scripts: Record<string, unknown> = {};
  try {
    scripts =
      (text === undefined
        ? {}
        : (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts) ?? {};
  } catch {
    return;
  }
  const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
  const NPM_LIFECYCLE: Record<string, string> = {
    test: "test",
    t: "test",
    tst: "test",
    start: "start",
    stop: "stop",
    restart: "restart",
  };
  let name: string | undefined;
  if (tool === "npm") name = NPM_RUN.has(sub) ? pos[1] : NPM_LIFECYCLE[sub];
  else if (sub === "run") name = pos[1];
  else if (sub in scripts) name = sub;
  else if (tool === "bun" && /\.[cm]?[jt]sx?$/.test(sub)) {
    checkScriptFile(state, sub, "other");
    return;
  }
  if (name === undefined) return;
  if (tool === "bun" && !(name in scripts) && /\.[cm]?[jt]sx?$/.test(name)) {
    checkScriptFile(state, name, "other");
    return;
  }
  for (const key of [`pre${name}`, name, `post${name}`]) {
    const body = scripts[key];
    if (typeof body === "string") checkScript(state, body);
  }
}

interface MakeRule {
  readonly prereqs: string[];
  readonly recipe: string[];
}

function parseMakefile(text: string): {
  vars: Map<string, string>;
  rules: Map<string, MakeRule>;
  first?: string;
} {
  const vars = new Map<string, string>();
  const rules = new Map<string, MakeRule>();
  let first: string | undefined;
  let current: MakeRule[] = [];
  for (const line of text.replace(/\\\n/g, " ").split("\n")) {
    if (line.startsWith("\t")) {
      for (const r of current) r.recipe.push(line.slice(1));
      continue;
    }
    if (/^\s*(#|$)/.test(line)) continue;
    const assign = line.match(
      /^(?:export\s+|override\s+)?([A-Za-z_][\w.-]*)\s*(?:\?|:|::|\+|!)?=\s*(.*)$/,
    );
    if (assign?.[1] !== undefined) {
      vars.set(assign[1], (assign[2] ?? "").trim());
      current = [];
      continue;
    }
    const rule = line.match(/^([^:#=\t][^:#=]*?)\s*::?(?!=)\s*([^;#]*)(?:;(.*))?$/);
    if (rule?.[1] === undefined) {
      current = [];
      continue;
    }
    const prereqs = (rule[2] ?? "").replace("|", " ").split(/\s+/).filter(Boolean);
    current = rule[1]
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => {
        const r = rules.get(t) ?? { prereqs: [], recipe: [] };
        r.prereqs.push(...prereqs);
        if (rule[3] !== undefined) r.recipe.push(rule[3]);
        rules.set(t, r);
        if (first === undefined && !t.startsWith(".") && !t.includes("%")) first = t;
        return r;
      });
  }
  return first === undefined ? { vars, rules } : { vars, rules, first };
}

/** Stands in for make's `$$` while variables are expanded. */
const DOLLAR = "\uE000";

/** `make [target…]`: the recipes it runs, with simple variables expanded (audit S14). */
function checkMake(state: State, args: readonly string[]): void {
  const dir = optionValues(args, "C", ["--directory"]).at(-1);
  const file = optionValues(args, "f", ["--file", "--makefile"]).at(-1);
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (["-C", "-f", "-I", "-o", "-W", "--directory", "--file", "--makefile"].includes(a)) i++;
    else if (!a.startsWith("-") && !a.includes("=")) targets.push(a);
  }
  const base = dir === undefined ? state.cwd : resolvePath(state, dir);
  if (base === undefined) return;
  const names = file !== undefined ? [file] : ["GNUmakefile", "makefile", "Makefile"];
  const text = names
    .map((n) => state.ctx.readFile?.(resolve(base, n)))
    .find((t) => t !== undefined);
  if (text === undefined) return;
  const { vars, rules, first } = parseMakefile(text);
  const expand = (line: string): string => {
    let out = line.replaceAll("$$", DOLLAR);
    for (let k = 0; k < 5; k++)
      out = out.replace(/\$[({]([A-Za-z_][\w.-]*)[)}]/g, (m, v: string) => vars.get(v) ?? m);
    return out;
  };
  const seen = new Set<string>();
  const visit = (target: string): void => {
    if (seen.has(target) || seen.size > 200) return;
    seen.add(target);
    const rule = rules.get(target);
    if (rule === undefined) return;
    for (const p of rule.prereqs) visit(p);
    for (const raw of rule.recipe) {
      const line = expand(raw.replace(/^[\s@+-]+/, ""));
      if (/\$[({]/.test(line)) {
        const found = scanText(line);
        if (found) block(`make ${target}: ${found}`);
      } else checkScript(state, line.replaceAll(DOLLAR, "$"));
    }
  };
  for (const t of targets.length > 0 ? targets : first === undefined ? [] : [first]) visit(t);
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

/** perl/ruby `-i`, `-pi`, `-i.bak` (not `-I`, which takes an include dir). */
const isInPlaceFlag = (a: string): boolean =>
  /^-[a-zA-Z]*i/.test(a) && !a.startsWith("--") && !/^-[IMx]/.test(a);

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
    case "rm":
      for (const p of pos) {
        const abs = resolvePath(state, p);
        if (abs === undefined) return block(`git rm \`${p}\` depends on an unknown variable`);
        const where = locate(state, abs);
        if (where.rel === undefined)
          return block(`git rm \`${p}\` is outside the session directory`);
        if (isProtectedPath(where.rel)) return block(`git rm of protected path \`${where.rel}\``);
      }
      return;
    case "mv":
      for (const p of pos) checkWrite(state, p, "git mv");
      return;
    case "commit":
      return block("the factory commits your work after the gates pass; do not commit yourself");
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
    if (abs === undefined) return block(`rm \`${t}\` depends on an unknown variable or directory`);
    // The link itself is removed, not its target: judge the parent's real location.
    const where = locate(state, join(real(state, dirname(abs)), basename(abs)));
    if (where.rel === undefined) {
      if (!where.temp) block(`rm \`${t}\` is outside the session directory`);
    } else {
      if (where.rel === "" || where.rel === ".") block("rm of the whole session directory");
      if (isProtectedPath(where.rel)) block(`rm of protected path \`${where.rel}\``);
    }
  }
}

/** `ln`: the link is a write, and its target must not lead out of the session or into protected files. */
function checkLn(state: State, args: readonly string[]): void {
  const symbolic = flags(args).has("-s") || flags(args).has("--symbolic");
  const dir = optionValues(args, "t", ["--target-directory"])[0];
  const p = positionals(args).filter((x) => x !== dir);
  const pairs: { target: string; link: string }[] =
    dir !== undefined
      ? p.map((t) => ({ target: t, link: join(dir, basename(t)) }))
      : p.length === 1
        ? [{ target: p[0] ?? "", link: basename(p[0] ?? "") }]
        : p.slice(0, -1).map((t) => ({
            target: t,
            link: p.length > 2 ? join(p.at(-1) ?? "", basename(t)) : (p.at(-1) ?? ""),
          }));
  for (const { target, link } of pairs) {
    checkWrite(state, link, "ln creates");
    const linkAbs = resolvePath(state, link);
    // A relative symlink target is resolved from the link's directory, a hard link's from cwd.
    const targetAbs =
      symbolic && !isAbsolute(target) && !target.startsWith("~") && !target.startsWith("$")
        ? linkAbs === undefined
          ? undefined
          : resolve(dirname(linkAbs), target)
        : resolvePath(state, target);
    if (targetAbs === undefined) block(`ln target \`${target}\` depends on an unknown variable`);
    const where = locate(state, targetAbs);
    if (where.rel === undefined && !where.temp)
      block(`ln \`${target}\` would point outside the session directory`);
    if (where.rel !== undefined && (isProtectedPath(where.rel) || isSecretPath(where.rel)))
      block(`ln \`${target}\` would point at protected path \`${where.rel}\``);
  }
}

/** Inspects a script file the command executes. */
function checkScriptFile(state: State, word: string, interpreter: "shell" | "other"): undefined {
  const abs = resolvePath(state, word);
  if (abs === undefined) return block(`executes \`${word}\`, which depends on an unknown variable`);
  if (state.written.has(abs) || state.written.has(real(state, abs)))
    return block(`executes \`${word}\`, which this same command writes`);
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
        } else if (a === "-C" || a === "--chdir") {
          changeDir(state, rest[i + 1]);
          i += 2;
        } else if (a.startsWith("--chdir=")) {
          changeDir(state, a.slice("--chdir=".length));
          i += 1;
        } else if (a === "-S" || a === "--split-string") {
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
  for (const sub of cmd.substitutions) scoped(state, () => checkScriptAst(state, sub));
  checkRedirects(state, cmd.redirects);
  for (const a of cmd.assigns) checkSetEnv(a.split("=")[0] ?? "");
  const words = unwrap(state, cmd.words, stdin);
  if (words.length === 0) return;
  checkSecretArgs(state, words);
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
  if (base === "cd" || base === "pushd" || base === "chdir") {
    changeDir(state, positionals(args)[0]);
    return;
  }
  if (base === "popd") {
    state.cwd = undefined;
    return;
  }
  const interpreter = base.replace(/\d+(\.\d+)*$/, "");
  if ((interpreter === "perl" || interpreter === "ruby") && args.some(isInPlaceFlag)) {
    // -i edits the operands in place: they are writes.
    const operands: string[] = [];
    let code = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k] ?? "";
      if (a === "-e" || a === "-E") {
        code = true;
        k++;
      } else if (/^-[IMx]$/.test(a)) k++;
      else if (!a.startsWith("-")) operands.push(a);
    }
    for (const f of code ? operands : operands.slice(1))
      checkWrite(state, f, `${interpreter} -i edits`);
  }
  const inline = INTERPRETERS[interpreter] ?? INTERPRETERS[base];
  if (inline) {
    const i = args.findIndex((a) => inline.includes(a));
    const joined = args.find((a) =>
      inline.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)),
    );
    if (i !== -1 || joined !== undefined) {
      const code =
        joined !== undefined ? joined.slice(joined.indexOf("=") + 1) : (args[i + 1] ?? "");
      const found = scanInline(code);
      if (found) block(found);
      return;
    }
    const file = args.find((a) => !a.startsWith("-"));
    // `bun run x` / `bun x` may name a package.json script rather than a file.
    if (base === "bun" && file !== undefined) {
      checkPackageScript(state, "bun", args);
      return;
    }
    if (file !== undefined) return checkScriptFile(state, file, "other");
    // `python3 -`, `node -` or no operand: the program comes from stdin.
    if (heredoc !== undefined) {
      const found = scanInline(heredoc);
      if (found) block(found);
      return;
    }
    if (inputFile !== undefined) return checkScriptFile(state, inputFile, "other");
    if (stdin === null) block(`pipes generated input into ${base}`);
    if (stdin !== undefined) {
      const found = scanInline(stdin);
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
    case "ln":
      checkLn(state, args);
      return;
    case "cp":
    case "install":
    case "rsync": {
      const dir = optionValues(args, "t", ["--target-directory"]);
      for (const d of dir) checkWrite(state, d, "writes into");
      const p = positionals(args).filter((x) => !dir.includes(x));
      const dest = p.at(-1);
      if (dir.length === 0 && dest !== undefined && p.length > 1) checkWrite(state, dest, "writes");
      return;
    }
    case "mv":
      for (const p of positionals(args)) checkWrite(state, p, "moves");
      for (const d of optionValues(args, "t", ["--target-directory"]))
        checkWrite(state, d, "moves into");
      return;
    case "curl":
      for (const t of [
        ...optionValues(args, "o", ["--output"]),
        ...optionValues(args, "D", ["--dump-header"]),
        ...optionValues(args, "c", ["--cookie-jar"]),
        ...optionValues(args, "", ["--output-dir", "--trace", "--trace-ascii", "--stderr"]),
      ])
        if (t !== "-") checkWrite(state, t, "curl writes");
      return;
    case "wget":
      for (const t of [
        ...optionValues(args, "O", ["--output-document"]),
        ...optionValues(args, "P", ["--directory-prefix"]),
        ...optionValues(args, "o", ["--output-file"]),
        ...optionValues(args, "a", ["--append-output"]),
      ])
        if (t !== "-") checkWrite(state, t, "wget writes");
      return;
    case "tar":
    case "bsdtar":
    case "gtar": {
      const old = /^[A-Za-z]+$/.test(args[0] ?? "") ? (args[0] ?? "") : "";
      const letters =
        old +
        args
          .filter((a) => /^-[A-Za-z]+$/.test(a))
          .map((a) => a.slice(1))
          .join("");
      const extract = letters.includes("x") || args.includes("--extract") || args.includes("--get");
      const create =
        /[cru]/.test(letters) || args.some((a) => ["--create", "--append", "--update"].includes(a));
      if (extract)
        for (const d of optionValues(args, "C", ["--directory"]))
          checkWrite(state, d, "tar extracts into");
      const file = old.includes("f") ? args[1] : optionValues(args, "f", ["--file"])[0];
      if (create && file !== undefined && file !== "-") checkWrite(state, file, "tar writes");
      return;
    }
    case "unzip":
      for (const d of optionValues(args, "d", [])) checkWrite(state, d, "unzip extracts into");
      return;
    case "zip": {
      const archive = positionals(args)[0];
      if (archive !== undefined) checkWrite(state, archive, "zip writes");
      return;
    }
    case "sort":
      for (const t of optionValues(args, "o", ["--output"])) checkWrite(state, t, "sort writes");
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
        args.some((a) => a === "-g" || a === "--global" || a === "--location=global") ||
        args[0] === "global" ||
        args[0] === "link"
      )
        return block(`${base} global installs change the machine, not the worktree`);
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
      checkPackageScript(state, base, args);
      return;
    case "make":
    case "gmake":
      checkMake(state, args);
      return;
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg":
    case "ag":
      checkRecursiveSearch(state, base, args);
      return;
    case "cargo":
    case "twine":
    case "gem":
    case "poetry":
    case "uv":
      if (args.some((a) => a === "publish" || a === "upload" || a === "push" || a === "yank"))
        return block(`${base} publishing is not allowed`);
      if ((base === "cargo" || base === "gem") && args[0] === "install")
        return block(`${base} install changes the machine, not the worktree`);
      if (base === "uv" && args[0] === "tool") return block("uv tool changes the machine");
      return;
    case "go":
      if (args[0] === "install") return block("go install changes the machine, not the worktree");
      return;
    case "pip":
    case "pip3":
      if (args.includes("--user") || args.includes("--break-system-packages"))
        return block(`${base} install outside the project environment is not allowed`);
      return;
    case "brew": {
      let i = 0;
      while (i < args.length && BREW_GLOBAL_FLAGS.has(args[i] ?? "")) i++;
      const first = args[i] ?? "";
      const readOnly = first.startsWith("-")
        ? BREW_READ_ONLY_FLAGS.has(first.split("=")[0] ?? "")
        : BREW_READ_ONLY_SUBCOMMANDS.has(first);
      if (readOnly) return;
      return block(`${base} changes the machine, not the worktree`);
    }
    case "port":
    case "apt":
    case "apt-get":
    case "dnf":
    case "yum":
      return block(`${base} changes the machine, not the worktree`);
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
      scoped(state, () => checkScriptAst(state, cmd.script));
    } else {
      checkSimple(state, cmd, stdin);
    }
  });
}

/** Subshells and substitutions do not change the parent's directory. */
function scoped(state: State, fn: () => void): void {
  const cwd = state.cwd;
  try {
    fn();
  } finally {
    state.cwd = cwd;
  }
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
  const state: State = { ctx, aliases: new Map(), depth: 0, cwd: ctx.cwd, written: new Set() };
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
