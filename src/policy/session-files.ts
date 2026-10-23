import { join } from "node:path";

/** Where the CLI writes a session's context for the plugin: `.factory/sessions/<id>.json`. */
export const sessionContextFile = (workspace: string, sessionId: string): string =>
  join(workspace, ".factory", "sessions", `${sessionId}.json`);
