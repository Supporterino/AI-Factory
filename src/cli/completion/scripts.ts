import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PreconditionError } from "../../errors.ts";

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

const BASH = `_ai_factory_complete() {
  local IFS=$'\\n'
  local -a lines
  lines=( $(ai-factory __complete bash "\${COMP_WORDS[@]:1:$COMP_CWORD}") )
  if [ "\${lines[0]:-}" = ":files" ]; then
    COMPREPLY=()
    compopt -o default 2>/dev/null
    return
  fi
  if [ "\${lines[0]:-}" = ":dirs" ]; then
    COMPREPLY=()
    compopt -o dirnames 2>/dev/null || compopt -o default 2>/dev/null
    return
  fi
  COMPREPLY=()
  local line
  for line in "\${lines[@]}"; do
    [ -n "$line" ] && COMPREPLY+=("\${line%%$'\\t'*}")
  done
}
complete -F _ai_factory_complete ai-factory
`;

const ZSH = `#compdef ai-factory
_ai_factory() {
  local -a lines values descriptions
  lines=("\${(@f)$(ai-factory __complete zsh "\${words[2,CURRENT]}")}")
  if [[ "\${lines[1]:-}" == ":files" ]]; then _files; return; fi
  if [[ "\${lines[1]:-}" == ":dirs" ]]; then _files -/; return; fi
  local line
  for line in "\${lines[@]}"; do
    [[ -z "$line" ]] && continue
    values+=("\${line%%$'\\t'*}")
    if [[ "$line" == *$'\\t'* ]]; then descriptions+=("\${line#*$'\\t'}"); else descriptions+=(""); fi
  done
  compadd -d descriptions -a values
}
compdef _ai_factory ai-factory
`;

const FISH = `function __ai_factory_complete
  set -l tokens (commandline -opc)
  set -l current (commandline -ct)
  set -l lines (ai-factory __complete fish $tokens[2..-1] $current)
  if test "$lines[1]" = ":files"
    __fish_complete_path "$current"
    return
  end
  if test "$lines[1]" = ":dirs"
    __fish_complete_directories "$current"
    return
  end
  set -l tab (printf '\\t')
  for line in $lines
    set -l parts (string split -m1 -- $tab $line)
    if test (count $parts) -gt 1
      printf '%s\\t%s\\n' $parts[1] $parts[2]
    else
      printf '%s\\n' $parts[1]
    end
  end
end
complete -c ai-factory -f -a '(__ai_factory_complete)'
`;

export function completionScript(shell: Shell): string {
  if (shell === "bash") return BASH;
  if (shell === "zsh") return ZSH;
  return FISH;
}

const START = "# >>> ai-factory completion >>>";
const END = "# <<< ai-factory completion <<<";

const rcPath = (shell: Shell, cwd: string, override: string | undefined): string => {
  if (override !== undefined) return isAbsolute(override) ? override : resolve(cwd, override);
  const home = homedir();
  if (shell === "bash") return join(home, ".bashrc");
  if (shell === "zsh") return join(process.env.ZDOTDIR ?? home, ".zshrc");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "fish", "config.fish");
};

const sourceLine = (shell: Shell): string =>
  shell === "fish"
    ? "ai-factory completion fish | source"
    : `eval "$(ai-factory completion ${shell})"`;

const block = (shell: Shell): string => `${START}\n${sourceLine(shell)}\n${END}\n`;

const replaceBlock = (text: string, next: string, path: string): string => {
  const start = text.indexOf(START);
  if (start < 0) return text === "" ? next : `${text}${text.endsWith("\n") ? "" : "\n"}\n${next}`;
  const end = text.indexOf(END, start);
  if (end < 0)
    throw new PreconditionError(`completion block in ${path} has no end marker`, [
      `remove the line starting with "${START}" and run the install again`,
    ]);
  const after = end + END.length;
  const skip = text.startsWith("\r\n", after) ? 2 : text[after] === "\n" ? 1 : 0;
  return `${text.slice(0, start)}${next}${text.slice(after + skip)}`;
};

export interface InstallResult {
  readonly path: string;
  readonly changed: boolean;
}

/** Adds or refreshes the completion block in a shell rc file. */
export function installCompletion(shell: Shell, cwd: string, override?: string): InstallResult {
  const path = rcPath(shell, cwd, override);
  let existing = "";
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, "utf8");
    } catch (err) {
      throw new PreconditionError(
        `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
        [`fix its permissions, or pass --rc <file>`],
      );
    }
  }
  const next = replaceBlock(existing, block(shell), path);
  if (next === existing) return { path, changed: false };
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode : 0o644;
  const tmp = `${path}.ai-factory.tmp`;
  writeFileSync(tmp, next, { mode });
  renameSync(tmp, path);
  chmodSync(path, mode);
  return { path, changed: true };
}
