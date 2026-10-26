// ai-factory opencode plugin — generated from src/plugin/entry.ts; do not edit.
// @bun
// src/plugin/entry.ts
import { existsSync as existsSync4, readdirSync as readdirSync3, readFileSync as readFileSync3, statSync as statSync3 } from "fs";
import { isAbsolute as isAbsolute4, join as join8, relative as relative3, resolve as resolve5 } from "path";

// src/approval/approval.ts
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// src/tasks/parse.ts
var TASK_LINE = /^- \[( |x|X)\] (\d+(?:\.\d+)+)\s+(.+?)\s*$/;
function normalizeCheckboxes(text) {
  return text.split(`
`).map((l) => TASK_LINE.test(l) ? l.replace(/^- \[[xX]\]/, "- [ ]") : l).join(`
`);
}

// src/approval/approval.ts
function parseApproval(value) {
  if (typeof value !== "object" || value === null)
    return;
  const v = value;
  const ok = typeof v.changeId === "string" && typeof v.approver === "string" && typeof v.specCommit === "string" && /^[0-9a-f]{40,64}$/.test(v.specCommit) && typeof v.hash === "string" && /^[0-9a-f]{64}$/.test(v.hash) && typeof v.approvedAt === "string";
  return ok ? value : undefined;
}
var changeDir = (root, id) => join(root, "openspec", "changes", id);
var approvalFile = (root, id) => join(root, ".factory", "approvals", `${id}.json`);
function filesUnder(dir, prefix = "") {
  if (!existsSync(dir))
    return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? filesUnder(abs, rel) : [rel];
  });
}
function approvedFiles(root, id) {
  const dir = changeDir(root, id);
  const top = ["proposal.md", "design.md", "tasks.md"].filter((f) => existsSync(join(dir, f)));
  const specs = filesUnder(join(dir, "specs"), "specs").filter((f) => f.endsWith(".md"));
  return [...top, ...specs].sort();
}
function specHash(root, id) {
  const hash = createHash("sha256");
  const dir = changeDir(root, id);
  for (const rel of approvedFiles(root, id)) {
    let content = readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, `
`);
    if (rel === "tasks.md")
      content = normalizeCheckboxes(content);
    hash.update(rel).update("\x00").update(content).update("\x00");
  }
  return hash.digest("hex");
}
function readApproval(root, id) {
  const file = approvalFile(root, id);
  if (!existsSync(file))
    return;
  try {
    return parseApproval(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return;
  }
}
function checkApprovalHash(root, id) {
  const approval = readApproval(root, id);
  if (approval === undefined)
    return { valid: false, reason: `change ${id} is not approved` };
  if (approvedFiles(root, id).length === 0)
    return { valid: false, reason: `change ${id} has no spec files` };
  if (specHash(root, id) !== approval.hash) {
    return { valid: false, reason: `the spec of ${id} changed after approval; approve it again` };
  }
  return { valid: true, approval };
}

// src/logs/log.ts
import {
  appendFileSync,
  existsSync as existsSync2,
  mkdirSync,
  readdirSync as readdirSync2,
  rmdirSync,
  rmSync,
  statSync as statSync2
} from "fs";
import { join as join2 } from "path";

// src/logs/redact.ts
var MARK = (kind) => `[REDACTED:${kind}]`;
var PATTERNS = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    MARK("private-key")
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, MARK("aws-key")],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, MARK("github-token")],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, MARK("github-token")],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, MARK("gitlab-token")],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, MARK("slack-token")],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, MARK("api-key")],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MARK("google-key")],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MARK("jwt")],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${MARK("credentials")}@`],
  [/\b(https?:\/\/)[A-Za-z0-9_-]{20,}@/g, `$1${MARK("credentials")}@`],
  [
    /\b(authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest|bot)?\s*)([^\s"',;]{6,})/gi,
    `$1${MARK("auth")}`
  ],
  [/\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi, `$1${MARK("auth")}`],
  [
    /((?:^|\s)(?:-u\s*|--user[=\s]|--proxy-user[=\s])["']?[^\s:"']+:)([^\s"']+)/g,
    `$1${MARK("credentials")}`
  ],
  [
    /\b((?:[A-Za-z0-9_]*_)?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    `$1${MARK("secret")}`
  ]
];
var SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;
function secretEnvValues(env) {
  return Object.entries(env).filter(([name, value]) => SECRET_ENV_NAME.test(name) && value !== undefined && value.length >= 8).map(([, value]) => value).sort((a, b) => b.length - a.length);
}
function redact(text, envValues = [], options = {}) {
  let out = text;
  for (const value of envValues)
    out = out.split(value).join(MARK("env"));
  const patterns = options.heuristic === false ? PATTERNS.slice(0, -1) : PATTERNS;
  for (const [re, replacement] of patterns)
    out = out.replace(re, replacement);
  return out;
}

// src/logs/log.ts
function redactValue(value, env, heuristic) {
  if (typeof value === "string")
    return redact(value, env, { heuristic });
  if (Array.isArray(value))
    return value.map((v) => redactValue(v, env, heuristic));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, env, heuristic)]));
  return value;
}
var logDir = (root, changeId) => join2(root, ".factory", "logs", changeId);
function appendLog(root, changeId, entry, options = {}) {
  const dir = logDir(root, changeId);
  mkdirSync(dir, { recursive: true });
  const at = new Date;
  const env = secretEnvValues(options.env ?? process.env);
  const line = JSON.stringify({
    at: at.toISOString(),
    ...redactValue(entry, env, options.redact ?? true)
  });
  appendFileSync(join2(dir, `${at.toISOString().slice(0, 10)}.jsonl`), `${line}
`);
}

// src/policy/paths.ts
var PROTECTED = [
  /^openspec\/specs(\/|$)/i,
  /^\.opencode(\/|$)/i,
  /^\.factory(\/|$)/i,
  /^factory\.config\.jsonc$/i,
  /^factory\.lock\.json$/i,
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)\.git(\/|$)/i,
  /^\.gitmodules$/i
];
function isProtectedPath(rel) {
  const p = rel.replace(/^\.\//, "");
  return PROTECTED.some((re) => re.test(p));
}
var SECRET_BASENAMES = [
  /^\.env$/i,
  /^\.env\.(?!(example|sample|template|dist|defaults)$).+/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /kubeconfig/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /\.tfstate(\.backup)?$/i
];
var SECRET_SEGMENTS = [
  /(^|\/)\.kube\/(config|[^/]+\.ya?ml)$/i,
  /(^|\/)\.aws\/(credentials|config)$/i,
  /(^|\/)\.config\/gcloud(\/|$)/i,
  /(^|\/)\.azure(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.config\/gh\/hosts\.ya?ml$/i,
  /(^|\/)\.ssh(\/|$)/i
];
function isSecretPath(path) {
  const p = path.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  return SECRET_BASENAMES.some((re) => re.test(base)) || SECRET_SEGMENTS.some((re) => re.test(p));
}

// src/policy/realpath.ts
import { lstatSync, readlinkSync, realpathSync } from "fs";
import { basename, dirname, join as join3, resolve } from "path";
function realPathOf(abs, depth = 0) {
  if (depth > 40)
    return abs;
  const missing = [];
  let current = abs;
  for (let i = 0;i < 4096; i++) {
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st !== undefined) {
      try {
        return join3(realpathSync.native(current), ...missing.reverse());
      } catch {
        if (st.isSymbolicLink()) {
          const target = resolve(dirname(current), readlinkSync(current));
          return realPathOf(join3(target, ...missing.reverse()), depth + 1);
        }
        return abs;
      }
    }
    const parent = dirname(current);
    if (parent === current)
      return abs;
    missing.push(basename(current));
    current = parent;
  }
  return abs;
}

// src/policy/sandbox.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "fs";
import { isAbsolute, join as join4, resolve as resolve2 } from "path";
var SANDBOX_EXEC = "/usr/bin/sandbox-exec";
var regexPath = (p) => realPathOf(p).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
function secretReadRules(workspace) {
  const ws = regexPath(workspace);
  const under = `^${ws}/(.*/)?`;
  const secret = [
    "\\.env(\\.[^/]*)?",
    "\\.netrc",
    "\\.git-credentials",
    "\\.pypirc",
    "id_(rsa|dsa|ecdsa|ed25519)[^/]*",
    "[^/]*kubeconfig[^/]*",
    "[^/]*\\.tfstate(\\.backup)?"
  ];
  return [
    `(deny file-read-data ${secret.map((s) => `(regex #"${under}${s}$")`).join(" ")})`,
    `(allow file-read-data (regex #"${under}\\.env\\.(example|sample|template|dist|defaults)$"))`
  ];
}
var HOME_WRITE_DENY = [
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
  "go/bin"
];
var SYSTEM_WRITE_DENY = ["/opt/homebrew", "/usr/local/bin", "/usr/local/sbin"];
var HOME_READ_DENY = [
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
  "Library/Keychains"
];
var sbString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
var subpath = (p) => `(subpath ${sbString(realPathOf(p))})`;
function seatbeltProfile(policy) {
  const home = policy.home;
  const lines = [
    "(version 1)",
    "(allow default)",
    `(deny file-write* ${subpath(policy.workspace)})`
  ];
  if (policy.writable.length > 0)
    lines.push(`(allow file-write* ${policy.writable.map(subpath).join(" ")})`);
  if ((policy.readOnly ?? []).length > 0)
    lines.push(`(deny file-write* ${(policy.readOnly ?? []).map(subpath).join(" ")})`);
  if ((policy.writableInside ?? []).length > 0)
    lines.push(`(allow file-write* ${(policy.writableInside ?? []).map(subpath).join(" ")})`);
  if (home !== undefined) {
    lines.push(`(deny file-write* ${HOME_WRITE_DENY.map((p) => subpath(join4(home, p))).join(" ")})`);
    lines.push(`(deny file-read* ${HOME_READ_DENY.map((p) => subpath(join4(home, p))).join(" ")})`);
  }
  lines.push(`(deny file-write* ${SYSTEM_WRITE_DENY.map(subpath).join(" ")})`);
  if (policy.denySecretReads === true)
    lines.push(...secretReadRules(policy.workspace));
  lines.push('(deny process-exec (regex #"/git-credential-[^/]*$"))');
  lines.push('(deny network-outbound (remote tcp "*:22"))');
  return lines.join(`
`);
}
var shQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
function sandboxCommand(profile, shell, command) {
  return `exec ${shQuote(SANDBOX_EXEC)} -p ${shQuote(profile)} ${shQuote(shell)} -c ${shQuote(command)}`;
}
function gitWritableDirs(worktree) {
  const dotGit = join4(worktree, ".git");
  let gitDir = dotGit;
  try {
    const text = readFileSync2(dotGit, "utf8");
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (m?.[1])
      gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve2(worktree, m[1].trim());
  } catch {
    return [join4(dotGit, "index"), join4(dotGit, "index.lock"), join4(dotGit, "objects")];
  }
  let common = gitDir;
  try {
    const rel = readFileSync2(join4(gitDir, "commondir"), "utf8").trim();
    common = isAbsolute(rel) ? rel : resolve2(gitDir, rel);
  } catch {}
  return [gitDir, join4(common, "objects")];
}
function protectedInWorktree(worktree) {
  return [
    ".git",
    ".opencode",
    ".factory",
    "AGENTS.md",
    "factory.config.jsonc",
    "factory.lock.json",
    "openspec/specs",
    ".gitmodules"
  ].map((p) => join4(worktree, p));
}
function checkoutPolicy(workspace, dir, extra = [], home = process.env.HOME) {
  return {
    workspace,
    writable: [dir],
    readOnly: protectedInWorktree(dir),
    writableInside: [...gitWritableDirs(dir), ...extra],
    ...home === undefined ? {} : { home }
  };
}

// src/policy/scope.ts
import { isAbsolute as isAbsolute2, normalize, relative, resolve as resolve3 } from "path";

// src/tasks/glob.ts
var cache = new Map;
function globRegExp(glob) {
  const cached = cache.get(glob);
  if (cached)
    return cached;
  let re = "";
  for (let i = 0;i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob.charAt(i + 1) === "*") {
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
function matchGlob(glob, path) {
  return globRegExp(glob).test(path);
}
function matchesAny(globs, path) {
  return globs.some((g) => matchGlob(g, path));
}
function opencodeGlobRegExp(glob) {
  const body = glob.split("").map((ch) => ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${body}$`);
}

// src/policy/scope.ts
var ROLES = [
  "orchestrator",
  "architect",
  "explorer",
  "reviewer",
  "contract-reviewer",
  "tester",
  "implementer"
];
var isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
function parseSessionContext(value) {
  if (typeof value !== "object" || value === null)
    return;
  const v = value;
  const str = (k) => typeof v[k] === "string";
  if (!str("sessionId") || !str("changeId") || !str("directory") || !str("workspace"))
    return;
  if (!ROLES.includes(v.role))
    return;
  for (const k of ["repo", "task"])
    if (v[k] !== undefined && !str(k))
      return;
  for (const k of ["touches", "testGlobs"])
    if (v[k] !== undefined && !isStringArray(v[k]))
      return;
  return value;
}
var architectDirs = (changeId) => [
  `openspec/changes/${changeId}/`,
  `.factory/context/${changeId}/`
];
var IMPLEMENTING_ROLES = new Set(["implementer", "tester"]);
function checkEdit(ctx, path, approval) {
  const abs = normalize(isAbsolute2(path) ? path : resolve3(ctx.directory, path));
  const rel = relative(ctx.directory, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute2(rel)) {
    return {
      allowed: false,
      reason: `\`${path}\` is outside your ${ctx.role === "architect" ? "workspace" : "worktree"}`
    };
  }
  if (isSecretPath(rel))
    return { allowed: false, reason: `\`${rel}\` is a secret file` };
  if (ctx.role === "architect") {
    if (architectDirs(ctx.changeId).some((d) => rel.startsWith(d)))
      return { allowed: true, rel };
    return {
      allowed: false,
      reason: `the architect may only write ${architectDirs(ctx.changeId).join(" and ")} (not \`${rel}\`)`
    };
  }
  if (isProtectedPath(rel))
    return { allowed: false, reason: `\`${rel}\` is managed by the factory` };
  if (!IMPLEMENTING_ROLES.has(ctx.role))
    return { allowed: false, reason: `the ${ctx.role} is read-only` };
  if (/^openspec(\/|$)/i.test(rel))
    return {
      allowed: false,
      reason: `\`${rel}\` is the change's spec: only the architect writes it, and the factory ticks tasks`
    };
  const approved = approval();
  if (approved !== true)
    return { allowed: false, reason: `${approved}; implementation edits are blocked` };
  if (ctx.role === "tester") {
    const globs = ctx.testGlobs ?? [];
    if (globs.some((g) => opencodeGlobRegExp(g).test(rel)))
      return { allowed: true, rel };
    return {
      allowed: false,
      reason: `the tester may only edit test files (${globs.join(", ")}), not \`${rel}\``
    };
  }
  if (ctx.touches !== undefined && !matchesAny(ctx.touches, rel)) {
    return {
      allowed: false,
      reason: `\`${rel}\` is outside this task's touches (${ctx.touches.join(", ")}); if you need it, stop with status "blocked"`
    };
  }
  return { allowed: true, rel };
}
function patchPaths(patchText) {
  const out = new Set;
  for (const raw of patchText.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/) ?? line.match(/^(?:---|\+\+\+) (?:[ab]\/)?(.+?)(?:\t.*)?\s*$/) ?? line.match(/^(?:rename|copy) (?:from|to) (.+?)\s*$/) ?? line.match(/^diff --git a\/(.+?) b\/.+$/);
    if (m?.[1] && m[1] !== "/dev/null")
      out.add(m[1]);
  }
  if (out.size === 0 && patchText.trim() !== "")
    return;
  return [...out];
}

// src/policy/secrets.ts
import { join as join5 } from "path";
var GLOB = /[*?[]/;
function segmentRegExp(segment) {
  let body = "";
  for (let i = 0;i < segment.length; i++) {
    const c = segment[i] ?? "";
    if (c === "*")
      body += "[^/]*";
    else if (c === "?")
      body += "[^/]";
    else if (c === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end === -1)
        body += "\\[";
      else {
        const set = segment.slice(i + 1, end).replace(/^!/, "^");
        body += `[${set.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else
      body += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  const dotless = !segment.startsWith(".");
  return new RegExp(`^${dotless ? "(?!\\.)" : ""}${body}$`, "i");
}
var SECRET_SAMPLES = [
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
  ".ssh/id_ed25519"
];
function globMatchesSecret(pattern, readdir) {
  if (!GLOB.test(pattern))
    return;
  const segments = pattern.split("/");
  const first = segments.findIndex((s) => GLOB.test(s));
  if (readdir !== undefined) {
    let paths = [segments.slice(0, first).join("/") || "/"];
    let seen = 0;
    for (const segment of segments.slice(first)) {
      const re = GLOB.test(segment) ? segmentRegExp(segment) : undefined;
      const next = [];
      for (const dir of paths) {
        if (re === undefined) {
          next.push(join5(dir, segment));
          continue;
        }
        for (const name of readdir(dir) ?? []) {
          if (++seen > 5000)
            return;
          if (re.test(name))
            next.push(join5(dir, name));
        }
      }
      paths = next;
    }
    return paths.find((p) => isSecretPath(p));
  }
  const tail = segments.slice(first).filter((s) => s !== "");
  for (const sample of SECRET_SAMPLES) {
    const parts = sample.split("/");
    if (parts.length < tail.length)
      continue;
    const end = parts.slice(parts.length - tail.length);
    if (tail.every((seg, k) => segmentRegExp(seg).test(end[k] ?? "")))
      return sample;
  }
  return;
}
var SKIP = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  ".venv",
  "venv"
]);
function findSecretUnder(dir, readdir, maxEntries = 20000) {
  let seen = 0;
  const walk = (abs, rel, depth) => {
    if (depth > 10)
      return;
    for (const name of readdir(abs) ?? []) {
      if (++seen > maxEntries)
        return;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (isSecretPath(childRel))
        return childRel;
      if (SKIP.has(name))
        continue;
      const found = walk(join5(abs, name), childRel, depth + 1);
      if (found !== undefined)
        return found;
    }
    return;
  };
  return walk(dir, "", 0);
}
var MENTION = /(?:^|[\s'"`/(=,])((?:\.env(?!\.(?:example|sample|template|dist|defaults)\b)(?:\.[\w-]+)*|id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|\.git-credentials|\.aws\/credentials|\.kube\/config|kubeconfig|\.ssh\/[\w.-]+))(?=$|[\s'"`),;])/;
function mentionedSecret(code) {
  return code.match(MENTION)?.[1];
}

// src/policy/session-files.ts
import { join as join6 } from "path";
var sessionContextFile = (workspace, sessionId) => join6(workspace, ".factory", "sessions", `${sessionId}.json`);

// src/policy/shell.ts
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute3, join as join7, normalize as normalize2, relative as relative2, resolve as resolve4 } from "path";

// src/policy/shell-parse.ts
class ShellParseError extends Error {
}
var OPS = ["&&", "||", ";;", ";", "|&", "|", "&", "(", ")", `
`];

class Lexer {
  src;
  pos = 0;
  tokens = [];
  pendingHeredocs = [];
  constructor(src) {
    this.src = src;
  }
  peek(n = 0) {
    return this.src.charAt(this.pos + n);
  }
  readParenBody() {
    let depth = 1;
    const start = this.pos;
    let quote;
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos);
      if (quote) {
        if (ch === "\\" && quote === '"')
          this.pos++;
        else if (ch === quote)
          quote = undefined;
      } else if (ch === "'" || ch === '"')
        quote = ch;
      else if (ch === "\\")
        this.pos++;
      else if (ch === "(")
        depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          const body = this.src.slice(start, this.pos);
          this.pos++;
          return body;
        }
      }
      this.pos++;
    }
    throw new ShellParseError("unterminated $( \u2026 )");
  }
  readBacktick() {
    let out = "";
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos++);
      if (ch === "\\" && this.pos < this.src.length)
        out += this.src.charAt(this.pos++);
      else if (ch === "`")
        return out;
      else
        out += ch;
    }
    throw new ShellParseError("unterminated backtick");
  }
  readWord() {
    let value = "";
    const subs = [];
    const sub = (body) => subs.push(parseScript(body));
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (/\s/.test(ch) || OPS.some((op) => this.src.startsWith(op, this.pos)) || this.isRedirStart())
        break;
      this.pos++;
      if (ch === "\\") {
        const next = this.src.charAt(this.pos++);
        if (next !== `
`)
          value += next;
      } else if (ch === "'") {
        const end = this.src.indexOf("'", this.pos);
        if (end === -1)
          throw new ShellParseError("unterminated single quote");
        value += this.src.slice(this.pos, end);
        this.pos = end + 1;
      } else if (ch === "$" && this.peek() === "'") {
        this.pos++;
        value += this.readAnsiC();
      } else if (ch === '"') {
        value += this.readDouble(sub);
      } else if (ch === "$" && this.peek() === "(" && this.peek(1) !== "(") {
        this.pos++;
        const body = this.readParenBody();
        sub(body);
        value += `$(${body})`;
      } else if ((ch === "<" || ch === ">") && this.peek() === "(") {
        this.pos++;
        const body = this.readParenBody();
        sub(body);
        value += `${ch}(${body})`;
      } else if (ch === "`") {
        const body = this.readBacktick();
        sub(body);
        value += `$(${body})`;
      } else {
        value += ch;
      }
    }
    return { t: "word", value, subs };
  }
  readAnsiC() {
    let out = "";
    const map = {
      n: `
`,
      t: "\t",
      r: "\r",
      "\\": "\\",
      "'": "'",
      '"': '"',
      a: "\x07",
      e: "\x1B"
    };
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos++);
      if (ch === "'")
        return out;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = this.src.charAt(this.pos++);
      if (esc === "x") {
        const hex = this.src.slice(this.pos).match(/^[0-9a-fA-F]{1,2}/)?.[0] ?? "";
        this.pos += hex.length;
        out += String.fromCharCode(Number.parseInt(hex || "0", 16));
      } else if (/[0-7]/.test(esc)) {
        const oct = esc + (this.src.slice(this.pos).match(/^[0-7]{0,2}/)?.[0] ?? "");
        this.pos += oct.length - 1;
        out += String.fromCharCode(Number.parseInt(oct, 8));
      } else {
        out += map[esc] ?? esc;
      }
    }
    throw new ShellParseError("unterminated $'\u2026'");
  }
  readDouble(sub) {
    let out = "";
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos++);
      if (ch === '"')
        return out;
      if (ch === "\\") {
        const next = this.src.charAt(this.pos++);
        out += '$`"\\\n'.includes(next) ? next === `
` ? "" : next : `\\${next}`;
      } else if (ch === "$" && this.peek() === "(" && this.peek(1) !== "(") {
        this.pos++;
        const body = this.readParenBody();
        sub(body);
        out += `$(${body})`;
      } else if (ch === "`") {
        const body = this.readBacktick();
        sub(body);
        out += `$(${body})`;
      } else {
        out += ch;
      }
    }
    throw new ShellParseError("unterminated double quote");
  }
  isRedirStart() {
    const rest = this.src.slice(this.pos);
    if (/^\d*(<<<|<<-|<<|>>|>&|<&|<>|>\||>|<)/.test(rest) && !/^\d*[<>]\(/.test(rest)) {
      return /^\d+[<>]/.test(rest) ? true : /^[<>]/.test(rest);
    }
    return /^&>/.test(rest);
  }
  readHeredocs() {
    for (const doc of this.pendingHeredocs.splice(0)) {
      const lines = [];
      for (;; ) {
        if (this.pos >= this.src.length)
          throw new ShellParseError(`here-document ${doc.delim} not terminated`);
        const nl = this.src.indexOf(`
`, this.pos);
        const line = this.src.slice(this.pos, nl === -1 ? undefined : nl);
        this.pos = nl === -1 ? this.src.length : nl + 1;
        const check = doc.strip ? line.replace(/^\t+/, "") : line;
        if (check === doc.delim)
          break;
        lines.push(check);
      }
      doc.set(lines.join(`
`));
    }
  }
  lex() {
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === `
`) {
        this.pos++;
        this.tokens.push({ t: "op", value: `
` });
        this.readHeredocs();
        continue;
      }
      if (/\s/.test(ch)) {
        this.pos++;
        continue;
      }
      if (ch === "#" && (this.tokens.length === 0 || this.src.charAt(this.pos - 1).match(/\s|;/))) {
        const nl = this.src.indexOf(`
`, this.pos);
        this.pos = nl === -1 ? this.src.length : nl;
        continue;
      }
      if (this.isRedirStart()) {
        const m = this.src.slice(this.pos).match(/^(\d*)(<<<|<<-|<<|&>>|&>|>>|>&|<&|<>|>\||>|<)/);
        if (!m)
          throw new ShellParseError("bad redirection");
        this.pos += m[0].length;
        this.tokens.push({ t: "redir", op: m[2] ?? "", ...m[1] ? { fd: m[1] } : {} });
        continue;
      }
      const op = OPS.find((o) => this.src.startsWith(o, this.pos));
      if (op) {
        this.pos += op.length;
        this.tokens.push({ t: "op", value: op });
        continue;
      }
      const word = this.readWord();
      const prev = this.tokens.at(-1);
      if (prev?.t === "redir" && (prev.op === "<<" || prev.op === "<<-")) {
        this.pendingHeredocs.push({
          delim: word.value,
          strip: prev.op === "<<-",
          set: (body) => {
            prev.body = body;
          }
        });
      }
      this.tokens.push(word);
    }
    if (this.pendingHeredocs.length > 0)
      this.readHeredocs();
    return this.tokens;
  }
}
var SKIP_WORDS = new Set([
  "if",
  "while",
  "until",
  "then",
  "else",
  "elif",
  "do",
  "done",
  "fi",
  "esac",
  "{",
  "}",
  "!",
  "in"
]);
var HEADER_WORDS = new Set(["for", "select", "case"]);

class Parser {
  tokens;
  i = 0;
  constructor(tokens) {
    this.tokens = tokens;
  }
  peek() {
    return this.tokens[this.i];
  }
  script(stopAtParen) {
    const pipelines = [];
    for (;; ) {
      const tok = this.peek();
      if (tok === undefined)
        break;
      if (tok.t === "op" && tok.value === ")") {
        if (stopAtParen)
          break;
        throw new ShellParseError("unexpected )");
      }
      if (tok.t === "op" && [";", `
`, "&", "&&", "||", ";;"].includes(tok.value)) {
        this.i++;
        continue;
      }
      pipelines.push(this.pipeline());
    }
    return { pipelines };
  }
  pipeline() {
    const commands = [this.command()];
    for (;; ) {
      const tok = this.peek();
      if (tok?.t === "op" && (tok.value === "|" || tok.value === "|&")) {
        this.i++;
        commands.push(this.command());
      } else {
        return { commands };
      }
    }
  }
  redirect(tok, redirects) {
    const target = this.tokens[this.i++];
    if (target?.t !== "word")
      throw new ShellParseError(`missing target for ${tok.op}`);
    const body = tok.op === "<<<" ? target.value : tok.body;
    redirects.push({ op: tok.op, target: target.value, ...body === undefined ? {} : { body } });
  }
  command() {
    const first = this.peek();
    if (first?.t === "op" && first.value === "(") {
      this.i++;
      const script = this.script(true);
      const close = this.tokens[this.i++];
      if (close?.t !== "op" || close.value !== ")")
        throw new ShellParseError("unterminated (");
      const redirects = [];
      while (this.peek()?.t === "redir") {
        const r = this.tokens[this.i++];
        this.redirect(r, redirects);
      }
      return { kind: "subshell", script, redirects };
    }
    const assigns = [];
    const words = [];
    const redirects = [];
    const substitutions = [];
    for (;; ) {
      const tok = this.peek();
      if (tok === undefined || tok.t === "op") {
        if (tok?.t === "op" && tok.value === "(" && words.length === 1 && this.tokens[this.i + 1]?.t === "op") {
          this.i += 2;
          words.length = 0;
          continue;
        }
        break;
      }
      this.i++;
      if (tok.t === "redir") {
        this.redirect(tok, redirects);
        continue;
      }
      substitutions.push(...tok.subs);
      if (words.length === 0 && tok.value === "function") {
        if (this.peek()?.t === "word")
          this.i++;
        continue;
      }
      if (words.length === 0 && tok.value === "coproc") {
        const next = this.tokens[this.i];
        const after = this.tokens[this.i + 1];
        if (next?.t === "word" && after?.t === "word" && after.value === "{")
          this.i++;
        continue;
      }
      if (words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.value))
        assigns.push(tok.value);
      else if (words.length === 0 && SKIP_WORDS.has(tok.value))
        continue;
      else
        words.push(tok.value);
    }
    if (words.length > 0 && HEADER_WORDS.has(words[0] ?? "")) {
      return { kind: "simple", assigns, words: [], redirects, substitutions };
    }
    return { kind: "simple", assigns, words, redirects, substitutions };
  }
}
function parseScript(src) {
  return new Parser(new Lexer(src).lex()).script(false);
}

// src/policy/shell.ts
class Blocked extends Error {
}
function block(reason) {
  throw new Blocked(reason);
}
var SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
var XARGS_SAFE = new Set([
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
  "true"
]);
var COMMAND_RUNNERS = new Set([
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
  "ex"
]);
var EDITORS = new Set(["vim", "vi", "nvim", "view", "gvim", "emacs"]);
var AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);
var INTERPRETERS = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"]
};
var DOWNLOADERS = new Set(["curl", "wget", "fetch", "http", "https", "aria2c"]);
var PRIVILEGE = new Set(["sudo", "doas", "su", "pkexec", "runas"]);
var ENV_DUMPS = new Set(["printenv"]);
var PROTECTED_ENV = /^(AI_FACTORY_|GIT_CONFIG_|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$)/;
var DANGEROUS_ENV = /^(GIT_|AI_FACTORY_|OPENCODE_|SSH_|LD_|DYLD_)|^(PAGER|MANPAGER|EDITOR|VISUAL|BASH_ENV|ENV|HOME|ZDOTDIR|XDG_CONFIG_HOME|XDG_DATA_HOME|PATH|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|IFS|CDPATH|PS4)$/;
function checkSetEnv(name) {
  if (PROTECTED_ENV.test(name))
    block(`overrides the factory's environment (${name})`);
  if (DANGEROUS_ENV.test(name))
    block(`setting ${name} is not allowed (it changes what tools run)`);
}
var SAFE_WRITE_TARGETS = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
function scanText(text) {
  for (const t of [text, text.replace(/(['"`])\s*\+\s*\1/g, "")]) {
    if (/\bgit\b[\s"',[\]()]+push\b/.test(t))
      return "embedded code runs `git push`";
    if (/\b(curl|wget)\b[^\n|]*\|\s*(ba|z|da)?sh\b/.test(t))
      return "embedded code pipes a download into a shell";
  }
  return;
}
function scanInline(code) {
  const found = scanText(code);
  if (found !== undefined)
    return found;
  const secret = mentionedSecret(code);
  return secret === undefined ? undefined : `embedded code reads secret file \`${secret}\``;
}
function home(state) {
  return state.ctx.env?.HOME;
}
function resolvePath(state, word) {
  let w = word;
  if (w === "~" || w.startsWith("~/")) {
    const h = home(state);
    if (h === undefined)
      return;
    w = h + w.slice(1);
  }
  w = w.replace(/\$\{?(HOME|TMPDIR|PWD)\}?/g, (m, name) => {
    if (name === "PWD")
      return state.cwd ?? m;
    return state.ctx.env?.[name] ?? m;
  });
  if (w.includes("$"))
    return;
  if (isAbsolute3(w))
    return normalize2(w);
  return state.cwd === undefined ? undefined : normalize2(resolve4(state.cwd, w));
}
var real = (state, abs) => state.ctx.realpath?.(abs) ?? abs;
var within = (abs, dir) => {
  const rel = relative2(dir, abs);
  return rel === "" || !rel.startsWith("..") && !isAbsolute3(rel);
};
function tempDirs(state) {
  return ["/tmp", "/private/tmp", state.ctx.env?.TMPDIR].filter((d) => !!d).flatMap((d) => [normalize2(d), real(state, normalize2(d))]);
}
function locate(state, abs) {
  const target = real(state, abs);
  const root = real(state, state.ctx.root);
  if (within(target, root))
    return { real: target, rel: relative2(root, target), temp: false };
  const ws = state.ctx.workspace;
  if (ws !== undefined && within(target, real(state, ws)))
    return { real: target, temp: false };
  return { real: target, temp: tempDirs(state).some((t) => within(target, t)) };
}
function checkWrite(state, word, what) {
  if (SAFE_WRITE_TARGETS.test(word))
    return;
  const abs = resolvePath(state, word);
  if (abs === undefined)
    block(`${what} \`${word}\` depends on an unknown variable or directory`);
  const where = locate(state, abs);
  if (where.rel === undefined) {
    if (!where.temp)
      block(`${what} \`${word}\` is outside the session directory`);
  } else {
    if (where.rel === "")
      block(`${what} the session directory itself`);
    if (isProtectedPath(where.rel))
      block(`${what} protected path \`${where.rel}\``);
    if (isSecretPath(where.rel))
      block(`${what} secret file \`${where.rel}\``);
  }
  state.written.add(abs);
  state.written.add(where.real);
}
function changeDir2(state, word) {
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
function optionValues(args, short, long) {
  const out = [];
  for (let i = 0;i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--")
      break;
    const eq = long.find((l) => a.startsWith(`${l}=`));
    if (eq !== undefined)
      out.push(a.slice(eq.length + 1));
    else if (long.includes(a))
      out.push(args[++i] ?? "");
    else if (/^-[A-Za-z]/.test(a) && !a.startsWith("--")) {
      const j = a.indexOf(short, 1);
      if (short !== "" && j !== -1) {
        const attached = a.slice(j + 1);
        out.push(attached !== "" ? attached : args[++i] ?? "");
      }
    }
  }
  return out;
}
function checkSecretArgs(state, words) {
  for (const w of words) {
    const value = w.startsWith("-") ? w.includes("=") ? w.slice(w.indexOf("=") + 1) : "" : w;
    if (value === "")
      continue;
    if (isSecretPath(value))
      block(`touches secret file \`${value}\``);
    const object = value.match(/^[^\s:/]*:([^/].*)$/)?.[1];
    if (object !== undefined && isSecretPath(object))
      block(`reads secret file \`${object}\` from git`);
    if (/[*?[]/.test(value)) {
      const abs = resolvePath(state, value);
      const hit = abs === undefined ? undefined : globMatchesSecret(abs, state.ctx.readdir);
      if (hit !== undefined)
        block(`the pattern \`${value}\` matches secret file \`${hit}\``);
    }
  }
}
function checkRecursiveSearch(state, base, args) {
  const f = flags(args);
  const pos = positionals(args);
  let roots;
  if (base === "grep" || base === "egrep" || base === "fgrep") {
    const recursive = f.has("-r") || f.has("-R") || f.has("--recursive") || f.has("--dereference-recursive") || optionValues(args, "d", ["--directories"]).includes("recurse");
    if (!recursive)
      return;
    const explicit = f.has("-e") || f.has("-f") || f.has("--regexp") || f.has("--file");
    roots = explicit ? pos : pos.slice(1);
  } else {
    const unrestricted = args.filter((a) => /^-[A-Za-z]+$/.test(a)).reduce((n, a) => n + (a.match(/u/g)?.length ?? 0), 0);
    const hidden = f.has("--hidden") || f.has("-.") || f.has("--unrestricted") || unrestricted >= 2;
    if (!hidden)
      return;
    roots = pos.slice(1);
  }
  const readdir = state.ctx.readdir;
  if (readdir === undefined)
    return;
  for (const root of roots.length > 0 ? roots : ["."]) {
    const abs = resolvePath(state, root);
    if (abs === undefined)
      continue;
    const found = findSecretUnder(abs, readdir);
    if (found !== undefined)
      block(`searches \`${root}\`, which contains secret file \`${found}\`; search specific directories instead`);
  }
}
function checkPackageScript(state, tool, args) {
  const pos = positionals(args);
  const sub = pos[0];
  if (sub === undefined || state.cwd === undefined)
    return;
  const text = state.ctx.readFile?.(join7(state.cwd, "package.json"));
  let scripts = {};
  try {
    scripts = (text === undefined ? {} : JSON.parse(text).scripts) ?? {};
  } catch {
    return;
  }
  const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
  const NPM_LIFECYCLE = {
    test: "test",
    t: "test",
    tst: "test",
    start: "start",
    stop: "stop",
    restart: "restart"
  };
  let name;
  if (tool === "npm")
    name = NPM_RUN.has(sub) ? pos[1] : NPM_LIFECYCLE[sub];
  else if (sub === "run")
    name = pos[1];
  else if (sub in scripts)
    name = sub;
  else if (tool === "bun" && /\.[cm]?[jt]sx?$/.test(sub)) {
    checkScriptFile(state, sub, "other");
    return;
  }
  if (name === undefined)
    return;
  if (tool === "bun" && !(name in scripts) && /\.[cm]?[jt]sx?$/.test(name)) {
    checkScriptFile(state, name, "other");
    return;
  }
  for (const key of [`pre${name}`, name, `post${name}`]) {
    const body = scripts[key];
    if (typeof body === "string")
      checkScript(state, body);
  }
}
function parseMakefile(text) {
  const vars = new Map;
  const rules = new Map;
  let first;
  let current = [];
  for (const line of text.replace(/\\\n/g, " ").split(`
`)) {
    if (line.startsWith("\t")) {
      for (const r of current)
        r.recipe.push(line.slice(1));
      continue;
    }
    if (/^\s*(#|$)/.test(line))
      continue;
    const assign = line.match(/^(?:export\s+|override\s+)?([A-Za-z_][\w.-]*)\s*(?:\?|:|::|\+|!)?=\s*(.*)$/);
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
    current = rule[1].split(/\s+/).filter(Boolean).map((t) => {
      const r = rules.get(t) ?? { prereqs: [], recipe: [] };
      r.prereqs.push(...prereqs);
      if (rule[3] !== undefined)
        r.recipe.push(rule[3]);
      rules.set(t, r);
      if (first === undefined && !t.startsWith(".") && !t.includes("%"))
        first = t;
      return r;
    });
  }
  return first === undefined ? { vars, rules } : { vars, rules, first };
}
var DOLLAR = "\uE000";
function checkMake(state, args) {
  const dir = optionValues(args, "C", ["--directory"]).at(-1);
  const file = optionValues(args, "f", ["--file", "--makefile"]).at(-1);
  const targets = [];
  for (let i = 0;i < args.length; i++) {
    const a = args[i] ?? "";
    if (["-C", "-f", "-I", "-o", "-W", "--directory", "--file", "--makefile"].includes(a))
      i++;
    else if (!a.startsWith("-") && !a.includes("="))
      targets.push(a);
  }
  const base = dir === undefined ? state.cwd : resolvePath(state, dir);
  if (base === undefined)
    return;
  const names = file !== undefined ? [file] : ["GNUmakefile", "makefile", "Makefile"];
  const text = names.map((n) => state.ctx.readFile?.(resolve4(base, n))).find((t) => t !== undefined);
  if (text === undefined)
    return;
  const { vars, rules, first } = parseMakefile(text);
  const expand = (line) => {
    let out = line.replaceAll("$$", DOLLAR);
    for (let k = 0;k < 5; k++)
      out = out.replace(/\$[({]([A-Za-z_][\w.-]*)[)}]/g, (m, v) => vars.get(v) ?? m);
    return out;
  };
  const seen = new Set;
  const visit = (target) => {
    if (seen.has(target) || seen.size > 200)
      return;
    seen.add(target);
    const rule = rules.get(target);
    if (rule === undefined)
      return;
    for (const p of rule.prereqs)
      visit(p);
    for (const raw of rule.recipe) {
      const line = expand(raw.replace(/^[\s@+-]+/, ""));
      if (/\$[({]/.test(line)) {
        const found = scanText(line);
        if (found)
          block(`make ${target}: ${found}`);
      } else
        checkScript(state, line.replaceAll(DOLLAR, "$"));
    }
  };
  for (const t of targets.length > 0 ? targets : first === undefined ? [] : [first])
    visit(t);
}
function checkRedirects(state, redirects) {
  for (const r of redirects) {
    if (r.op === "<<" || r.op === "<<-" || r.op === "<<<")
      continue;
    if (r.op === ">&" || r.op === "<&") {
      if (/^\d+-?$|^-$/.test(r.target))
        continue;
    }
    if (isSecretPath(r.target))
      block(`redirects to or from secret file \`${r.target}\``);
    if (r.op !== "<")
      checkWrite(state, r.target, "writes");
  }
}
var flags = (words) => {
  const out = new Set;
  for (const w of words) {
    if (w === "--")
      break;
    if (w.startsWith("--"))
      out.add(w.split("=")[0] ?? w);
    else if (w.startsWith("-") && w.length > 1)
      for (const ch of w.slice(1))
        out.add(`-${ch}`);
  }
  return out;
};
var isInPlaceFlag = (a) => /^-[a-zA-Z]*i/.test(a) && !a.startsWith("--") && !/^-[IMx]/.test(a);
var positionals = (words) => {
  const out = [];
  let dashdash = false;
  for (const w of words) {
    if (!dashdash && w === "--")
      dashdash = true;
    else if (dashdash || !w.startsWith("-") || w === "-")
      out.push(w);
  }
  return out;
};
var GIT_READ_ONLY = new Set([
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
  "fsck"
]);
var GIT_LOCAL_WRITES = new Set([
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
  "checkout"
]);
var SAFE_GIT_CONFIG_KEYS = /^(color\.[a-z.]+|core\.quotepath|advice\.[a-z]+|log\.(date|decorate|abbrevcommit|follow|showroot|mailmap)|format\.pretty|grep\.(linenumber|patterntype|extendedregexp|fullname)|status\.(short|branch|showuntrackedfiles|relativepaths)|diff\.(noprefix|mnemonicprefix|renames|algorithm|context|interhunkcontext|relative|statgraphwidth|colormoved|indentheuristic|suppressblankempty|ignoresubmodules))$/i;
function checkGitOptions(state, sub, rest, f) {
  const has = (...names) => names.some((n) => f.has(n) || rest.some((a) => a.startsWith(`${n}=`)));
  if (has("--upload-pack", "--receive-pack", "--exec") || sub === "ls-remote" && f.has("-u"))
    block(`git ${sub} with a program option (--upload-pack, --receive-pack, --exec) is not allowed`);
  if (sub === "archive" && has("--remote"))
    block("git archive --remote is not allowed");
  if (sub === "grep" && (has("--open-files-in-pager") || rest.some((a) => /^-[^-]*O/.test(a))))
    block("git grep -O runs a pager program");
  if (sub === "apply" && f.has("--unsafe-paths"))
    block("git apply --unsafe-paths writes outside the repo");
  rest.forEach((a, i) => {
    let target;
    if (a === "--output" || a === "--output-directory" || sub === "format-patch" && a === "-o" || sub === "archive" && a === "-o")
      target = rest[i + 1];
    else if (a.startsWith("--output=") || a.startsWith("--output-directory="))
      target = a.slice(a.indexOf("=") + 1);
    if (target !== undefined)
      checkWrite(state, target, `git ${sub} writes`);
  });
}
function checkGit(state, args) {
  let i = 0;
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
      if (!SAFE_GIT_CONFIG_KEYS.test(key))
        block(`git -c ${key} is not allowed`);
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
  if (sub === undefined || sub === "--version" || sub === "--help")
    return;
  const f = flags(rest);
  const pos = positionals(rest);
  checkGitOptions(state, sub, rest, f);
  switch (sub) {
    case "push":
      return block("git push is not allowed: the factory never pushes");
    case "remote": {
      const action = pos[0];
      if (action === undefined || ["show", "get-url"].includes(action) || f.has("-v") && pos.length === 0)
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
        "-e"
      ];
      if (writes.some((w) => f.has(w)) || ["set", "unset", "rename-section", "remove-section", "edit"].includes(pos[0] ?? ""))
        return block("git config writes are not allowed");
      const reads = [
        "--get",
        "--get-all",
        "--get-regexp",
        "--list",
        "-l",
        "--get-urlmatch",
        "--show-origin",
        "--show-scope"
      ];
      if (reads.some((r) => f.has(r)) || pos[0] === "get" || pos[0] === "list" || pos.length === 1)
        return;
      return block("git config writes are not allowed");
    }
    case "fetch": {
      const forcing = ["-f", "--force", "-u", "--update-head-ok", "--refmap"];
      if (forcing.some((x) => f.has(x)) || rest.some((a) => a.startsWith("--refmap")))
        return block("git fetch with refspec or force options rewrites branches");
      if (pos.length > 1)
        return block("git fetch with a refspec writes branches (fetch a remote by name)");
      const remote = pos[0];
      if (remote !== undefined && (remote === "." || /[:/+*]/.test(remote) || remote.startsWith(".")))
        return block("git fetch from a path or with a refspec is not allowed (fetch a remote by name)");
      return;
    }
    case "difftool":
      return block("git difftool runs external tools");
    case "reset":
      if (f.has("--hard") || f.has("--merge") || f.has("--keep") || f.has("--soft"))
        return block(`git reset ${[...f].join(" ")} rewrites the branch`);
      if (rest.includes("--") || pos.length === 0 || pos[0] === "HEAD" && pos.length > 1)
        return;
      return block("git reset to another commit rewrites the branch");
    case "clean":
      if (f.has("-f") || f.has("--force"))
        return block("git clean -f deletes untracked files");
      return;
    case "checkout": {
      if (f.has("-f") || f.has("--force") || f.has("-b") || f.has("-B") || f.has("--orphan") || f.has("--detach")) {
        return block("git checkout may only restore files");
      }
      if (rest.includes("--"))
        return;
      const exists = state.ctx.exists;
      if (pos.length > 0 && exists && pos.every((p) => exists(resolvePath(state, p) ?? "")))
        return;
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
        "--edit-description"
      ];
      if (mutating.some((m) => f.has(m)))
        return block("git branch may only list branches");
      if (pos.length > 0 && !f.has("--list") && !f.has("-l") && !f.has("--contains") && !f.has("--merged") && !f.has("--no-merged") && !f.has("--points-at")) {
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
        if (abs === undefined)
          return block(`git rm \`${p}\` depends on an unknown variable`);
        const where = locate(state, abs);
        if (where.rel === undefined)
          return block(`git rm \`${p}\` is outside the session directory`);
        if (isProtectedPath(where.rel))
          return block(`git rm of protected path \`${where.rel}\``);
      }
      return;
    case "mv":
      for (const p of pos)
        checkWrite(state, p, "git mv");
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
      if (pos[0] === "list")
        return;
      return block("worktrees are managed by the factory");
    case "submodule":
      if (pos[0] === undefined || pos[0] === "status" || pos[0] === "summary")
        return;
      return block(`git submodule ${pos[0]} is managed by the factory`);
    case "lfs":
      if (["ls-files", "status", "env", "version"].includes(pos[0] ?? ""))
        return;
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
      return block(`git ${sub} is not allowed for agents (history and branches belong to the factory)`);
    default:
      if (GIT_READ_ONLY.has(sub) || GIT_LOCAL_WRITES.has(sub))
        return;
      return block(`unknown git subcommand \`${sub}\` (git aliases are not allowed for agents)`);
  }
}
function checkRm(state, args) {
  for (const t of positionals(args)) {
    const abs = resolvePath(state, t);
    if (abs === undefined)
      return block(`rm \`${t}\` depends on an unknown variable or directory`);
    const where = locate(state, join7(real(state, dirname2(abs)), basename2(abs)));
    if (where.rel === undefined) {
      if (!where.temp)
        block(`rm \`${t}\` is outside the session directory`);
    } else {
      if (where.rel === "" || where.rel === ".")
        block("rm of the whole session directory");
      if (isProtectedPath(where.rel))
        block(`rm of protected path \`${where.rel}\``);
    }
  }
}
function checkLn(state, args) {
  const symbolic = flags(args).has("-s") || flags(args).has("--symbolic");
  const dir = optionValues(args, "t", ["--target-directory"])[0];
  const p = positionals(args).filter((x) => x !== dir);
  const pairs = dir !== undefined ? p.map((t) => ({ target: t, link: join7(dir, basename2(t)) })) : p.length === 1 ? [{ target: p[0] ?? "", link: basename2(p[0] ?? "") }] : p.slice(0, -1).map((t) => ({
    target: t,
    link: p.length > 2 ? join7(p.at(-1) ?? "", basename2(t)) : p.at(-1) ?? ""
  }));
  for (const { target, link } of pairs) {
    checkWrite(state, link, "ln creates");
    const linkAbs = resolvePath(state, link);
    const targetAbs = symbolic && !isAbsolute3(target) && !target.startsWith("~") && !target.startsWith("$") ? linkAbs === undefined ? undefined : resolve4(dirname2(linkAbs), target) : resolvePath(state, target);
    if (targetAbs === undefined)
      block(`ln target \`${target}\` depends on an unknown variable`);
    const where = locate(state, targetAbs);
    if (where.rel === undefined && !where.temp)
      block(`ln \`${target}\` would point outside the session directory`);
    if (where.rel !== undefined && (isProtectedPath(where.rel) || isSecretPath(where.rel)))
      block(`ln \`${target}\` would point at protected path \`${where.rel}\``);
  }
}
function checkScriptFile(state, word, interpreter) {
  const abs = resolvePath(state, word);
  if (abs === undefined)
    return block(`executes \`${word}\`, which depends on an unknown variable`);
  if (state.written.has(abs) || state.written.has(real(state, abs)))
    return block(`executes \`${word}\`, which this same command writes`);
  const text = state.ctx.readFile?.(abs);
  if (text === undefined)
    return;
  const shebang = text.startsWith("#!") ? text.split(`
`)[0] ?? "" : "";
  const isShell = interpreter === "shell" ? shebang === "" || /\b(sh|bash|zsh|dash|ksh)\b/.test(shebang) : false;
  if (isShell) {
    checkScript(state, text);
  } else {
    const found = scanText(text);
    if (found)
      block(`${word}: ${found}`);
  }
}
function xargs(state, rest, stdin) {
  let i = 0;
  let replace;
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
      i += /^-[dEnLPs]$/.test(a) || /^--(delimiter|eof|max-args|max-lines|max-procs|max-chars)$/.test(a) ? 2 : 1;
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
    for (const line of stdin.split(`
`).filter((l) => l.trim() !== "")) {
      checkSimple(state, {
        kind: "simple",
        assigns: [],
        words: cmd.map((word) => word.split(marker).join(line)),
        redirects: [],
        substitutions: []
      }, undefined);
    }
    return [];
  }
  return [...cmd, ...stdin.split(/\s+/).filter(Boolean)];
}
function unwrap(state, words, stdin) {
  let w = words;
  for (let guard = 0;guard < 20 && w.length > 0; guard++) {
    const [head = "", ...rest] = w;
    const alias = state.aliases.get(head);
    if (alias) {
      state.aliases.delete(head);
      w = [...alias, ...rest];
      continue;
    }
    const base = head.slice(head.lastIndexOf("/") + 1);
    if (PRIVILEGE.has(base))
      return block(`${base} is not allowed`);
    if (base === "env") {
      let i = 0;
      while (i < rest.length) {
        const a = rest[i] ?? "";
        if (a === "-u" || a === "--unset") {
          if (PROTECTED_ENV.test(rest[i + 1] ?? ""))
            block(`unsets the factory's environment (${rest[i + 1]})`);
          i += 2;
        } else if (a.startsWith("--unset=")) {
          if (PROTECTED_ENV.test(a.slice(8)))
            block("unsets the factory's environment");
          i += 1;
        } else if (a === "-C" || a === "--chdir") {
          changeDir2(state, rest[i + 1]);
          i += 2;
        } else if (a.startsWith("--chdir=")) {
          changeDir2(state, a.slice("--chdir=".length));
          i += 1;
        } else if (a === "-S" || a === "--split-string") {
          w = [...(rest[i + 1] ?? "").split(/\s+/).filter(Boolean), ...rest.slice(i + 2)];
          i = -1;
          break;
        } else if (a.startsWith("-"))
          i += 1;
        else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
          checkSetEnv(a.split("=")[0] ?? "");
          i += 1;
        } else
          break;
      }
      if (i === -1)
        continue;
      if (i >= rest.length)
        return block("printing the environment may expose secrets");
      w = rest.slice(i);
      continue;
    }
    if (base === "busybox") {
      w = rest;
      continue;
    }
    if ([
      "nohup",
      "time",
      "command",
      "builtin",
      "exec",
      "chronic",
      "caffeinate",
      "unbuffer",
      "setsid"
    ].includes(base)) {
      if (base === "command" && (rest[0] === "-v" || rest[0] === "-V"))
        return [];
      let i = 0;
      while (i < rest.length && (rest[i] ?? "").startsWith("-")) {
        if (rest[i] === "--") {
          i += 1;
          break;
        }
        i += base === "exec" && rest[i] === "-a" ? 2 : 1;
      }
      w = rest.slice(i);
      continue;
    }
    if (base === "nice" || base === "ionice" || base === "stdbuf" || base === "timeout" || base === "flock") {
      let i = 0;
      while (i < rest.length && (rest[i] ?? "").startsWith("-")) {
        const a = rest[i] ?? "";
        i += /^-(n|c|p|k|s|i|o|e|w)$/.test(a) || ["--signal", "--kill-after", "--adjustment"].includes(a) ? 2 : 1;
      }
      if (base === "timeout")
        i += 1;
      if (base === "flock") {
        const c = rest.indexOf("-c");
        if (c !== -1) {
          checkScript(state, rest[c + 1] ?? "");
          return [];
        }
        i += 1;
      }
      w = rest.slice(i);
      continue;
    }
    if (base === "xargs")
      return xargs(state, rest, stdin);
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
function checkAwk(state, args) {
  let program;
  let inplace = false;
  const files = [];
  for (let i = 0;i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-F" || a === "-v")
      i += 1;
    else if (a === "-f" || a === "--file") {
      program = state.ctx.readFile?.(resolvePath(state, args[i + 1] ?? "") ?? "") ?? "";
      i += 1;
    } else if (a === "-i" || a === "--include") {
      if (args[i + 1] === "inplace")
        inplace = true;
      i += 1;
    } else if (a.startsWith("-"))
      continue;
    else if (program === undefined)
      program = a;
    else
      files.push(a);
  }
  const text = program ?? "";
  if (/\bsystem\s*\(|\|\s*&?\s*["$a-zA-Z_]|"\s*\|&?\s*getline|\bgetline\b[^;]*</.test(text))
    block("awk program runs commands (system, pipes or getline)");
  if (/>{1,2}\s*(?!"\/dev\/(stderr|stdout|null)")["$a-zA-Z_]/.test(text.replace(/"[^"]*"/g, '""')))
    block("awk program writes files (use shell redirection instead)");
  const found = scanText(text);
  if (found)
    block(found);
  if (inplace)
    for (const f of files)
      checkWrite(state, f, "edits");
}
function checkSed(state, args) {
  const scripts = [];
  let explicit = false;
  for (let i = 0;i < args.length; i++) {
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
    if (first !== undefined)
      scripts.push(first);
  }
  for (const script of scripts) {
    for (const m of script.matchAll(/s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1([a-zA-Z0-9]*)\s*([^;\n}]*)/g)) {
      const flagText = m[2] ?? "";
      if (flagText.includes("e"))
        block("sed s///e executes commands");
      if (flagText.includes("w"))
        checkWrite(state, (m[3] ?? "").trim(), "sed writes");
    }
    const withoutS = script.replace(/s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-zA-Z0-9]*/g, "");
    for (const m of withoutS.matchAll(/(?:^|[;\n{}])\s*(?:[0-9$]+|\/[^/]*\/)?(?:\s*,\s*(?:[0-9$]+|\/[^/]*\/))?\s*!?\s*([ewWrR])(?:\s+([^;\n}]*))?/g)) {
      const op = m[1];
      const target = (m[2] ?? "").trim();
      if (op === "e")
        block("sed e executes commands");
      if ((op === "w" || op === "W") && target !== "")
        checkWrite(state, target, "sed writes");
      if ((op === "r" || op === "R") && isSecretPath(target))
        block(`sed reads secret file \`${target}\``);
    }
  }
}
function checkSimple(state, cmd, stdin) {
  for (const sub of cmd.substitutions)
    scoped(state, () => checkScriptAst(state, sub));
  checkRedirects(state, cmd.redirects);
  for (const a of cmd.assigns)
    checkSetEnv(a.split("=")[0] ?? "");
  const words = unwrap(state, cmd.words, stdin);
  if (words.length === 0)
    return;
  checkSecretArgs(state, words);
  const [head = "", ...args] = words;
  if (head.includes("$"))
    block(`runs a command whose name is generated at run time (\`${head}\`)`);
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
  if (base === "unset" || base === "export" || base === "declare" || base === "typeset" || base === "readonly") {
    if (args.length === 0 || args.every((a) => a.startsWith("-")))
      block(`${base} without names dumps the environment`);
    for (const a of args.filter((x) => !x.startsWith("-"))) {
      const name = a.split("=")[0] ?? "";
      if (base === "unset" ? PROTECTED_ENV.test(name) : DANGEROUS_ENV.test(name))
        block(`changes the factory's environment (${name})`);
    }
    return;
  }
  if (base === "set" && args.length === 0)
    block("set without arguments dumps the environment");
  if (ENV_DUMPS.has(base))
    block("printing the environment may expose secrets");
  const inputFile = cmd.redirects.find((r) => r.op === "<" || r.op === "<>")?.target;
  if (SHELLS.has(base)) {
    let c = false;
    let fromStdin = false;
    let i = 0;
    for (;i < args.length; i++) {
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
        if (a.startsWith("-") && a.includes("c"))
          c = true;
        if (a.startsWith("-") && a.includes("s"))
          fromStdin = true;
        continue;
      }
      if (a.startsWith("--"))
        continue;
      break;
    }
    const operand = args[i];
    if (c)
      return checkScript(state, operand ?? "");
    if (!fromStdin && operand !== undefined)
      return checkScriptFile(state, operand, "shell");
    if (heredoc !== undefined)
      return checkScript(state, heredoc);
    if (inputFile !== undefined)
      return checkScriptFile(state, inputFile, "shell");
    if (stdin === null)
      block(`pipes generated input into ${base}`);
    if (stdin !== undefined)
      checkScript(state, stdin);
    return;
  }
  if (base === "source" || base === ".") {
    if (args[0] !== undefined)
      checkScriptFile(state, args[0], "shell");
    return;
  }
  if (base === "eval")
    return checkScript(state, args.join(" "));
  if (base === "cd" || base === "pushd" || base === "chdir") {
    changeDir2(state, positionals(args)[0]);
    return;
  }
  if (base === "popd") {
    state.cwd = undefined;
    return;
  }
  const interpreter = base.replace(/\d+(\.\d+)*$/, "");
  if ((interpreter === "perl" || interpreter === "ruby") && args.some(isInPlaceFlag)) {
    const operands = [];
    let code = false;
    for (let k = 0;k < args.length; k++) {
      const a = args[k] ?? "";
      if (a === "-e" || a === "-E") {
        code = true;
        k++;
      } else if (/^-[IMx]$/.test(a))
        k++;
      else if (!a.startsWith("-"))
        operands.push(a);
    }
    for (const f of code ? operands : operands.slice(1))
      checkWrite(state, f, `${interpreter} -i edits`);
  }
  const inline = INTERPRETERS[interpreter] ?? INTERPRETERS[base];
  if (inline) {
    const i = args.findIndex((a) => inline.includes(a));
    const joined = args.find((a) => inline.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)));
    if (i !== -1 || joined !== undefined) {
      const code = joined !== undefined ? joined.slice(joined.indexOf("=") + 1) : args[i + 1] ?? "";
      const found = scanInline(code);
      if (found)
        block(found);
      return;
    }
    const file = args.find((a) => !a.startsWith("-"));
    if (base === "bun" && file !== undefined) {
      checkPackageScript(state, "bun", args);
      return;
    }
    if (file !== undefined)
      return checkScriptFile(state, file, "other");
    if (heredoc !== undefined) {
      const found = scanInline(heredoc);
      if (found)
        block(found);
      return;
    }
    if (inputFile !== undefined)
      return checkScriptFile(state, inputFile, "other");
    if (stdin === null)
      block(`pipes generated input into ${base}`);
    if (stdin !== undefined) {
      const found = scanInline(stdin);
      if (found)
        block(found);
    }
    return;
  }
  if (COMMAND_RUNNERS.has(base))
    block(`${base} runs commands the factory cannot inspect`);
  if (EDITORS.has(base) && args.some((a) => /^(-c|--cmd|-S|-s|\+.*|--eval|-l|--load|-x)$/.test(a)))
    block(`${base} with commands is not allowed (edit files directly)`);
  if (AWKS.has(base))
    checkAwk(state, args);
  if (base === "sed" || base === "gsed")
    checkSed(state, args);
  if (base === "script") {
    const c = args.findIndex((a) => a === "-c" || a === "--command");
    if (c !== -1)
      return checkScript(state, args[c + 1] ?? "");
  }
  if (base === "fd" || base === "fdfind") {
    const x = args.findIndex((a) => ["-x", "--exec", "-X", "--exec-batch"].includes(a));
    if (x !== -1) {
      checkSimple(state, { kind: "simple", assigns: [], words: args.slice(x + 1), redirects: [], substitutions: [] }, undefined);
      return;
    }
  }
  if (head.includes("/"))
    checkScriptFile(state, head, "shell");
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
        checkSimple(state, {
          kind: "simple",
          assigns: [],
          words: args.slice(exec + 1, end === -1 ? undefined : end),
          redirects: [],
          substitutions: []
        }, undefined);
      }
      if (args.includes("-delete"))
        for (const p of args.filter((a) => !a.startsWith("-")).slice(0, 1))
          checkRm(state, [p]);
      return;
    }
    case "tee":
      for (const p of positionals(args))
        checkWrite(state, p, "writes");
      return;
    case "ln":
      checkLn(state, args);
      return;
    case "cp":
    case "install":
    case "rsync": {
      const dir = optionValues(args, "t", ["--target-directory"]);
      for (const d of dir)
        checkWrite(state, d, "writes into");
      const p = positionals(args).filter((x) => !dir.includes(x));
      const dest = p.at(-1);
      if (dir.length === 0 && dest !== undefined && p.length > 1)
        checkWrite(state, dest, "writes");
      return;
    }
    case "mv":
      for (const p of positionals(args))
        checkWrite(state, p, "moves");
      for (const d of optionValues(args, "t", ["--target-directory"]))
        checkWrite(state, d, "moves into");
      return;
    case "curl":
      for (const t of [
        ...optionValues(args, "o", ["--output"]),
        ...optionValues(args, "D", ["--dump-header"]),
        ...optionValues(args, "c", ["--cookie-jar"]),
        ...optionValues(args, "", ["--output-dir", "--trace", "--trace-ascii", "--stderr"])
      ])
        if (t !== "-")
          checkWrite(state, t, "curl writes");
      return;
    case "wget":
      for (const t of [
        ...optionValues(args, "O", ["--output-document"]),
        ...optionValues(args, "P", ["--directory-prefix"]),
        ...optionValues(args, "o", ["--output-file"]),
        ...optionValues(args, "a", ["--append-output"])
      ])
        if (t !== "-")
          checkWrite(state, t, "wget writes");
      return;
    case "tar":
    case "bsdtar":
    case "gtar": {
      const old = /^[A-Za-z]+$/.test(args[0] ?? "") ? args[0] ?? "" : "";
      const letters = old + args.filter((a) => /^-[A-Za-z]+$/.test(a)).map((a) => a.slice(1)).join("");
      const extract = letters.includes("x") || args.includes("--extract") || args.includes("--get");
      const create = /[cru]/.test(letters) || args.some((a) => ["--create", "--append", "--update"].includes(a));
      if (extract)
        for (const d of optionValues(args, "C", ["--directory"]))
          checkWrite(state, d, "tar extracts into");
      const file = old.includes("f") ? args[1] : optionValues(args, "f", ["--file"])[0];
      if (create && file !== undefined && file !== "-")
        checkWrite(state, file, "tar writes");
      return;
    }
    case "unzip":
      for (const d of optionValues(args, "d", []))
        checkWrite(state, d, "unzip extracts into");
      return;
    case "zip": {
      const archive = positionals(args)[0];
      if (archive !== undefined)
        checkWrite(state, archive, "zip writes");
      return;
    }
    case "sort":
      for (const t of optionValues(args, "o", ["--output"]))
        checkWrite(state, t, "sort writes");
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
        for (const p of positionals(args).slice(1))
          checkWrite(state, p, "edits");
      }
      return;
    case "dd":
      for (const a of args.filter((x) => x.startsWith("of=")))
        checkWrite(state, a.slice(3), "writes");
      return;
    case "graphify": {
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub && ["query", "explain", "path", "affected", "god-nodes"].includes(sub))
        return;
      return block(`graphify ${sub ?? ""} is not allowed: the factory updates the graph`);
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (args.some((a) => a === "-g" || a === "--global" || a === "--location=global") || args[0] === "global" || args[0] === "link")
        return block(`${base} global installs change the machine, not the worktree`);
      if (args.some((a) => a === "publish" || a === "login" || a === "adduser" || a === "unpublish" || a === "deprecate")) {
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
      if (base === "uv" && args[0] === "tool")
        return block("uv tool changes the machine");
      return;
    case "go":
      if (args[0] === "install")
        return block("go install changes the machine, not the worktree");
      return;
    case "pip":
    case "pip3":
      if (args.includes("--user") || args.includes("--break-system-packages"))
        return block(`${base} install outside the project environment is not allowed`);
      return;
    case "brew":
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
function literalOutput(cmd) {
  if (cmd.kind !== "simple" || cmd.substitutions.length > 0)
    return;
  const [head, ...args] = cmd.words;
  if (head === "echo")
    return args.filter((a) => !/^-[neE]+$/.test(a)).join(" ");
  if (head === "printf")
    return args[0]?.replace(/\\n/g, `
`);
  if (head === "cat" && args.length === 0)
    return cmd.redirects.find((r) => r.body !== undefined)?.body;
  return;
}
function checkPipeline(state, pipeline) {
  const { commands } = pipeline;
  commands.forEach((cmd, i) => {
    const prev = commands[i - 1];
    let stdin;
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
function scoped(state, fn) {
  const cwd = state.cwd;
  try {
    fn();
  } finally {
    state.cwd = cwd;
  }
}
function checkScriptAst(state, script) {
  if (++state.depth > 25)
    block("command nests too deeply to inspect");
  try {
    for (const p of script.pipelines)
      checkPipeline(state, p);
  } finally {
    state.depth--;
  }
}
function checkScript(state, text) {
  checkScriptAst(state, parseScript(text));
  return;
}
function checkShell(command, ctx) {
  const state = { ctx, aliases: new Map, depth: 0, cwd: ctx.cwd, written: new Set };
  try {
    checkScript(state, command);
    return { allowed: true };
  } catch (err) {
    if (err instanceof Blocked)
      return { allowed: false, reason: err.message };
    if (err instanceof ShellParseError)
      return { allowed: false, reason: `cannot parse the command (${err.message}); simplify it` };
    throw err;
  }
}

// src/plugin/entry.ts
var FACTORY_AGENTS = new Set([
  "orchestrator",
  "architect",
  "explorer",
  "reviewer",
  "contract-reviewer",
  "tester"
]);
var isFactoryAgent = (agent) => FACTORY_AGENTS.has(agent) || agent.startsWith("implementer-");
var MAX_SCRIPT_BYTES = 256 * 1024;
function readText(abs) {
  try {
    if (statSync3(abs).size > MAX_SCRIPT_BYTES)
      return;
    const text = readFileSync3(abs, "utf8");
    return text.includes("\x00") ? undefined : text;
  } catch {
    return;
  }
}
var pinned = new Map;
function loadContext(workspace, sessionID) {
  let raw;
  try {
    raw = readFileSync3(sessionContextFile(workspace, sessionID), "utf8");
  } catch {
    return;
  }
  const first = pinned.get(sessionID);
  if (first === undefined)
    pinned.set(sessionID, raw);
  else if (first !== raw)
    return;
  try {
    return parseSessionContext(JSON.parse(raw));
  } catch {
    return;
  }
}
var str = (v) => typeof v === "string" ? v : undefined;
var field = (input, ...keys) => {
  if (typeof input !== "object" || input === null)
    return;
  const rec = input;
  for (const k of keys) {
    const v = str(rec[k]);
    if (v !== undefined)
      return v;
  }
  return;
};
function checkEditReal(ctx, path, approved) {
  const verdict = checkEdit(ctx, path, approved);
  if (!verdict.allowed)
    throw new Refused(verdict.reason);
  const abs = isAbsolute4(path) ? path : resolve5(ctx.directory, path);
  const realDir = realPathOf(ctx.directory);
  const realAbs = realPathOf(abs);
  const rel = relative3(realDir, realAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute4(rel))
    throw new Refused(`\`${path}\` resolves outside your directory through a symlink`);
  const real = checkEdit(ctx, join8(ctx.directory, rel), approved);
  if (!real.allowed)
    throw new Refused(`${real.reason} (through a symlink at \`${path}\`)`);
}
var isSecretReal = (directory, path) => isSecretPath(path) || isSecretPath(realPathOf(isAbsolute4(path) ? path : resolve5(directory, path)));

class Refused extends Error {
  constructor(reason) {
    super(`ai-factory blocked this call: ${reason}`);
  }
}
var reads = new Map;
function guard(workspace, event) {
  const ctx = loadContext(workspace, event.sessionID);
  if (ctx === undefined)
    throw new Refused(`no session context for ${event.sessionID}`);
  const approved = () => {
    const check = checkApprovalHash(workspace, ctx.changeId);
    return check.valid ? true : check.reason;
  };
  const input = event.input;
  switch (event.tool) {
    case "shell": {
      const command = field(input, "command") ?? "";
      const workdir = field(input, "workdir");
      const cwd = workdir === undefined ? ctx.directory : resolve5(ctx.directory, workdir);
      const root = ctx.role === "architect" ? ctx.workspace : ctx.directory;
      if (!`${cwd}/`.startsWith(`${root}/`) && cwd !== root)
        throw new Refused(`workdir ${workdir} is outside your directory`);
      const verdict = checkShell(command, {
        cwd,
        root,
        env: process.env,
        readFile: readText,
        exists: (abs) => existsSync4(abs),
        readdir: listDir,
        realpath: realPathOf,
        workspace: ctx.workspace
      });
      if (!verdict.allowed)
        throw new Refused(verdict.reason);
      approveShell(command, ctx);
      return { ctx };
    }
    case "edit":
    case "write": {
      checkEditReal(ctx, field(input, "path", "filePath") ?? "", approved);
      return { ctx };
    }
    case "patch":
    case "apply_patch": {
      const paths = patchPaths(field(input, "patchText", "patch") ?? "");
      if (paths === undefined)
        throw new Refused("cannot tell which files this patch changes; use the edit tool");
      for (const path of paths)
        checkEditReal(ctx, path, approved);
      return { ctx };
    }
    case "read": {
      const path = field(input, "path", "filePath") ?? "";
      if (isSecretReal(ctx.directory, path))
        throw new Refused(`\`${path}\` is a secret file`);
      const abs = isAbsolute4(path) ? path : join8(ctx.directory, path);
      try {
        const st = statSync3(abs);
        const stamp = `${st.mtimeMs}:${st.size}`;
        const seen = reads.get(event.sessionID) ?? new Map;
        reads.set(event.sessionID, seen);
        const note = seen.get(abs) === stamp ? "repeated read of an unchanged file" : undefined;
        seen.set(abs, stamp);
        return note === undefined ? { ctx } : { ctx, note };
      } catch {
        return { ctx };
      }
    }
    case "glob":
    case "grep": {
      const path = field(input, "path");
      if (path !== undefined && isSecretReal(ctx.directory, path))
        throw new Refused(`\`${path}\` is a secret file`);
      const root = path === undefined ? ctx.directory : resolve5(ctx.directory, path);
      if (event.tool === "glob") {
        const pattern = field(input, "pattern") ?? "";
        const hit = globMatchesSecret(isAbsolute4(pattern) ? pattern : join8(root, pattern), listDir);
        if (hit !== undefined)
          throw new Refused(`\`${pattern}\` matches secret file \`${hit}\``);
        return { ctx };
      }
      const secret = findSecretUnder(root, listDir);
      if (secret !== undefined)
        throw new Refused(`the search covers secret file \`${secret}\`; search specific directories instead`);
      return { ctx };
    }
    default:
      return { ctx };
  }
}
var CONTENT_FIELDS = new Set([
  "content",
  "oldString",
  "newString",
  "patchText",
  "patch",
  "edits"
]);
var summarize = (input, tool) => {
  if (typeof input !== "object" || input === null)
    return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const text = typeof v === "string" ? v : JSON.stringify(v ?? null);
    out[k] = CONTENT_FIELDS.has(k) ? `(${text.length} chars)` : typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}\u2026 (${v.length} chars)` : v;
  }
  if (tool === "apply_patch" || tool === "patch") {
    const paths = patchPaths(String(input.patchText ?? ""));
    if (paths !== undefined)
      out.files = paths;
  }
  return out;
};
var listDir = (abs) => {
  try {
    return readdirSync3(abs);
  } catch {
    return;
  }
};
var approvedShells = new Map;
function approveShell(command, ctx) {
  approvedShells.set(command, [...approvedShells.get(command) ?? [], ctx]);
}
function sandboxPolicy(workspace, ctx) {
  if (ctx.role === "implementer" || ctx.role === "tester")
    return { ...checkoutPolicy(workspace, ctx.directory), denySecretReads: true };
  const home = process.env.HOME;
  const writable = ctx.role === "architect" ? [
    join8(ctx.directory, "openspec", "changes", ctx.changeId),
    join8(workspace, ".factory", "context", ctx.changeId)
  ] : [];
  return { workspace, writable, denySecretReads: true, ...home === undefined ? {} : { home } };
}
function onShellCreate(workspace, event) {
  const queue = approvedShells.get(event.command);
  const ctx = queue?.shift();
  if (queue !== undefined && queue.length === 0)
    approvedShells.delete(event.command);
  if (ctx === undefined)
    throw new Refused("shell commands run only through a factory agent's shell tool");
  const scrub = (process.env.AI_FACTORY_SCRUB ?? "").split(",").filter(Boolean);
  if (event.env !== undefined) {
    for (const name of ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", ...scrub])
      delete event.env[name];
  }
  if (process.env.AI_FACTORY_SANDBOX === "seatbelt") {
    const shell = typeof event.shell === "string" && event.shell.startsWith("/") ? event.shell : "/bin/bash";
    event.command = sandboxCommand(seatbeltProfile(sandboxPolicy(workspace, ctx)), shell, event.command);
  }
}
var entry_default = {
  id: "ai-factory",
  async setup(ctx) {
    const workspace = process.env.AI_FACTORY_WORKSPACE;
    if (workspace === undefined)
      return;
    await ctx.shell?.hook("create.before", (event) => onShellCreate(workspace, event));
    await ctx.tool.hook("execute.before", (event) => {
      if (!isFactoryAgent(event.agent))
        throw new Refused(`agent \`${event.agent}\` does not run on the factory's server`);
      let changeId = "unknown";
      try {
        const { ctx: session, note } = guard(workspace, event);
        changeId = session.changeId;
        appendLog(workspace, changeId, {
          kind: note === undefined ? "tool" : "waste",
          session: event.sessionID,
          agent: event.agent,
          tool: event.tool,
          input: summarize(event.input, event.tool),
          ...note === undefined ? {} : { note }
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        appendLog(workspace, changeId === "unknown" ? loadContext(workspace, event.sessionID)?.changeId ?? "unknown" : changeId, {
          kind: "blocked",
          session: event.sessionID,
          agent: event.agent,
          tool: event.tool,
          input: summarize(event.input, event.tool),
          reason
        });
        throw err instanceof Refused ? err : new Refused(reason);
      }
    });
    await ctx.tool.hook("execute.after", (event) => {
      if (!isFactoryAgent(event.agent))
        return;
      const session = loadContext(workspace, event.sessionID);
      appendLog(workspace, session?.changeId ?? "unknown", {
        kind: "tool-result",
        session: event.sessionID,
        agent: event.agent,
        tool: event.tool,
        status: event.status
      });
    });
  }
};
export {
  entry_default as default
};
