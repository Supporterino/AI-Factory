import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../exec.ts";

/**
 * Gate definitions an agent must not change (§8, audit S8): the scripts and targets the gates
 * run, named in `gates.scripts`. Otherwise a task could make its own checks pass by editing
 * `"lint": "true"` into package.json. Compared with the change's base commit.
 */

const HOSTS = ["package.json", "Makefile", "justfile", "Justfile", "Taskfile.yml", "Taskfile.yaml"];

function current(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

async function atBase(dir: string, base: string, file: string): Promise<string | undefined> {
  const res = await git(["show", `${base}:${file}`], { cwd: dir });
  return res.code === 0 ? res.stdout : undefined;
}

/** The definition of `name` in a host file, as comparable text (undefined when absent). */
function definition(file: string, text: string | undefined, name: string): string | undefined {
  if (text === undefined) return undefined;
  if (file === "package.json") {
    try {
      const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts;
      const v = scripts?.[name];
      return typeof v === "string" ? v : undefined;
    } catch {
      return "(unparsable package.json)";
    }
  }
  if (file.startsWith("Taskfile")) {
    try {
      const tasks = (parseYaml(text) as { tasks?: Record<string, unknown> } | null)?.tasks;
      return tasks && name in tasks ? JSON.stringify(tasks[name]) : undefined;
    } catch {
      return "(unparsable Taskfile)";
    }
  }
  // Makefile / justfile: the target line and its indented recipe.
  const lines = text.split("\n");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((l) => new RegExp(`^@?${escaped}(\\s[^:]*)?:(?!=)`).test(l));
  if (start === -1) return undefined;
  const body = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (l === "" || /^\s/.test(l)) body.push(l);
    else break;
  }
  return body.join("\n").trimEnd();
}

/** Gate definitions that differ between `base` and the worktree, as "file: name". */
export async function changedGateDefinitions(
  dir: string,
  base: string,
  names: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const file of HOSTS) {
    const now = current(dir, file);
    const before = await atBase(dir, base, file);
    if (now === before) continue;
    for (const name of new Set(names)) {
      if (definition(file, now, name) !== definition(file, before, name))
        out.push(`${file}: ${name}`);
    }
  }
  return out;
}
