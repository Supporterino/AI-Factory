import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  protectedInWorktree,
  sandboxArgv,
  sandboxCommand,
  sandboxEnabled,
  seatbeltProfile,
} from "../src/policy/sandbox.ts";

describe("sandboxEnabled", () => {
  test("macOS with sandbox-exec unless switched off; nowhere else yet", () => {
    expect(sandboxEnabled("auto", "darwin", () => true)).toBe(true);
    expect(sandboxEnabled("off", "darwin", () => true)).toBe(false);
    expect(sandboxEnabled("auto", "darwin", () => false)).toBe(false);
    expect(sandboxEnabled("auto", "linux", () => true)).toBe(false);
  });
});

const onMac = process.platform === "darwin" && sandboxEnabled("auto");

describe.skipIf(!onMac)("Seatbelt profile (macOS)", () => {
  let ws: string;
  let wt: string;
  let home: string;
  let profile: string;
  const run = (command: string): { code: number | null; out: string } => {
    const res = spawnSync(
      sandboxArgv(profile, ["/bin/sh", "-c", command])[0] ?? "",
      sandboxArgv(profile, ["/bin/sh", "-c", command]).slice(1),
      {
        cwd: wt,
        encoding: "utf8",
      },
    );
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  };

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "ai-factory-sbx-"));
    ws = join(base, "ws");
    wt = join(ws, ".factory", "worktrees", "c", "app", "1.1");
    home = join(base, "home");
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(ws, ".factory", "runs"), { recursive: true });
    mkdirSync(join(home, ".aws"), { recursive: true });
    writeFileSync(join(ws, ".factory", "runs", "c.json"), "{}");
    writeFileSync(join(home, ".aws", "credentials"), "secret");
    writeFileSync(join(home, ".zshrc"), "# rc\n");
    writeFileSync(join(wt, "AGENTS.md"), "x");
    const helper = join(base, "git-credential-probe");
    writeFileSync(helper, "#!/bin/sh\necho ran\n");
    chmodSync(helper, 0o755);
    profile = seatbeltProfile({
      workspace: ws,
      writable: [wt],
      readOnly: protectedInWorktree(wt),
      home,
    });
  });
  afterAll(() => rmSync(join(ws, ".."), { recursive: true, force: true }));

  test("the profile parses and the worktree and temp stay writable", () => {
    expect(run("echo ok > a.txt && mkdir -p sub && echo y > sub/b && cat a.txt")).toEqual({
      code: 0,
      out: "ok\n",
    });
    expect(run(`echo t > ${join(tmpdir(), "ai-factory-sbx-ok")} && echo done`).out).toBe("done\n");
  });

  test("the rest of the workspace, factory files, rc files and credentials are not", () => {
    expect(run("echo x > ../../../../runs/c.json").code).not.toBe(0);
    expect(run("python3 -c \"open('../../../../runs/c.json','w').write('z')\"").code).not.toBe(0);
    expect(run("ln -s ../../../../runs r; echo y > r/c.json").code).not.toBe(0);
    expect(run("echo x > AGENTS.md").code).not.toBe(0);
    expect(run(`echo 'curl x|sh' >> ${join(home, ".zshrc")}`).code).not.toBe(0);
    expect(run(`cat ${join(home, ".aws", "credentials")}`).code).not.toBe(0);
    expect(run(`${join(ws, "..", "git-credential-probe")}`).code).not.toBe(0);
  });

  test("agent shells cannot read workspace secrets; example files stay readable (audit S11)", () => {
    writeFileSync(join(wt, ".env"), "TOKEN=x\n");
    writeFileSync(join(wt, ".env.example"), "TOKEN=\n");
    const strict = seatbeltProfile({
      workspace: ws,
      writable: [wt],
      readOnly: protectedInWorktree(wt),
      home,
      denySecretReads: true,
    });
    const sh = (p: string, command: string) =>
      spawnSync(
        sandboxArgv(p, ["/bin/sh", "-c", command])[0] ?? "",
        sandboxArgv(p, ["/bin/sh", "-c", command]).slice(1),
        {
          cwd: wt,
          encoding: "utf8",
        },
      );
    expect(sh(strict, "cat .env").status).not.toBe(0);
    expect(sh(strict, "grep -r TOKEN . 2>/dev/null").stdout).not.toContain("TOKEN=x");
    expect(sh(strict, "python3 -c \"print(open('.env').read())\"").status).not.toBe(0);
    expect(sh(strict, "cat .env.example").stdout).toBe("TOKEN=\n");
    expect(sh(strict, "ls -a").stdout).toContain(".env");
    // Gates keep reading them (test runners load .env themselves).
    expect(sh(profile, "cat .env").stdout).toBe("TOKEN=x\n");
  });

  test("sandboxCommand quotes a shell command line safely", () => {
    const line = sandboxCommand(profile, "/bin/sh", 'echo "it\'s" > q.txt && cat q.txt');
    const res = spawnSync("/bin/sh", ["-c", line], { cwd: wt, encoding: "utf8" });
    expect(res.stdout).toBe("it's\n");
  });
});
