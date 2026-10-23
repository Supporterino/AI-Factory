#!/usr/bin/env bun
/**
 * Manual end-to-end run with the real opencode server (and real git, OpenSpec, Graphify and
 * gate toolchains), recorded as a transcript under docs/e2e/<layout>.md.
 *
 *   bun scripts/e2e-transcript.ts single|submodules [--keep]
 *
 * The model is the scripted, role-aware stub from test/fixtures/stub-team.ts, served over the
 * Anthropic Messages API to opencode, so the run costs nothing and is reproducible. To run
 * with a real model instead, use the same flow on your own workspace (README "The flow").
 * opencode runs with an isolated HOME; the stub provider is its only provider.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const layout = process.argv[2];
if (layout !== "single" && layout !== "submodules") {
  console.error("usage: bun scripts/e2e-transcript.ts single|submodules [--keep]");
  process.exit(2);
}
const keep = process.argv.includes("--keep");

// Real tools; git without the developer's global config (identity from the fixture config).
const opencodeBin = Bun.which("opencode") ?? join(homedir(), ".opencode/bin/opencode");
process.env.AI_FACTORY_OPENCODE_BIN = opencodeBin;
process.env.AI_FACTORY_OPENSPEC_BIN ??= join(ROOT, "node_modules/.bin/openspec");
process.env.GIT_CONFIG_GLOBAL = join(ROOT, "test/fixtures/gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";

const { runCli } = await import("../src/cli/main.ts");
const { setJsonc } = await import("../src/config/jsonc.ts");
const { git } = await import("../src/exec.ts");
const { FACTORY_VERSION } = await import("../src/version.ts");
const { startStubModel } = await import("../test/fixtures/stub-model.ts");
const { stubTeam } = await import("../test/fixtures/stub-team.ts");
const { createSingleRepoFixture, createSubmoduleFixture } = await import(
  "../test/fixtures/workspaces.ts"
);
const plans = await import("./e2e-plans.ts");

const plan = layout === "single" ? plans.SINGLE : plans.SUBMODULES;
const fx = layout === "single" ? await createSingleRepoFixture() : await createSubmoduleFixture();
const root = fx.root;
const stub = startStubModel(stubTeam(plan.team));

// Isolated opencode home with the stub as the only provider.
const home = join(fx.base, "home");
mkdirSync(join(home, ".config", "opencode"), { recursive: true });
writeFileSync(
  join(home, ".config", "opencode", "opencode.jsonc"),
  JSON.stringify(
    {
      providers: {
        stub: {
          package: "@opencode/ai/providers/anthropic-compatible",
          settings: { baseURL: stub.baseURL, apiKey: "stub" },
          models: { "claude-stub": { limit: { context: 200000, output: 8000 } } },
        },
      },
    },
    null,
    2,
  ),
);
process.env.HOME = home;
for (const v of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"])
  delete process.env[v];

const lines: string[] = [];
const started = Date.now();
const scrub = (text: string): string =>
  text.split(fx.base).join("<tmp>").split(homedir()).join("~").replace(/\s+$/g, "");

async function run(...argv: string[]): Promise<number> {
  const out: string[] = [];
  const t0 = Date.now();
  const code = await runCli(argv, {
    cwd: root,
    out: (t) => out.push(t),
    err: (t) => out.push(t),
  });
  lines.push("```console", `$ ai-factory ${argv.join(" ")}`, scrub(out.join("\n")));
  lines.push(`# exit ${code} · ${((Date.now() - t0) / 1000).toFixed(1)}s`, "```", "");
  return code;
}

async function shell(display: string, args: string[], cwd = root): Promise<string> {
  const res = await git(args, { cwd });
  lines.push("```console", `$ ${display}`, scrub(res.stdout + res.stderr), "```", "");
  return res.stdout;
}

function show(rel: string, lang = ""): void {
  const file = join(root, rel);
  lines.push(
    `\`${rel}\`:`,
    "",
    `\`\`\`${lang}`,
    existsSync(file) ? scrub(readFileSync(file, "utf8")) : "(missing)",
    "```",
    "",
  );
}

const note = (text: string): void => {
  lines.push(text, "");
};

async function toolVersion(args: string[]): Promise<string> {
  const proc = Bun.spawnSync(args, { env: process.env });
  return (proc.stdout.toString() + proc.stderr.toString()).trim().split("\n")[0] ?? "";
}

try {
  note(`# E2E: ${layout === "single" ? "single repo" : "AI repo with submodules"}`);
  note(
    [
      `Recorded ${new Date().toISOString().slice(0, 10)} with \`bun scripts/e2e-transcript.ts ${layout}\` (ai-factory ${FACTORY_VERSION}).`,
      "",
      "**Real:**",
      `- the opencode server: ${await toolVersion([opencodeBin, "--version"])} with the factory's agents, permissions and guard plugin;`,
      `- git; OpenSpec ${await toolVersion([process.env.AI_FACTORY_OPENSPEC_BIN ?? "openspec", "--version"])}; ${await toolVersion(["graphify", "--version"])};`,
      `- the gate toolchains named in the config below.`,
      "",
      "**Scripted:** the model. `test/fixtures/stub-team.ts` answers opencode's Messages API calls per role. It writes files with opencode's `write` tool, tries a forbidden `git push` to show the guard, and ends each session with a handoff. Token counts in `status` come from the stub's fixed usage numbers.",
      "",
      "Temp paths are shown as `<tmp>`.",
    ].join("\n"),
  );
  note(plan.intro);

  note("## Install");
  await run("init");
  const configFile = join(root, "factory.config.jsonc");
  let config = readFileSync(configFile, "utf8").replace(
    /"anthropic\/[^"]+"/g,
    '"stub/claude-stub"',
  );
  config = setJsonc(config, ["gates", "overrides"], plan.overrides);
  if (plan.contracts) config = setJsonc(config, ["contracts"], plan.contracts);
  writeFileSync(configFile, config);
  await git(["commit", "-q", "-am", "chore: e2e models, gates and contracts"], { cwd: root });
  note(plan.configNote);
  await shell("git diff HEAD~1 -- factory.config.jsonc", [
    "diff",
    "HEAD~1",
    "--",
    "factory.config.jsonc",
  ]);
  note(
    "Changed models re-render the agents, so `update` brings the managed files in line with the config:",
  );
  await run("update");
  await run("graph");
  await run("doctor");

  note("## Run up to the spec");
  await run("run", plan.request);
  const id = plan.team.changeId;
  await run("status", id);
  show(`openspec/changes/${id}/tasks.md`, "markdown");

  note("## Approve: the rest runs on its own");
  await run("approve", id);
  await run("status", id);

  note("## Result");
  const repos =
    layout === "single"
      ? [{ name: "app", dir: root }]
      : plan.repoDirs.map((r) => ({ name: r, dir: join(root, "repos", r) }));
  await shell(`git log --format='%h %s' main..change/${id}`, [
    "log",
    "--format=%h %s",
    `main..change/${id}`,
  ]);
  if (layout === "submodules") {
    for (const r of repos) {
      await shell(
        `git -C repos/${r.name} log --format='%h %s  [%(trailers:key=Task,valueonly,separator=)]' main..change/${id}`,
        [
          "log",
          "--format=%h %s  [%(trailers:key=Task,valueonly,separator=)]",
          `main..change/${id}`,
        ],
        r.dir,
      );
    }
    await shell(`git show --stat change/${id}~1`, [
      "show",
      "--stat",
      "--format=%h %s%n%n%b",
      `change/${id}~1`,
    ]);
  }
  await shell("git branch --list '*change*'", ["branch", "--list", "*change*"]);
  for (const r of layout === "submodules" ? repos : [])
    await shell(
      `git -C repos/${r.name} branch --list '*change*'`,
      ["branch", "--list", "*change*"],
      r.dir,
    );
  await shell("git worktree list", ["worktree", "list"]);

  note("### Gate runs");
  note(
    "Each task's gates, as logged (per task in its worktree, then again after the rebase in the merge queue; `full:<repo>` is the full suite at the end):",
  );
  const gateLines: string[] = [];
  const logDir = join(root, ".factory/logs", id);
  const logLines = existsSync(logDir)
    ? readdirSync(logDir).flatMap((f) =>
        readFileSync(join(logDir, f), "utf8").split("\n").filter(Boolean),
      )
    : [];
  for (const line of logLines) {
    const e = JSON.parse(line) as {
      kind?: string;
      task?: string;
      repo?: string;
      results?: { type: string; status: string; command?: string }[];
    };
    if (e.kind !== "gates" || !e.results) continue;
    const ran = e.results.map(
      (r) =>
        `${r.type} ${r.status}${r.command ? ` (${r.command.length > 60 ? `${r.command.slice(0, 57)}...` : r.command})` : ""}`,
    );
    gateLines.push(`${(e.task ?? `full:${e.repo}`).padEnd(14)} ${ran.join(" · ")}`);
  }
  lines.push("```text", ...gateLines, "```", "");

  note("### Guard log");
  note(
    "Every tool call the agents made is logged (redacted). These are the calls the plugin blocked:",
  );
  const blocked = logLines.filter((l) => l.includes('"kind":"blocked"'));
  lines.push("```json", ...blocked.map(scrub), "```", "");

  note("### Final report");
  const report = join(root, ".factory/reports", `${id}.md`);
  lines.push(
    "````markdown",
    existsSync(report) ? scrub(readFileSync(report, "utf8")) : "(missing)",
    "````",
    "",
  );
  note(
    `Total wall time: ${((Date.now() - started) / 1000).toFixed(0)}s. Model requests served by the stub: ${stub.requests.length}.`,
  );
} finally {
  stub.stop();
  const outDir = join(ROOT, "docs/e2e");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${layout}.md`);
  writeFileSync(out, `${lines.join("\n").trim()}\n`);
  console.log(`wrote ${relative(process.cwd(), out)}`);
  if (keep) console.log(`kept the workspace at ${root}`);
  else fx.cleanup();
}
