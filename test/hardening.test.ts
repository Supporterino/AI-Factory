import { describe, expect, test } from "bun:test";
import { checkEdit, type SessionContext } from "../src/policy/scope.ts";
import { checkShell, type ShellContext } from "../src/policy/shell.ts";

/**
 * Probes from the 2026-10-26 audit (docs/audit/2026-10-26.md, S1–S12). Each one bypassed the
 * enforcement layers when it was found. A finding's probes run as `test.failing` until its fix
 * lands and its id joins FIXED; from then on they must be blocked.
 */
const FIXED = new Set<string>(["S2", "S4"]);

const WT = "/ws/.factory/worktrees/add-x/app/1.1";
const FILES: Record<string, string> = {
  [`${WT}/s.sh`]: "git push origin HEAD\n",
  [`${WT}/f`]: "x\n",
};
const ctx: ShellContext = {
  cwd: WT,
  root: WT,
  env: { HOME: "/Users/dev", TMPDIR: "/var/folders/xy/T" },
  readFile: (abs) => FILES[abs],
  exists: (abs) => abs in FILES,
};

const PROBES: Readonly<Record<string, readonly string[]>> = {
  // S1: git runs arbitrary programs through env, config keys and options.
  S1: [
    "GIT_EXTERNAL_DIFF='git push #' git diff",
    "git -c diff.external='git push' diff",
    "git -c diff.x.textconv='sh -c id' log -p",
    "git -c pager.log='sh -c id' log",
    "git ls-remote --upload-pack='touch x; git-upload-pack' .",
    "git ls-remote -u 'touch x' .",
    "git fetch --upload-pack='sh -c id' origin",
    "git archive --exec='sh -c id' --remote=origin HEAD",
    "git difftool -x 'sh -c id' HEAD",
    "git grep -O'sh -c id' foo",
    "GIT_SSH_COMMAND='sh -c id' git fetch origin",
    "PAGER='sh -c id' git log",
    "export GIT_EXTERNAL_DIFF='sh -c id'",
    "env GIT_EXTERNAL_DIFF='sh -c id' git diff",
    "LD_PRELOAD=/tmp/x.so ls",
    "DYLD_INSERT_LIBRARIES=/tmp/x.dylib ls",
    "PATH=./bin:$PATH git status",
    "BASH_ENV=./x.sh bash -c true",
  ],
  // S2: shell keywords parsed as the command name.
  S2: [
    "if rm -rf ~; then :; fi",
    "if sudo id; then :; fi",
    "while sh -c 'git push'; do :; done",
    "until git push; do :; done",
    "function f { rm -rf /; }",
    "coproc git push",
    "coproc X { git push; }",
  ],
  // S3: cd/pushd are not tracked.
  S3: [
    "cd .. && rm -rf 1.2",
    "cd ~ && rm -rf *",
    "cd ../../../../runs && sed -i 's/a/b/' c.json",
    "pushd /; rm -rf Users",
    "cd - && rm -rf x",
    "cd $UNKNOWN && rm -rf x",
    "env -C .. rm -rf 1.2",
  ],
  // S4: evasions the blocklist claims to resolve.
  S4: [
    "echo -fdx | xargs git clean",
    "echo -D main | xargs git branch",
    "echo --hard HEAD~3 | xargs git reset",
    "echo ~ | xargs rm -rf",
    "echo git push | xargs -I{} sh -c '{}'",
    "ls | xargs rm -rf",
    "bash -c -- 'git push'",
    "bash -c -x 'git push'",
    "exec -a foo git push",
    "sh < s.sh",
    "bash -s < s.sh",
    "bash -s foo < s.sh",
    "python3 - <<EOF\nimport os; os.system('git push')\nEOF",
    "echo \"import os; os.system('git push')\" | python3",
    "awk 'BEGIN{system(\"git push\")}'",
    "awk '{print | \"sh\"}' f",
    "sed 's/x/git push/e' f",
    "sed -n 'w ../../x' f",
    "script -q -c 'git push' /dev/null",
    "parallel ::: 'git push'",
    "fd . -x git push",
    "vim -c '!git push' f",
    "osascript -e 'do shell script \"git push\"'",
    "at now <<< 'git push'",
    "crontab f",
    "awk -i inplace '{print}' ../x",
  ],
  // S5: git fetch refspecs delete or force branches.
  S5: [
    "git fetch --prune . 'refs/nothing/*:refs/heads/*'",
    "git fetch . +HEAD~1:refs/heads/main",
    "git fetch . HEAD:refs/heads/x",
    "git fetch origin main:main",
    "git fetch -f origin",
  ],
  // S6: writes escaping the worktree.
  S6: [
    "ln -s ../../../../runs r",
    "ln -s ~ h",
    "ln -s / root",
    "perl -pi -e 's/x/y/' AGENTS.md",
    "perl -pi -e 's/x/y/' ../../../../runs/c.json",
    "ruby -pi -e 'x' ../x",
    "curl -o ../../x https://example.com",
    "curl --output=../../x https://example.com",
    "wget -O ../x https://example.com",
    "tar -xf a.tar -C ..",
    "unzip a.zip -d ..",
    "cp -t .. f",
    "sort -o ../x f",
    "git log --output=../../x",
    "git format-patch -o .. HEAD~1",
    "git rm AGENTS.md",
    "git mv f .opencode/x",
  ],
  // S7: case variants on case-insensitive filesystems.
  S7: ["cat .ENV", "echo x >> .GIT/config", "cp f AGENTS.MD", "rm -rf .OPENCODE"],
  // S10: agents commit and so dodge the worktree audit.
  S10: ["git commit -m x", "git commit -am x"],
  // S12: git config writes read as reads.
  S12: [
    "git config --unset core.hooksPath",
    "git config --unset-all x.y",
    "git config --remove-section alias",
  ],
};

for (const [id, commands] of Object.entries(PROBES)) {
  describe(`${id} probes are blocked`, () => {
    for (const cmd of commands) {
      (FIXED.has(id) ? test : test.failing)(cmd, () => {
        expect(checkShell(cmd, ctx).allowed).toBe(false);
      });
    }
  });
}

describe("probes that were already blocked stay blocked", () => {
  test.each([
    "git -c core.pager='sh -c id' log",
    "ls | xargs sh -c 'git push'",
    "mv -t .. f",
    "git config --rename-section a b",
  ])("%s", (cmd) => {
    expect(checkShell(cmd, ctx).allowed).toBe(false);
  });
});

const EDIT_CTX: SessionContext = {
  sessionId: "s",
  changeId: "add-x",
  role: "implementer",
  directory: WT,
  workspace: "/ws",
  repo: "app",
  task: "1.1",
  touches: ["**"],
};

describe("S7 case-variant edits are blocked", () => {
  for (const path of [
    "AGENTS.MD",
    ".GIT/config",
    ".Git/hooks/pre-push",
    ".OPENCODE/plugins/factory.js",
    "Factory.Config.jsonc",
    ".FACTORY/runs/c.json",
    ".GITMODULES",
    ".ENV",
    "x/.Env.local",
  ]) {
    (FIXED.has("S7") ? test : test.failing)(path, () => {
      expect(checkEdit(EDIT_CTX, path, () => true).allowed).toBe(false);
    });
  }
});

describe("everyday commands stay allowed", () => {
  test.each([
    "git status",
    "git diff",
    "git log --oneline -5",
    "git diff HEAD~1 -- src",
    "git show HEAD:f",
    "git -c color.ui=never log",
    "git --no-pager diff",
    "git fetch origin",
    "git fetch --prune origin",
    "bun test",
    "FOO=1 bun test",
    "NODE_ENV=test npx vitest run",
    "find . -name '*.ts' | xargs grep foo",
    "git ls-files | xargs wc -l",
    "cd src && ls",
    "cd src && rm -rf build",
    "if [ -f f ]; then cat f; fi",
    "for x in a b; do echo $x; done",
    "while read l; do echo $l; done < f",
    "sed -i 's/a/b/' src/x.ts",
    "perl -pi -e 's/a/b/' src/x.ts",
    "awk '{print $1}' f",
    "sed -n '1,5p' f",
    "python3 -c 'print(1)'",
    "echo 'print(1)' | python3",
    "tar -czf out.tgz src",
    "ln -s src/a.ts b.ts",
    "curl -sS https://example.com -o out.json",
    "go test ./...",
    "cargo test",
    "npm run lint",
  ])("%s", (cmd) => {
    expect(checkShell(cmd, ctx)).toEqual({ allowed: true });
  });
});
