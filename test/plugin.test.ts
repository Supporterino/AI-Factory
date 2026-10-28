import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundlePlugin, PLUGIN_OUT } from "../scripts/build-plugin.ts";
import { approvalFile, specHash } from "../src/approval/approval.ts";
import { appendLog, pruneLogs } from "../src/logs/log.ts";
import { redact, secretEnvValues } from "../src/logs/redact.ts";
import { auditChanges, type SessionContext } from "../src/policy/scope.ts";
import { sessionContextFile } from "../src/policy/session-files.ts";
import { writeFiles } from "./fixtures/workspaces.ts";

type Hook = (event: {
  tool: string;
  sessionID: string;
  agent: string;
  input: unknown;
  status?: string;
}) => unknown;

let ws: string;
let wt: string;
const hooks = new Map<string, Hook>();

const ID = "add-x";
const TASKS = "- [ ] 1.1 Add health\n  - repo: app\n  - deps: none\n  - touches: src/**\n";

function session(
  id: string,
  ctx: Omit<SessionContext, "sessionId" | "changeId" | "workspace">,
): void {
  const file = sessionContextFile(ws, id);
  mkdirSync(join(ws, ".factory", "sessions"), { recursive: true });
  writeFileSync(file, JSON.stringify({ sessionId: id, changeId: ID, workspace: ws, ...ctx }));
}

function approve(): void {
  mkdirSync(join(ws, ".factory", "approvals"), { recursive: true });
  writeFileSync(
    approvalFile(ws, ID),
    JSON.stringify({
      changeId: ID,
      approver: "dev@example.com",
      specCommit: "a".repeat(40),
      hash: specHash(ws, ID),
      approvedAt: "now",
    }),
  );
}

async function call(
  sessionID: string,
  agent: string,
  tool: string,
  input: unknown,
): Promise<string | undefined> {
  const before = hooks.get("execute.before");
  if (!before) throw new Error("no hook");
  try {
    await before({ tool, sessionID, agent, input });
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "ai-factory-plugin-"));
  wt = join(ws, ".factory", "worktrees", ID, "app", "1.1");
  writeFiles(ws, {
    [`openspec/changes/${ID}/proposal.md`]: "## Why\nBecause.\n",
    [`openspec/changes/${ID}/tasks.md`]: TASKS,
    [`openspec/changes/${ID}/specs/health/spec.md`]: "## ADDED Requirements\n",
  });
  writeFiles(wt, {
    "src/sum.ts": "x",
    "src/sum.test.ts": "y",
    "tests/other.test.ts": "z",
    "factory.config.jsonc": "{}",
  });
  session("impl", {
    role: "implementer",
    directory: wt,
    repo: "app",
    task: "1.1",
    touches: ["src/**"],
    testGlobs: ["tests/*.test.ts"],
  });
  session("tester", { role: "tester", directory: wt, repo: "app", testGlobs: ["*.test.ts"] });
  session("arch", { role: "architect", directory: ws });
  session("rev", { role: "reviewer", directory: wt });

  // Load the committed bundle exactly as opencode would: a plain ES module file.
  const file = join(ws, "factory.mjs");
  writeFileSync(file, readFileSync(PLUGIN_OUT, "utf8"));
  process.env.AI_FACTORY_WORKSPACE = ws;
  const plugin = (await import(file)).default as {
    id: string;
    setup: (ctx: unknown) => Promise<void>;
  };
  expect(plugin.id).toBe("ai-factory");
  await plugin.setup({
    tool: { hook: (name: string, cb: Hook) => void hooks.set(name, cb) },
    shell: { hook: (name: string, cb: Hook) => void hooks.set(`shell.${name}`, cb) },
  });
  delete process.env.AI_FACTORY_WORKSPACE;
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));
beforeEach(() => rmSync(approvalFile(ws, ID), { force: true }));

describe("plugin bundle", () => {
  test("the committed bundle is up to date (run `bun run build:plugin`)", async () => {
    expect(readFileSync(PLUGIN_OUT, "utf8")).toBe(await bundlePlugin());
  });
});

describe("plugin guards", () => {
  test("refuses agents that are not factory agents", async () => {
    expect(await call("whatever", "build", "shell", { command: "ls" })).toContain(
      "does not run on the factory's server",
    );
  });

  test("shells: only guarded commands spawn, without credentials, sandboxed", async () => {
    const create = hooks.get("shell.create.before") as unknown as (e: {
      command: string;
      shell?: string;
      env?: Record<string, string | undefined>;
    }) => unknown;
    expect(() => create({ command: "id", env: {} })).toThrow("only through a factory agent");

    process.env.AI_FACTORY_SCRUB = "ANTHROPIC_API_KEY";
    process.env.AI_FACTORY_SANDBOX = process.platform === "darwin" ? "seatbelt" : "off";
    try {
      // A write the parser cannot see; the sandbox must stop it.
      const command = `echo inside > ok.txt; python3 -c "open('../escape.txt','w').write('x')"`;
      expect(await call("impl", "implementer-app", "shell", { command })).toBeUndefined();
      const event = {
        command,
        shell: "/bin/sh",
        env: { PATH: "/usr/bin:/bin", OPENCODE_PASSWORD: "pw", ANTHROPIC_API_KEY: "k" } as Record<
          string,
          string | undefined
        >,
      };
      create(event);
      expect(event.env).toEqual({ PATH: "/usr/bin:/bin" });
      // The same command again needs its own guard pass.
      expect(() => create({ command, env: {} })).toThrow("only through a factory agent");
      if (process.platform === "darwin") {
        expect(event.command).toStartWith("exec '/usr/bin/sandbox-exec' -p");
        spawnSync("/bin/sh", ["-c", event.command], { cwd: wt });
        expect(existsSync(join(wt, "ok.txt"))).toBe(true);
        expect(existsSync(join(wt, "..", "escape.txt"))).toBe(false);
        rmSync(join(wt, "ok.txt"));
      }
    } finally {
      delete process.env.AI_FACTORY_SCRUB;
      delete process.env.AI_FACTORY_SANDBOX;
    }
  });

  test("refuses factory agents without a session context", async () => {
    expect(await call("nope", "implementer-app", "shell", { command: "ls" })).toContain(
      "no session context",
    );
  });

  test("shell blocklist, including evasions and workdirs", async () => {
    expect(
      await call("impl", "implementer-app", "shell", { command: "go test ./..." }),
    ).toBeUndefined();
    expect(
      await call("impl", "implementer-app", "shell", { command: "sh -c 'git push'" }),
    ).toContain("git push is not allowed");
    expect(
      await call("impl", "implementer-app", "shell", { command: "ls", workdir: "/" }),
    ).toContain("outside your directory");
  });

  test("no implementation edits before a valid approval; checkbox ticks keep it valid", async () => {
    expect(await call("impl", "implementer-app", "edit", { path: "src/sum.ts" })).toContain(
      "change add-x is not approved; implementation edits are blocked",
    );
    approve();
    expect(await call("impl", "implementer-app", "edit", { path: "src/sum.ts" })).toBeUndefined();
    const tasks = join(ws, "openspec/changes", ID, "tasks.md");
    writeFileSync(tasks, TASKS.replace("- [ ]", "- [x]"));
    expect(
      await call("impl", "implementer-app", "write", { path: "src/new.ts", content: "z" }),
    ).toBeUndefined();
    writeFileSync(tasks, TASKS.replace("touches: src/**", "touches: **"));
    expect(await call("impl", "implementer-app", "edit", { path: "src/sum.ts" })).toContain(
      "changed after approval",
    );
    writeFileSync(tasks, TASKS);
  });

  test("implementers may edit the repo's test files outside touches", async () => {
    approve();
    expect(
      await call("impl", "implementer-app", "edit", { path: "tests/other.test.ts" }),
    ).toBeUndefined();
    expect(await call("impl", "implementer-app", "edit", { path: "README.md" })).toContain(
      "outside this task's touches",
    );
  });

  test("a session context rewritten mid-session is refused", async () => {
    session("pin", { role: "reviewer", directory: wt });
    expect(await call("pin", "reviewer", "read", { path: "src/sum.ts" })).toBeUndefined();
    session("pin", { role: "implementer", directory: ws, touches: ["**"] });
    expect(await call("pin", "reviewer", "read", { path: "src/sum.ts" })).toContain(
      "no session context",
    );
  });

  test("symlinks cannot carry an edit or a read out of scope", async () => {
    approve();
    mkdirSync(join(ws, "outside"), { recursive: true });
    writeFileSync(join(ws, ".env"), "TOKEN=x\n");
    symlinkSync(join(ws, "outside"), join(wt, "src", "out"));
    symlinkSync(join(wt, "factory.config.jsonc"), join(wt, "src", "cfg.json"));
    symlinkSync(join(ws, ".env"), join(wt, "src", "settings.txt"));
    expect(
      await call("impl", "implementer-app", "write", { path: "src/out/x.ts", content: "z" }),
    ).toContain("resolves outside your directory through a symlink");
    expect(await call("impl", "implementer-app", "edit", { path: "src/cfg.json" })).toContain(
      "through a symlink",
    );
    expect(await call("impl", "implementer-app", "read", { path: "src/settings.txt" })).toContain(
      "secret file",
    );
    expect(
      await call("impl", "implementer-app", "shell", { command: "echo x > src/out/y" }),
    ).toContain("outside the session directory");
    expect(await call("impl", "implementer-app", "edit", { path: "src/sum.ts" })).toBeUndefined();
  });

  test("implementer scope: touches, factory files, outside paths, patches", async () => {
    approve();
    expect(await call("impl", "implementer-app", "edit", { path: "README.md" })).toContain(
      "outside this task's touches",
    );
    expect(
      await call("impl", "implementer-app", "edit", { path: "factory.config.jsonc" }),
    ).toContain("managed by the factory");
    expect(
      await call("impl", "implementer-app", "edit", { path: join(ws, ".opencode/agents/x.md") }),
    ).toContain("outside your worktree");
    expect(await call("impl", "implementer-app", "edit", { path: "../1.2/src/a.ts" })).toContain(
      "outside your worktree",
    );
    expect(await call("impl", "implementer-app", "edit", { path: "src/.env" })).toContain(
      "secret file",
    );
    const patch =
      "*** Begin Patch\n*** Update File: src/sum.ts\n*** Add File: docs/x.md\n*** End Patch";
    expect(await call("impl", "implementer-app", "patch", { patchText: patch })).toContain(
      "docs/x.md",
    );
  });

  test("tester, architect and read-only roles", async () => {
    approve();
    expect(await call("tester", "tester", "edit", { path: "src/sum.test.ts" })).toBeUndefined();
    expect(await call("tester", "tester", "edit", { path: "src/sum.ts" })).toContain(
      "only edit test files",
    );
    expect(
      await call("arch", "architect", "write", { path: `openspec/changes/${ID}/design.md` }),
    ).toBeUndefined();
    expect(
      await call("arch", "architect", "write", { path: `.factory/context/${ID}/1.1.md` }),
    ).toBeUndefined();
    expect(
      await call("arch", "architect", "write", { path: "openspec/specs/health/spec.md" }),
    ).toContain("may only write");
    expect(
      await call("arch", "architect", "write", { path: ".factory/runs/add-x.json" }),
    ).toContain("may only write");
    expect(await call("rev", "reviewer", "edit", { path: "src/sum.ts" })).toContain("read-only");
  });

  test("secret reads are refused; repeated reads are logged as waste; logs are redacted", async () => {
    expect(await call("impl", "implementer-app", "read", { path: ".env" })).toContain(
      "secret file",
    );
    await call("impl", "implementer-app", "read", { path: "src/sum.ts" });
    await call("impl", "implementer-app", "read", { path: "src/sum.ts" });
    await call("impl", "implementer-app", "shell", {
      command: "echo ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
    });
    const dir = join(ws, ".factory", "logs", ID);
    const lines = readdirSync(dir).flatMap((f) =>
      readFileSync(join(dir, f), "utf8").trim().split("\n"),
    );
    const entries = lines.map(
      (l) => JSON.parse(l) as { kind: string; note?: string; input?: { command?: string } },
    );
    expect(
      entries.some((e) => e.kind === "waste" && e.note === "repeated read of an unchanged file"),
    ).toBe(true);
    expect(entries.some((e) => e.kind === "blocked")).toBe(true);
    expect(lines.join("\n")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(lines.join("\n")).toContain("[REDACTED:github-token]");
  });
});

describe("second audit batch (S11, S17, S19)", () => {
  test("the grep tool refuses a search over secret files (S11)", async () => {
    writeFileSync(join(wt, ".env"), "TOKEN=x\n");
    try {
      expect(
        await call("impl", "implementer-app", "grep", { pattern: "TOKEN", path: "." }),
      ).toContain("secret file `.env`");
      expect(await call("impl", "implementer-app", "grep", { pattern: "TOKEN" })).toContain(
        "secret file `.env`",
      );
      expect(
        await call("impl", "implementer-app", "grep", { pattern: "TOKEN", path: "src" }),
      ).toBeUndefined();
      expect(await call("impl", "implementer-app", "glob", { pattern: ".e*" })).toContain(
        "secret file",
      );
      expect(await call("impl", "implementer-app", "shell", { command: "cat .e*" })).toContain(
        "secret file",
      );
    } finally {
      rmSync(join(wt, ".env"));
    }
  });

  test("patches the plugin cannot read are refused (S17)", async () => {
    approve();
    const unified = "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-x\n+y\n";
    expect(await call("impl", "implementer-app", "apply_patch", { patchText: unified })).toContain(
      "managed by the factory",
    );
    const crlf =
      "*** Begin Patch\r\n*** Update File: AGENTS.md\r\n@@\r\n-x\r\n+y\r\n*** End Patch\r\n";
    expect(await call("impl", "implementer-app", "apply_patch", { patchText: crlf })).toContain(
      "managed by the factory",
    );
    expect(
      await call("impl", "implementer-app", "apply_patch", { patchText: "rewrite everything" }),
    ).toContain("cannot tell which files");
    const ok = "*** Begin Patch\n*** Update File: src/sum.ts\n@@\n-x\n+y\n*** End Patch\n";
    expect(await call("impl", "implementer-app", "apply_patch", { patchText: ok })).toBeUndefined();
  });

  test("edit and patch contents are not logged (S19)", async () => {
    approve();
    const marker = "UNIQUE-CONTENT-MARKER-7f3a";
    await call("impl", "implementer-app", "edit", {
      filePath: "src/sum.ts",
      oldString: `${marker}-old`,
      newString: `${marker}-new`,
    });
    await call("impl", "implementer-app", "apply_patch", {
      patchText: `*** Begin Patch\n*** Update File: src/sum.ts\n@@\n-x\n+${marker}\n*** End Patch\n`,
    });
    const dir = join(ws, ".factory", "logs", ID);
    const text = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    expect(text).toContain("src/sum.ts");
    expect(text).not.toContain(marker);
  });
});

describe("post-session audit", () => {
  test("flags changed files outside the session's scope", () => {
    const ctx: SessionContext = {
      sessionId: "s",
      changeId: ID,
      role: "implementer",
      directory: "/w",
      workspace: "/ws",
      touches: ["src/**"],
    };
    expect(auditChanges(ctx, ["src/a.ts", "README.md", ".opencode/x", "AGENTS.md"], true)).toEqual([
      {
        path: "README.md",
        reason:
          '`README.md` is outside this task\'s touches (src/**); if you need it, stop with status "blocked"',
      },
      { path: ".opencode/x", reason: "`.opencode/x` is managed by the factory" },
      { path: "AGENTS.md", reason: "`AGENTS.md` is managed by the factory" },
    ]);
  });
});

describe("redaction and log pruning", () => {
  test("redacts tokens, keys, URL credentials, key=value secrets and env values", () => {
    const env = { MY_API_TOKEN: "s3cr3t-value-123", SHORT_TOKEN: "abc", PATH: "/usr/bin" };
    const text = [
      "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAABCDEFGHIJKLMNOP",
      "https://user:hunter22@example.com/repo.git",
      'password: "correct-horse"',
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      "using s3cr3t-value-123 now",
      "keep abc and /usr/bin",
    ].join("\n");
    expect(redact(text, secretEnvValues(env))).toBe(
      [
        "token=[REDACTED:secret]",
        "[REDACTED:aws-key]",
        "https://[REDACTED:credentials]@example.com/repo.git",
        'password: "[REDACTED:secret]"',
        "[REDACTED:private-key]",
        "using [REDACTED:env] now",
        "keep abc and /usr/bin",
      ].join("\n"),
    );
  });

  test("redacts auth headers, user credentials and URL tokens (S16)", () => {
    expect(redact('curl -H "Authorization: Bearer abcdef1234567890xyz" https://x')).toBe(
      'curl -H "Authorization: Bearer [REDACTED:auth]" https://x',
    );
    expect(redact("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(
      "Authorization: Basic [REDACTED:auth]",
    );
    expect(redact("curl -u admin:hunter22 https://x")).toBe(
      "curl -u admin:[REDACTED:credentials] https://x",
    );
    expect(redact("curl --user=admin:hunter22 https://x")).toBe(
      "curl --user=admin:[REDACTED:credentials] https://x",
    );
    expect(redact("git clone https://x-access-token:abc123def456@github.com/o/r")).toBe(
      "git clone https://[REDACTED:credentials]@github.com/o/r",
    );
    expect(redact("git clone https://abcdef0123456789abcdef0123456789@github.com/o/r")).toBe(
      "git clone https://[REDACTED:credentials]@github.com/o/r",
    );
    expect(redact("ssh://git@github.com/o/r and git@github.com:o/r")).toBe(
      "ssh://git@github.com/o/r and git@github.com:o/r",
    );
  });

  test("log values are redacted before JSON escaping, and always (S16)", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-factory-logs-"));
    try {
      const env = { MY_TOKEN: 'quote"and\\backslash-secret' };
      appendLog(root, "c", { kind: "x", value: `has ${env.MY_TOKEN} inside` }, { env });
      appendLog(
        root,
        "c",
        { kind: "y", value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        { redact: false },
      );
      const text = readdirSync(join(root, ".factory/logs/c"))
        .map((f) => readFileSync(join(root, ".factory/logs/c", f), "utf8"))
        .join("");
      expect(text).not.toContain("backslash-secret");
      expect(text).toContain("[REDACTED:env]");
      expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prunes logs older than the retention", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-factory-logs-"));
    try {
      writeFiles(root, {
        ".factory/logs/a/old.jsonl": "{}\n",
        ".factory/logs/b/new.jsonl": "{}\n",
      });
      const old = (Date.now() - 20 * 86_400_000) / 1000;
      utimesSync(join(root, ".factory/logs/a/old.jsonl"), old, old);
      expect(pruneLogs(root, 14)).toEqual([join(root, ".factory/logs/a/old.jsonl")]);
      expect(readdirSync(join(root, ".factory/logs"))).toEqual(["b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
