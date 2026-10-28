import type { Command } from "../command.ts";

/**
 * The command registry, set once by `main.ts`. Completion lives in a command module, so a
 * direct import of `COMMANDS` would make the module graph circular.
 */
let registry: readonly Command[] = [];

export function setCompletionCommands(commands: readonly Command[]): void {
  registry = commands;
}

export function completionCommands(): readonly Command[] {
  return registry;
}
