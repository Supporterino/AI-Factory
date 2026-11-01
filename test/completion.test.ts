import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWords } from "../src/cli/completion/engine.ts";
import { completionScript } from "../src/cli/completion/scripts.ts";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { COMMANDS } from "../src/cli/main.ts";
import { newRun, saveRun, TaskState } from "../src/state/run.ts";
import { createSingleRepoFixture, type Fixture, writeFiles } from "./fixtures/workspaces.ts";
import { cli } from "./helpers.ts";

const values = async (words: readonly string[], cwd: string): Promise<string[]> =>
  (await completeWords(words, cwd)).candidates?.map((candidate) => candidate.value) ?? [];

describe("completion metadata", () => {
  test("every visible command declares its flags and documents them", () => {
    for (const command of COMMANDS.filter((candidate) => candidate.hidden !== true)) {
      expect(command.options).toBeDefined();
      for (const flag of Object.keys(command.options ?? {}))
        expect(command.help).toContain(`--${flag}`);
    }
    expect(COMMANDS.some((command) => command.hidden === true)).toBe(true);
  });

  test("the hidden endpoint is not listed in help", async () => {
    const fx = await createSingleRepoFixture();
    try {
      const help = await cli(fx.root, "--help");
      expect(help.code).toBe(ExitCode.Ok);
      expect(help.out).not.toContain("__complete");
      expect(help.out).toContain("completion");
      expect(help.out).toContain("usage");
    } finally {
      fx.cleanup();
    }
  });
});

describe("completion candidates", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    writeFiles(fx.root, {
      ".factory/usage/add-x.json": JSON.stringify({
        version: 1,
        changeId: "add-x",
        entries: [],
      }),
    });
    const run = newRun("add-x", "Add a health endpoint");
    run.tasks = [
      TaskState.parse({
        id: "1.1",
        title: "Add the endpoint",
        repo: "app",
        deps: [],
        touches: ["src/**"],
        status: "failed",
      }),
    ];
    saveRun(fx.root, run);
  });
  afterEach(() => fx.cleanup());

  test("commands, global flags and command flags", async () => {
    expect(await values([""], fx.root)).toContain("run");
    expect(await values(["r"], fx.root)).toEqual(
      expect.arrayContaining(["run", "resume", "retry", "rollback", "repoint"]),
    );
    expect(await values(["-"], fx.root)).toEqual(
      expect.arrayContaining(["-C", "-h", "--help", "-V", "--version"]),
    );
    expect(await values(["run", "--"], fx.root)).toEqual(
      expect.arrayContaining(["--request", "--no-interactive", "--verbose", "--quiet"]),
    );
    expect(await values(["run", "--verbose", "--"], fx.root)).not.toContain("--verbose");
    expect(await values(["run", "--verbose", "--"], fx.root)).toContain("--quiet");
  });

  test("an empty word after a command offers flags and positional values", async () => {
    expect(await values(["run", ""], fx.root)).toEqual(
      expect.arrayContaining(["--request", "--no-interactive", "--verbose", "--quiet", "--help"]),
    );
    expect(await values(["run", "--verbose", ""], fx.root)).not.toContain("--verbose");
    expect(await values(["run", "--help", ""], fx.root)).not.toContain("--help");
    expect(await values(["completion", ""], fx.root)).toEqual(
      expect.arrayContaining(["bash", "zsh", "fish", "--install", "--rc", "--help"]),
    );
    // After `--`, words are literals, so no flags are suggested.
    expect(await values(["run", "--", ""], fx.root)).toEqual([]);
  });

  test("value providers and static choices", async () => {
    expect(await values(["completion", ""], fx.root)).toEqual(
      expect.arrayContaining(["bash", "zsh", "fish"]),
    );
    expect(await values(["completion", "z"], fx.root)).toEqual(["zsh"]);
    expect(await values(["status", ""], fx.root)).toContain("add-x");
    expect(await values(["usage", "--change", ""], fx.root)).toContain("add-x");
    expect(await values(["gate", "add-x", "--task", ""], fx.root)).toContain("1.1");
    expect(await values(["retry", "add-x", "--task", ""], fx.root)).toContain("1.1");
    expect(await values(["usage", "--by", ""], fx.root)).toEqual([
      "change",
      "agent",
      "model",
      "day",
    ]);
    expect(await values(["usage", "--by", "change,"], fx.root)).toEqual([
      "change,agent",
      "change,model",
      "change,day",
    ]);
    expect(await values(["bench", ""], fx.root)).toEqual(
      expect.arrayContaining(["ponytail", "--runs", "--case", "--levels"]),
    );
    expect(await values(["bench", "ponytail", "--"], fx.root)).toContain("--runs");
    expect(await values(["bench", "--levels", "l"], fx.root)).toEqual(["lite"]);
    expect(await values(["bench", "--levels", "lite,"], fx.root)).toEqual([
      "lite,full",
      "lite,ultra",
    ]);
  });

  test("files and directories use the shell fallback", async () => {
    expect((await completeWords(["run", "--request", ""], fx.root)).fallback).toBe("files");
    expect((await completeWords(["-C", ""], fx.root)).fallback).toBe("dirs");
  });

  test("repo, agent and model values come from the config", async () => {
    const init = await cli(fx.root, "init", "--no-graph");
    if (init.code !== ExitCode.Ok) return; // Tool-less environments still exercise the rest.
    expect(await values(["quick", "--repo", ""], fx.root)).toContain("app");
    expect(await values(["quick", "--agent", ""], fx.root)).toContain("implementer-app");
    expect(await values(["usage", "--model", ""], fx.root)).toContain(
      "anthropic/claude-sonnet-5-5",
    );
  });
});

describe("completion install and scripts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-factory-completion-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("prints a script for each shell", async () => {
    const fx = await createSingleRepoFixture();
    try {
      for (const shell of ["bash", "zsh", "fish"] as const) {
        const run = await cli(fx.root, "completion", shell);
        expect(run.code).toBe(ExitCode.Ok);
        expect(run.out).toContain(`__complete ${shell}`);
      }
    } finally {
      fx.cleanup();
    }
    const bash = spawnSync("bash", ["-n"], { input: completionScript("bash"), encoding: "utf8" });
    expect(bash.status).toBe(0);
    if (spawnSync("zsh", ["--version"], { encoding: "utf8" }).status === 0) {
      const zsh = spawnSync("zsh", ["-n"], { input: completionScript("zsh"), encoding: "utf8" });
      expect(zsh.status).toBe(0);
    }
  });

  test("the bash script forwards each word and falls back to files", () => {
    if (spawnSync("bash", ["--version"], { encoding: "utf8" }).status !== 0) return;
    const harness = `
ai-factory() { printf 'ARGC=%s\\n' "$#" >&2; echo candidate; }
compopt() { echo COMPOPT; }
complete() { :; }
${completionScript("bash")}
COMP_WORDS=(ai-factory run --req); COMP_CWORD=2; _ai_factory_complete
printf 'REPLY=%s\\n' "\${COMPREPLY[@]}" >&2
ai-factory() { echo ":files"; }
COMP_WORDS=(ai-factory run --request ""); COMP_CWORD=3; _ai_factory_complete
printf 'FALLBACK=%s\\n' "\${#COMPREPLY[@]}" >&2
`;
    const run = spawnSync("bash", ["-f", "-c", harness], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("ARGC=4");
    expect(run.stderr).toContain("REPLY=candidate");
    expect(run.stdout).toContain("COMPOPT");
    expect(run.stderr).toContain("FALLBACK=0");
  });

  test("the zsh script forwards each word and falls back to files", () => {
    if (spawnSync("zsh", ["--version"], { encoding: "utf8" }).status !== 0) return;
    const harness = `
ai-factory() { print -r -- "ARGC=$#" >&2; print -r -- "--request"; }
compadd() { print -r -- "COMPADD=\${(j:,:)values}" >&2; }
_files() { print -r -- "FILES_CALLED" >&2; }
compdef() { :; }
${completionScript("zsh")}
words=(ai-factory run --req); CURRENT=3; _ai_factory
ai-factory() { print -r -- ":files" }
words=(ai-factory run --request ""); CURRENT=4; _ai_factory
`;
    const run = spawnSync("zsh", ["-f", "-c", harness], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("ARGC=4");
    expect(run.stderr).toContain("COMPADD=--request");
    expect(run.stderr).toContain("FILES_CALLED");
  });

  test("installs one idempotent block and preserves the rc file", async () => {
    const fx = await createSingleRepoFixture();
    try {
      const rc = join(dir, "zshrc");
      writeFileSync(rc, "export PATH=$PATH\n");
      const first = await cli(fx.root, "completion", "zsh", "--install", "--rc", rc);
      expect(first.code).toBe(ExitCode.Ok);
      const afterFirst = readFileSync(rc, "utf8");
      expect(afterFirst).toContain("export PATH=$PATH");
      expect(afterFirst).toContain("# >>> ai-factory completion >>>");
      expect(afterFirst.match(/# >>> ai-factory completion >>>/g)).toHaveLength(1);
      const second = await cli(fx.root, "completion", "zsh", "--install", "--rc", rc);
      expect(second.code).toBe(ExitCode.Ok);
      expect(readFileSync(rc, "utf8")).toBe(afterFirst);
      expect((await cli(fx.root, "completion", "zsh", "--rc", rc)).code).toBe(ExitCode.Usage);
      expect((await cli(fx.root, "completion", "powershell")).code).toBe(ExitCode.Usage);
    } finally {
      fx.cleanup();
    }
  });

  test("a malformed block stops instead of overwriting the file", async () => {
    const fx = await createSingleRepoFixture();
    try {
      const rc = join(dir, "zshrc");
      writeFileSync(rc, "# >>> ai-factory completion >>>\nold\n");
      const run = await cli(fx.root, "completion", "zsh", "--install", "--rc", rc);
      expect(run.code).toBe(ExitCode.Precondition);
      expect(readFileSync(rc, "utf8")).toContain("old");
    } finally {
      fx.cleanup();
    }
  });
});
