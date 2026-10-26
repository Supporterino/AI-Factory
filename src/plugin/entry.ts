/**
 * ai-factory opencode v2 plugin (bundled into .opencode/plugins/factory.js by init).
 *
 * Guards every tool call of a factory agent before it runs (`tool.execute.before`; a thrown
 * error rejects that call only) and logs every call. Nothing is imported from an opencode
 * package: a plain file in .opencode/plugins/ cannot resolve one, so the hook shapes below
 * mirror @opencode/plugin 2.1.2 (promise API: `ctx.tool.hook(name, callback)`).
 *
 * The CLI starts the opencode server with AI_FACTORY_WORKSPACE set and writes a session
 * context file per session. Without the variable (a human's own opencode) the plugin does
 * nothing; a factory agent without a context file is refused everything.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { checkApprovalHash } from "../approval/approval.ts";
import { appendLog } from "../logs/log.ts";
import { isSecretPath } from "../policy/paths.ts";
import { realPathOf } from "../policy/realpath.ts";
import {
  checkoutPolicy,
  type SandboxPolicy,
  sandboxCommand,
  seatbeltProfile,
} from "../policy/sandbox.ts";
import {
  checkEdit,
  parseSessionContext,
  patchPaths,
  type SessionContext,
} from "../policy/scope.ts";
import { findSecretUnder, globMatchesSecret } from "../policy/secrets.ts";
import { sessionContextFile } from "../policy/session-files.ts";
import { checkShell } from "../policy/shell.ts";

interface ToolEvent {
  tool: string;
  readonly sessionID: string;
  readonly agent: string;
  input: unknown;
}

interface ToolAfterEvent extends ToolEvent {
  readonly status: "completed" | "error";
}

/** What opencode is about to spawn for a shell (`shell` hook `create.before`, mutable). */
interface ShellCreateEvent {
  command: string;
  cwd?: string;
  shell?: unknown;
  env?: Record<string, string | undefined>;
}

interface PluginContext {
  readonly tool: {
    hook(name: "execute.before", cb: (e: ToolEvent) => Promise<void> | void): Promise<void> | void;
    hook(
      name: "execute.after",
      cb: (e: ToolAfterEvent) => Promise<void> | void,
    ): Promise<void> | void;
  };
  readonly shell?: {
    hook(
      name: "create.before",
      cb: (e: ShellCreateEvent) => Promise<void> | void,
    ): Promise<void> | void;
  };
}

const FACTORY_AGENTS = new Set([
  "orchestrator",
  "architect",
  "explorer",
  "reviewer",
  "contract-reviewer",
  "tester",
]);
const isFactoryAgent = (agent: string): boolean =>
  FACTORY_AGENTS.has(agent) || agent.startsWith("implementer-");

const MAX_SCRIPT_BYTES = 256 * 1024;

function readText(abs: string): string | undefined {
  try {
    if (statSync(abs).size > MAX_SCRIPT_BYTES) return undefined;
    const text = readFileSync(abs, "utf8");
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The context each session started with: the file must not change under a running session. */
const pinned = new Map<string, string>();

function loadContext(workspace: string, sessionID: string): SessionContext | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionContextFile(workspace, sessionID), "utf8");
  } catch {
    return undefined;
  }
  const first = pinned.get(sessionID);
  if (first === undefined) pinned.set(sessionID, raw);
  else if (first !== raw) return undefined; // rewritten mid-session: refuse everything
  try {
    return parseSessionContext(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const field = (input: unknown, ...keys: string[]): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  for (const k of keys) {
    const v = str(rec[k]);
    if (v !== undefined) return v;
  }
  return undefined;
};

/**
 * Judges an edit both as named and where it really lands: a symlink inside the worktree must
 * not carry the write out of it or onto a protected file.
 */
function checkEditReal(ctx: SessionContext, path: string, approved: () => true | string): void {
  const verdict = checkEdit(ctx, path, approved);
  if (!verdict.allowed) throw new Refused(verdict.reason);
  const abs = isAbsolute(path) ? path : resolve(ctx.directory, path);
  const realDir = realPathOf(ctx.directory);
  const realAbs = realPathOf(abs);
  const rel = relative(realDir, realAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new Refused(`\`${path}\` resolves outside your directory through a symlink`);
  const real = checkEdit(ctx, join(ctx.directory, rel), approved);
  if (!real.allowed) throw new Refused(`${real.reason} (through a symlink at \`${path}\`)`);
}

const isSecretReal = (directory: string, path: string): boolean =>
  isSecretPath(path) ||
  isSecretPath(realPathOf(isAbsolute(path) ? path : resolve(directory, path)));

class Refused extends Error {
  constructor(reason: string) {
    super(`ai-factory blocked this call: ${reason}`);
  }
}

/** Per session: path → "mtime:size" of the last read, to report repeated reads of unchanged files. */
const reads = new Map<string, Map<string, string>>();

function guard(workspace: string, event: ToolEvent): { ctx: SessionContext; note?: string } {
  const ctx = loadContext(workspace, event.sessionID);
  if (ctx === undefined) throw new Refused(`no session context for ${event.sessionID}`);
  const approved = (): true | string => {
    const check = checkApprovalHash(workspace, ctx.changeId);
    return check.valid ? true : check.reason;
  };
  const input = event.input;

  switch (event.tool) {
    case "shell": {
      const command = field(input, "command") ?? "";
      const workdir = field(input, "workdir");
      const cwd = workdir === undefined ? ctx.directory : resolve(ctx.directory, workdir);
      const root = ctx.role === "architect" ? ctx.workspace : ctx.directory;
      if (!`${cwd}/`.startsWith(`${root}/`) && cwd !== root)
        throw new Refused(`workdir ${workdir} is outside your directory`);
      const verdict = checkShell(command, {
        cwd,
        root,
        env: process.env,
        readFile: readText,
        exists: (abs) => existsSync(abs),
        readdir: listDir,
        realpath: realPathOf,
        workspace: ctx.workspace,
      });
      if (!verdict.allowed) throw new Refused(verdict.reason);
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
      for (const path of paths) checkEditReal(ctx, path, approved);
      return { ctx };
    }
    case "read": {
      const path = field(input, "path", "filePath") ?? "";
      if (isSecretReal(ctx.directory, path)) throw new Refused(`\`${path}\` is a secret file`);
      const abs = isAbsolute(path) ? path : join(ctx.directory, path);
      try {
        const st = statSync(abs);
        const stamp = `${st.mtimeMs}:${st.size}`;
        const seen = reads.get(event.sessionID) ?? new Map<string, string>();
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
      const root = path === undefined ? ctx.directory : resolve(ctx.directory, path);
      if (event.tool === "glob") {
        // The glob's matches are paths, not contents, but they name what to read next.
        const pattern = field(input, "pattern") ?? "";
        const hit = globMatchesSecret(isAbsolute(pattern) ? pattern : join(root, pattern), listDir);
        if (hit !== undefined) throw new Refused(`\`${pattern}\` matches secret file \`${hit}\``);
        return { ctx };
      }
      // grep reads every file under its path, hidden ones included (audit S11).
      const secret = findSecretUnder(root, listDir);
      if (secret !== undefined)
        throw new Refused(
          `the search covers secret file \`${secret}\`; search specific directories instead`,
        );
      return { ctx };
    }
    default:
      return { ctx };
  }
}

/** Fields that carry file contents: logged as their length only (audit S19). */
const CONTENT_FIELDS = new Set([
  "content",
  "oldString",
  "newString",
  "patchText",
  "patch",
  "edits",
]);

const summarize = (input: unknown, tool?: string): unknown => {
  if (typeof input !== "object" || input === null) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    // Keep commands and paths; never log file contents.
    const text = typeof v === "string" ? v : JSON.stringify(v ?? null);
    out[k] = CONTENT_FIELDS.has(k)
      ? `(${text.length} chars)`
      : typeof v === "string" && v.length > 2000
        ? `${v.slice(0, 2000)}… (${v.length} chars)`
        : v;
  }
  // A patch's files are worth keeping; its contents are not.
  if (tool === "apply_patch" || tool === "patch") {
    const paths = patchPaths(String((input as Record<string, unknown>).patchText ?? ""));
    if (paths !== undefined) out.files = paths;
  }
  return out;
};

const listDir = (abs: string): string[] | undefined => {
  try {
    return readdirSync(abs);
  } catch {
    return undefined;
  }
};

/** Shell commands the guard allowed, waiting for opencode to spawn them (FIFO per text). */
const approvedShells = new Map<string, SessionContext[]>();

function approveShell(command: string, ctx: SessionContext): void {
  approvedShells.set(command, [...(approvedShells.get(command) ?? []), ctx]);
}

/** What a session's programs may write: its worktree, or for the architect its two folders. */
function sandboxPolicy(workspace: string, ctx: SessionContext): SandboxPolicy {
  if (ctx.role === "implementer" || ctx.role === "tester")
    return { ...checkoutPolicy(workspace, ctx.directory), denySecretReads: true };
  const home = process.env.HOME;
  const writable =
    ctx.role === "architect"
      ? [
          join(ctx.directory, "openspec", "changes", ctx.changeId),
          join(workspace, ".factory", "context", ctx.changeId),
        ]
      : [];
  return { workspace, writable, denySecretReads: true, ...(home === undefined ? {} : { home }) };
}

/**
 * Every shell opencode spawns: it must be a command the guard allowed (opencode's REST shell
 * API is refused), it loses the server password and credentials, and it runs sandboxed.
 */
function onShellCreate(workspace: string, event: ShellCreateEvent): void {
  const queue = approvedShells.get(event.command);
  const ctx = queue?.shift();
  if (queue !== undefined && queue.length === 0) approvedShells.delete(event.command);
  if (ctx === undefined)
    throw new Refused("shell commands run only through a factory agent's shell tool");
  const scrub = (process.env.AI_FACTORY_SCRUB ?? "").split(",").filter(Boolean);
  if (event.env !== undefined) {
    for (const name of ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", ...scrub])
      delete event.env[name];
  }
  if (process.env.AI_FACTORY_SANDBOX === "seatbelt") {
    const shell =
      typeof event.shell === "string" && event.shell.startsWith("/") ? event.shell : "/bin/bash";
    event.command = sandboxCommand(
      seatbeltProfile(sandboxPolicy(workspace, ctx)),
      shell,
      event.command,
    );
  }
}

export default {
  id: "ai-factory",
  async setup(ctx: PluginContext): Promise<void> {
    const workspace = process.env.AI_FACTORY_WORKSPACE;
    if (workspace === undefined) return;

    await ctx.shell?.hook("create.before", (event) => onShellCreate(workspace, event));

    await ctx.tool.hook("execute.before", (event) => {
      // The factory's server runs factory agents only (anyone holding the password could
      // otherwise start an unguarded built-in agent).
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
          ...(note === undefined ? {} : { note }),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        appendLog(
          workspace,
          changeId === "unknown"
            ? (loadContext(workspace, event.sessionID)?.changeId ?? "unknown")
            : changeId,
          {
            kind: "blocked",
            session: event.sessionID,
            agent: event.agent,
            tool: event.tool,
            input: summarize(event.input, event.tool),
            reason,
          },
        );
        throw err instanceof Refused ? err : new Refused(reason);
      }
    });

    await ctx.tool.hook("execute.after", (event) => {
      if (!isFactoryAgent(event.agent)) return;
      const session = loadContext(workspace, event.sessionID);
      appendLog(workspace, session?.changeId ?? "unknown", {
        kind: "tool-result",
        session: event.sessionID,
        agent: event.agent,
        tool: event.tool,
        status: event.status,
      });
    });
  },
};
