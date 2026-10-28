import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { FactoryConfig } from "../src/config/schema.ts";
import {
  createSingleRepoFixture,
  type Fixture,
  fixtureGit,
  writeFiles,
} from "./fixtures/workspaces.ts";
import { cli, gitOut } from "./helpers.ts";

const MODELS = {
  orchestrator: "anthropic/claude-sonnet-5-5",
  architect: "anthropic/claude-opus-5-5",
  reviewer: "anthropic/claude-opus-5-5",
  implementer: "anthropic/claude-sonnet-5-5",
  tester: "anthropic/claude-sonnet-5-5",
  explorer: "anthropic/claude-haiku-5-5",
};

const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

async function workspace(mode: "local" | "git"): Promise<Fixture> {
  const fx = await createSingleRepoFixture();
  const config = FactoryConfig.parse({
    schemaVersion: 4,
    layout: "single",
    repos: [{ name: "app", path: ".", role: "code", languages: ["typescript"] }],
    models: MODELS,
    artifacts: { mode },
  });
  writeFileSync(join(fx.root, "factory.config.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
  await fixtureGit(fx.root, "add", "-A");
  await fixtureGit(fx.root, "commit", "-q", "-m", "chore: add factory config");
  return fx;
}

const ledger = (id: string): string =>
  JSON.stringify({
    version: 1,
    changeId: id,
    entries: [
      {
        at: "2026-10-01T10:00:00.000Z",
        sessionId: "s",
        agent: "implementer-app",
        model: "anthropic/claude-sonnet-5-5",
        step: "1.1",
        kind: "step",
        usage: {
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 5,
          cacheWrite: 0,
          cost: 0.25,
        },
      },
    ],
  });

function localRecords(root: string, id: string): void {
  writeFiles(root, {
    [`.factory/reports/${id}.md`]: `# ${id}: done\n`,
    [`.factory/reports/${id}-paused.md`]: `# ${id}: paused\n`,
    [`.factory/approvals/${id}.json`]: `${JSON.stringify({ changeId: id, approver: "a@b.c" }, null, 2)}\n`,
    [`.factory/usage/${id}.json`]: `${ledger(id)}\n`,
    [`.factory/logs/${id}/2026-10-01.jsonl`]: `${JSON.stringify({ kind: "waste" })}\n`,
  });
}

describe("artifacts: committed records", () => {
  let fx: Fixture;
  afterEach(() => fx.cleanup());

  test("git mode records the final report, approval and usage once", async () => {
    fx = await workspace("git");
    localRecords(fx.root, "add-x");

    const head = await gitOut(fx.root, "rev-parse", "HEAD");
    const run = await cli(fx.root, "artifacts", "sync", "add-x");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.err).toBe("");

    expect(read(fx.root, "factory-records/reports/add-x.md")).toBe("# add-x: done\n");
    expect(JSON.parse(read(fx.root, "factory-records/approvals/add-x.json"))).toEqual({
      changeId: "add-x",
      approver: "a@b.c",
    });
    const snapshot = JSON.parse(read(fx.root, "factory-records/usage/add-x.json"));
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.wastedReads).toBe(1);

    // Paused reports embed gate output and are never records.
    expect(existsSync(join(fx.root, "factory-records/reports/add-x-paused.md"))).toBe(false);
    expect(existsSync(join(fx.root, "factory-records/logs"))).toBe(false);

    expect(await gitOut(fx.root, "log", "-1", "--format=%s")).toBe("docs(factory): record add-x");
    expect(await gitOut(fx.root, "log", "-1", "--format=%b")).toContain("Change-Id: add-x");
    expect(await gitOut(fx.root, "status", "--porcelain", "--", "factory-records")).toBe("");
    expect(head).not.toBe(await gitOut(fx.root, "rev-parse", "HEAD"));

    const recorded = await gitOut(fx.root, "rev-parse", "HEAD");
    const again = await cli(fx.root, "artifacts", "sync", "add-x");
    expect(again.code).toBe(ExitCode.Ok);
    expect(again.out).toContain("up to date");
    expect(await gitOut(fx.root, "rev-parse", "HEAD")).toBe(recorded);
  });

  test("--all backfills every local id in one commit", async () => {
    fx = await workspace("git");
    localRecords(fx.root, "add-x");
    localRecords(fx.root, "quick-typo");

    const run = await cli(fx.root, "artifacts", "sync", "--all");
    expect(run.code).toBe(ExitCode.Ok);
    expect(read(fx.root, "factory-records/reports/add-x.md")).toContain("add-x");
    expect(read(fx.root, "factory-records/usage/quick-typo.json")).toContain("quick-typo");
    expect(await gitOut(fx.root, "log", "-1", "--format=%s")).toContain(
      "backfill 2 change record(s)",
    );
    expect((await gitOut(fx.root, "log", "--oneline", "--max-count=2")).split("\n")).toHaveLength(
      2,
    );
  });

  test("local mode refuses and writes nothing", async () => {
    fx = await workspace("local");
    localRecords(fx.root, "add-x");

    const run = await cli(fx.root, "artifacts", "sync", "add-x");
    expect(run.code).toBe(ExitCode.Precondition);
    expect(run.err).toContain('artifacts.mode is "local"');
    expect(existsSync(join(fx.root, "factory-records"))).toBe(false);

    const all = await cli(fx.root, "artifacts", "sync", "--all");
    expect(all.code).toBe(ExitCode.Precondition);
  });

  test("rejects ids that are not slugs", async () => {
    fx = await workspace("git");
    const run = await cli(fx.root, "artifacts", "sync", "../escape");
    expect(run.code).toBe(ExitCode.Usage);
    expect(existsSync(join(fx.root, "factory-records"))).toBe(false);
  });

  test("usage falls back to the committed ledger after the local files are gone", async () => {
    fx = await workspace("git");
    localRecords(fx.root, "add-x");
    expect((await cli(fx.root, "artifacts", "sync", "add-x")).code).toBe(ExitCode.Ok);

    rmSync(join(fx.root, ".factory/usage/add-x.json"));
    rmSync(join(fx.root, ".factory/logs"), { recursive: true, force: true });

    const run = await cli(fx.root, "usage", "--json");
    expect(run.code).toBe(ExitCode.Ok);
    const report = JSON.parse(run.out);
    expect(report.changes).toBe(1);
    expect(report.byChange["add-x"]).toBeDefined();
    expect(report.wastedReads).toBe(1);
  });

  test("the local ledger wins over the snapshot when both exist", async () => {
    fx = await workspace("git");
    localRecords(fx.root, "add-x");
    expect((await cli(fx.root, "artifacts", "sync", "add-x")).code).toBe(ExitCode.Ok);

    const live = JSON.parse(read(fx.root, ".factory/usage/add-x.json"));
    live.entries.push({ ...live.entries[0], sessionId: "s2" });
    writeFileSync(join(fx.root, ".factory/usage/add-x.json"), `${JSON.stringify(live)}\n`);

    const run = await cli(fx.root, "usage", "--json");
    expect(JSON.parse(run.out).sessions).toBe(2);
  });
});
