import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import type { RepoConfig } from "../src/config/schema.ts";
import { PreconditionError } from "../src/errors.ts";
import { branchAiRepo, branchSubmodule } from "../src/git/branching.ts";
import { commitTask, conventionalSubject } from "../src/git/commit.ts";
import { MergeQueue, mergeTask } from "../src/git/merge-queue.ts";
import { bumpPointers, findProvisionalBump, PROVISIONAL_SUBJECT } from "../src/git/pointers.ts";
import { addTaskWorktree } from "../src/git/worktrees.ts";
import { createSubmoduleFixture, type Fixture, fixtureGit } from "./fixtures/workspaces.ts";
import { cli, gitOut } from "./helpers.ts";

const repo = (name: string): RepoConfig => ({
  name,
  path: `repos/${name}`,
  role: "code",
  languages: [],
  defaultBranch: "main",
});

describe("conventionalSubject", () => {
  test.each([
    ["Add health endpoint", "feat: add health endpoint"],
    ["Fix nil pointer in handler.", "fix: fix nil pointer in handler"],
    ["Test health scenarios", "test: test health scenarios"],
    ["Rename  user   service", "refactor: rename user service"],
    ["Document the API", "docs: document the API"],
  ])("%s", (title, subject) => expect(conventionalSubject(title)).toBe(subject));
});

describe("change branches", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
  });
  afterEach(() => fx.cleanup());

  test("the AI repo branches first and must be clean", async () => {
    writeFileSync(join(fx.root, "notes.txt"), "wip\n");
    await expect(branchAiRepo(fx.root, "add-x")).rejects.toBeInstanceOf(PreconditionError);
    await fixtureGit(fx.root, "add", "notes.txt");
    await fixtureGit(fx.root, "commit", "-q", "-m", "chore: notes");

    const head = await gitOut(fx.root, "rev-parse", "HEAD");
    expect(await branchAiRepo(fx.root, "add-x")).toEqual({
      repo: ".",
      branch: "change/add-x",
      base: head,
      created: true,
    });
    expect(await gitOut(fx.root, "branch", "--show-current")).toBe("change/add-x");
    expect((await branchAiRepo(fx.root, "add-x")).created).toBe(false);
  });

  test("a submodule branches from its default branch, even from a detached HEAD", async () => {
    const dir = join(fx.root, "repos/backend");
    const main = await gitOut(dir, "rev-parse", "main");
    await fixtureGit(dir, "checkout", "-q", "--detach", "HEAD");
    const res = await branchSubmodule(fx.root, repo("backend"), "add-x");
    expect(res).toEqual({ repo: "backend", branch: "change/add-x", base: main, created: true });
    expect(await gitOut(dir, "branch", "--show-current")).toBe("change/add-x");
    // Resume: same branch, same base.
    expect(await branchSubmodule(fx.root, repo("backend"), "add-x")).toEqual({
      ...res,
      created: false,
    });
  });

  test("a tracked branch in .gitmodules wins over the default branch", async () => {
    // Create a release branch upstream through a separate clone (as a human would).
    const human = join(fx.base, "human-frontend");
    await fixtureGit(fx.base, "clone", "-q", join(fx.base, "remotes/frontend.git"), human);
    await fixtureGit(human, "switch", "-q", "-c", "release");
    writeFileSync(join(human, "RELEASE"), "1\n");
    await fixtureGit(human, "add", "RELEASE");
    await fixtureGit(human, "commit", "-q", "-m", "chore: release");
    await fixtureGit(human, "push", "-q", "origin", "release");
    const release = await gitOut(human, "rev-parse", "HEAD");

    const dir = join(fx.root, "repos/frontend");
    await fixtureGit(dir, "fetch", "-q", "origin");
    await fixtureGit(
      fx.root,
      "config",
      "--file",
      ".gitmodules",
      "submodule.repos/frontend.branch",
      "release",
    );
    await fixtureGit(fx.root, "commit", "-q", "-am", "chore: track release");
    expect((await branchSubmodule(fx.root, repo("frontend"), "add-x")).base).toBe(release);
  });

  test("a stale local branch does not win over a newer origin branch (audit P20)", async () => {
    const human = join(fx.base, "human-backend");
    await fixtureGit(fx.base, "clone", "-q", join(fx.base, "remotes/backend.git"), human);
    writeFileSync(join(human, "NEWER"), "1\n");
    await fixtureGit(human, "add", "NEWER");
    await fixtureGit(human, "commit", "-q", "-m", "chore: newer upstream");
    await fixtureGit(human, "push", "-q", "origin", "HEAD:main");
    const upstream = await gitOut(human, "rev-parse", "HEAD");
    // The submodule's local main is behind and was never fetched: branching fetches first.
    expect((await branchSubmodule(fx.root, repo("backend"), "add-x")).base).toBe(upstream);
  });

  test("dirty or uninitialised submodules are refused", async () => {
    writeFileSync(join(fx.root, "repos/backend/wip.go"), "package main\n");
    await expect(branchSubmodule(fx.root, repo("backend"), "add-x")).rejects.toThrow(
      "uncommitted changes",
    );
    await fixtureGit(fx.root, "submodule", "deinit", "-q", "-f", "repos/deploy");
    await expect(branchSubmodule(fx.root, repo("deploy"), "add-x")).rejects.toThrow(
      "not initialised",
    );
  });
});

describe("task worktrees and the merge queue", () => {
  let fx: Fixture;
  let backend: string;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
    backend = join(fx.root, "repos/backend");
    await branchSubmodule(fx.root, repo("backend"), "add-x");
  });
  afterEach(() => fx.cleanup());

  async function task(id: string, file: string, content: string, title: string) {
    const wt = await addTaskWorktree(fx.root, backend, "backend", "add-x", id);
    writeFileSync(join(wt.path, file), content);
    expect(await commitTask(wt.path, "add-x", id, title)).toMatch(/^[0-9a-f]{40}$/);
    return wt;
  }

  test("parallel tasks merge one at a time, rebased, with trailers, worktrees removed", async () => {
    const t1 = await task("1.1", "a.go", "package main\n// a\n", "Add a");
    const t2 = await task("1.2", "b.go", "package main\n// b\n", "Add b");
    expect(t1.path).toBe(join(fx.root, ".factory/worktrees/add-x/backend/1.1"));

    const gated: string[] = [];
    const regate = async (wt: string) => {
      gated.push(wt);
      return true;
    };
    const queue = new MergeQueue();
    const [m1, m2] = await Promise.all([
      queue.run("backend", () =>
        mergeTask({ repoDir: backend, id: "add-x", worktree: t1, regate }),
      ),
      queue.run("backend", () =>
        mergeTask({ repoDir: backend, id: "add-x", worktree: t2, regate }),
      ),
    ]);
    expect(m1?.status).toBe("merged");
    expect(m2?.status).toBe("merged");
    expect(gated).toEqual([t1.path, t2.path]);

    expect((await gitOut(backend, "log", "--format=%s", "main..change/add-x")).split("\n")).toEqual(
      ["feat: add b", "feat: add a"],
    );
    expect(
      await gitOut(
        backend,
        "log",
        "-1",
        "--format=%(trailers:key=Change-Id,valueonly)%(trailers:key=Task,valueonly)",
      ),
    ).toBe("add-x\n1.2");
    expect(existsSync(t1.path)).toBe(false);
    expect(await gitOut(backend, "branch", "--list", "change/add-x--*")).toBe("");
  });

  test("a conflict is reported, resolved in the worktree and merged", async () => {
    const t1 = await task("1.1", "main.go", "package main\n// one\n", "Change main one");
    const t2 = await task("1.2", "main.go", "package main\n// two\n", "Change main two");
    const regate = async () => true;
    expect((await mergeTask({ repoDir: backend, id: "add-x", worktree: t1, regate })).status).toBe(
      "merged",
    );

    const conflict = await mergeTask({ repoDir: backend, id: "add-x", worktree: t2, regate });
    expect(conflict).toEqual({ status: "conflict", conflicts: ["main.go"] });
    // The implementer's one resolution attempt edits the conflicted file.
    writeFileSync(join(t2.path, "main.go"), "package main\n// one\n// two\n");
    expect((await mergeTask({ repoDir: backend, id: "add-x", worktree: t2, regate })).status).toBe(
      "merged",
    );
    expect(await gitOut(backend, "show", "change/add-x:main.go")).toBe(
      "package main\n// one\n// two",
    );
  });

  test("a task merged while a conflict was being resolved does not break the merge (audit P4)", async () => {
    const t1 = await task("1.1", "main.go", "package main\n// one\n", "Change main one");
    const t2 = await task("1.2", "main.go", "package main\n// two\n", "Change main two");
    const t3 = await task("1.3", "other.go", "package main\n", "Add other");
    const regate = async () => true;
    expect((await mergeTask({ repoDir: backend, id: "add-x", worktree: t1, regate })).status).toBe(
      "merged",
    );
    expect((await mergeTask({ repoDir: backend, id: "add-x", worktree: t2, regate })).status).toBe(
      "conflict",
    );
    // While the implementer resolves 1.2's conflict, 1.3 merges and moves change/add-x.
    expect((await mergeTask({ repoDir: backend, id: "add-x", worktree: t3, regate })).status).toBe(
      "merged",
    );
    writeFileSync(join(t2.path, "main.go"), "package main\n// one\n// two\n");
    expect((await mergeTask({ repoDir: backend, id: "add-x", worktree: t2, regate })).status).toBe(
      "merged",
    );
    expect(await gitOut(backend, "show", "change/add-x:other.go")).toBe("package main");
    expect(await gitOut(backend, "show", "change/add-x:main.go")).toBe(
      "package main\n// one\n// two",
    );
  });

  test("gates failing after the rebase keep the task unmerged", async () => {
    const t1 = await task("1.1", "a.go", "package main\n", "Add a");
    const before = await gitOut(backend, "rev-parse", "change/add-x");
    expect(
      await mergeTask({ repoDir: backend, id: "add-x", worktree: t1, regate: async () => false }),
    ).toEqual({
      status: "gates-failed",
    });
    expect(await gitOut(backend, "rev-parse", "change/add-x")).toBe(before);
    expect(existsSync(t1.path)).toBe(true);
  });

  test("the queue serialises per repo and runs repos in parallel", async () => {
    const queue = new MergeQueue();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await Bun.sleep(ms);
      log.push(`end ${name}`);
    };
    await Promise.all([
      queue.run("a", job("a1", 30)),
      queue.run("a", job("a2", 1)),
      queue.run("b", job("b1", 1)),
      queue
        .run("a", async () => {
          throw new Error("boom");
        })
        .catch(() => log.push("a3 failed")),
      queue.run("a", job("a4", 1)),
    ]);
    expect(log.indexOf("end a1")).toBeLessThan(log.indexOf("start a2"));
    expect(log.indexOf("end b1")).toBeLessThan(log.indexOf("end a1"));
    expect(log.indexOf("a3 failed")).toBeLessThan(log.indexOf("start a4"));
  });
});

describe("pointers and repoint", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    await branchAiRepo(fx.root, "add-x");
    for (const name of ["backend", "frontend", "deploy"]) {
      const dir = join(fx.root, `repos/${name}`);
      await branchSubmodule(fx.root, repo(name), "add-x");
      for (const [task, file] of [
        ["1.1", "one.txt"],
        ["1.2", "two.txt"],
      ] as const) {
        const wt = await addTaskWorktree(fx.root, dir, name, "add-x", task);
        writeFileSync(join(wt.path, file), `${name} ${task}\n`);
        await commitTask(wt.path, "add-x", task, `Add ${file}`);
        expect(
          (await mergeTask({ repoDir: dir, id: "add-x", worktree: wt, regate: async () => true }))
            .status,
        ).toBe("merged");
      }
    }
  });
  afterEach(() => fx.cleanup());

  /** A human merges the change upstream through a separate clone. */
  async function mergeUpstream(
    name: string,
    how: "squash" | "merge" | "rebase" | "ff",
  ): Promise<string> {
    const human = join(fx.base, `human-${name}`);
    await fixtureGit(fx.base, "clone", "-q", join(fx.base, `remotes/${name}.git`), human);
    const sub = join(fx.root, `repos/${name}`);
    // The change branch is never pushed by the factory; the human pushes it for review.
    await fixtureGit(human, "fetch", "-q", sub, "change/add-x:review");
    if (how !== "ff") {
      writeFileSync(join(human, "upstream.txt"), "someone else\n");
      await fixtureGit(human, "add", "upstream.txt");
      await fixtureGit(human, "commit", "-q", "-m", "chore: unrelated upstream work");
    }
    if (how === "squash") {
      await fixtureGit(human, "merge", "-q", "--squash", "review");
      await fixtureGit(human, "commit", "-q", "-m", "Add files (!12)");
    } else if (how === "merge") {
      await fixtureGit(human, "merge", "-q", "--no-ff", "-m", "Merge branch 'review'", "review");
    } else if (how === "rebase") {
      await fixtureGit(human, "cherry-pick", "main..review");
    } else {
      await fixtureGit(human, "merge", "-q", "--ff-only", "review");
    }
    await fixtureGit(human, "push", "-q", "origin", "main");
    return gitOut(human, "rev-parse", "HEAD");
  }

  test("provisional bump, then repoint after squash, merge and rebase merges", async () => {
    const bump = await bumpPointers(fx.root, "add-x", [
      repo("backend"),
      repo("frontend"),
      repo("deploy"),
    ]);
    expect(await gitOut(fx.root, "log", "-1", "--format=%s")).toBe(PROVISIONAL_SUBJECT("add-x"));
    expect(bump?.pointers.map((p) => p.path)).toEqual([
      "repos/backend",
      "repos/deploy",
      "repos/frontend",
    ]);
    expect((await findProvisionalBump(fx.root, "add-x"))?.commit).toBe(bump?.commit);
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("");

    const squashed = await mergeUpstream("backend", "squash");
    const merged = await mergeUpstream("frontend", "merge");

    const first = await cli(fx.root, "repoint", "add-x");
    expect(first.code).toBe(ExitCode.Precondition);
    expect(first.out).toContain(`✓ backend: repointed`);
    expect(first.out).toContain("(patch-id)");
    expect(first.out).toContain("(merge-commit)");
    expect(first.out).toContain("… deploy: not-merged");
    expect(await gitOut(fx.root, "rev-parse", "HEAD:repos/backend")).toBe(squashed);
    expect(await gitOut(fx.root, "rev-parse", "HEAD:repos/frontend")).toBe(merged);
    expect(await gitOut(fx.root, "log", "-1", "--format=%s")).toBe(
      "chore(submodules): repoint add-x",
    );

    const rebased = await mergeUpstream("deploy", "rebase");
    const second = await cli(fx.root, "repoint", "add-x");
    expect(second.out).toContain("✓ deploy: repointed");
    expect(second.out).toContain("(trailer)");
    expect(second.out).toContain("backend: skipped");
    expect(await gitOut(fx.root, "rev-parse", "HEAD:repos/deploy")).toBe(rebased);
  });

  test("a fast-forward merge leaves the pointer as is", async () => {
    await bumpPointers(fx.root, "add-x", [repo("backend"), repo("frontend"), repo("deploy")]);
    await mergeUpstream("backend", "ff");
    const run = await cli(fx.root, "repoint", "add-x", "--json");
    expect(run.err).toBe("");
    const json = JSON.parse(run.out) as {
      commit: string | null;
      results: { repo: string; status: string; method?: string }[];
    };
    expect(json.results.find((r) => r.repo === "backend")).toMatchObject({
      status: "already-merged",
      method: "fast-forward",
    });
    expect(json.results.filter((r) => r.status === "not-merged").map((r) => r.repo)).toEqual([
      "deploy",
      "frontend",
    ]);
    expect(json.commit).toBeNull();
    expect(run.code).toBe(ExitCode.Precondition);
  });
});
