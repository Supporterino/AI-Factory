import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { graphRebuildReason, graphStatus } from "../src/graph/graph.ts";
import { PROFILES } from "../src/profiles/index.ts";
import { ZERO_USAGE } from "../src/runtime/types.ts";
import { withFileLock } from "../src/state/files.ts";
import { loadUsage, recordUsage, summarizeUsage } from "../src/usage/usage.ts";
import { capText } from "../src/util/cap.ts";

/** Smaller findings of the 2026-10-26 audit (G8, P15, P20), one probe each. */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-factory-gaps-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("G8: the Helm types gate fails when rendering fails", () => {
  test.skipIf(process.platform === "win32")("a helm template error is not piped away", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "helm"), "#!/bin/sh\necho 'Error: template broke' >&2\nexit 1\n");
    writeFileSync(join(bin, "kubeconform"), "#!/bin/sh\ncat >/dev/null\nexit 0\n");
    chmodSync(join(bin, "helm"), 0o755);
    chmodSync(join(bin, "kubeconform"), 0o755);
    const command = (PROFILES.helm.gates.types[0]?.command ?? "").replace("{charts}", "charts/app");
    const res = spawnSync("/bin/sh", ["-c", command], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    expect(res.status).not.toBe(0);
  });
});

describe("P20: context packs and specs are capped at a line", () => {
  test("cuts at the last line that fits and says where the rest is", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const capped = capText(text, 1000, "(truncated; read the spec files for the rest)");
    expect(capped.length).toBeLessThanOrEqual(4000);
    const body = capped.split("\n\n(truncated")[0] ?? "";
    expect(body.split("\n").every((l) => /^line \d+ x{30}$/.test(l))).toBe(true);
    expect(capped).toEndWith("(truncated; read the spec files for the rest)");
    expect(capText("short", 1000, "note")).toBe("short");
  });
});

describe("P20: a long lock holder that is alive is not broken", () => {
  test("staleAfterMs keeps a live owner's lock", async () => {
    const lock = join(dir, "graph.lock");
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        at: Date.now() - 120_000,
      }),
    );
    await expect(
      withFileLock(lock, () => "got it", 300, { staleAfterMs: 30 * 60_000 }),
    ).rejects.toThrow();
    // The default (one minute) breaks it.
    expect(await withFileLock(lock, () => "got it", 300)).toBe("got it");
  });
});

describe("P15: a corrupt usage ledger or graph metadata never stops a command", () => {
  test("usage starts a new ledger and keeps the corrupt one aside", async () => {
    mkdirSync(join(dir, ".factory", "usage"), { recursive: true });
    writeFileSync(join(dir, ".factory", "usage", "c.json"), "{oops");
    expect(loadUsage(dir, "c").entries).toEqual([]);
    expect(summarizeUsage(dir, "c").sessions).toBe(0);
    await recordUsage(dir, "c", {
      at: "now",
      sessionId: "s",
      agent: "a",
      model: "m",
      step: "x",
      kind: "step",
      usage: ZERO_USAGE,
    });
    expect(loadUsage(dir, "c").entries).toHaveLength(1);
    expect(readdirSync(join(dir, ".factory", "usage"))).toContain("c.json.corrupt");
  });

  test("graph status ignores unreadable metadata", () => {
    mkdirSync(join(dir, ".factory"), { recursive: true });
    writeFileSync(join(dir, ".factory", "graph-meta.json"), "{oops");
    expect(() => graphStatus(dir)).not.toThrow();
  });
});

describe("G6: a graph built by another Graphify release is rebuilt", () => {
  test("graphRebuildReason compares the builder with the installed graphify", () => {
    const ok = { state: "ok" as const, ageMs: 0, meta: { graphifyVersion: "0.9.93" } as never };
    expect(graphRebuildReason(ok, "0.9.93")).toBeUndefined();
    expect(graphRebuildReason(ok, "0.9.95")).toBe("built by graphify 0.9.93, installed is 0.9.95");
    expect(graphRebuildReason({ state: "unsupported", schemaVersion: 7 }, "0.9.93")).toContain(
      "format 7",
    );
    expect(graphRebuildReason({ state: "missing" }, "0.9.93")).toBeUndefined();
  });
});
