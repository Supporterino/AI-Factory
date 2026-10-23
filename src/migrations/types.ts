/**
 * A config migration (§10): a pure function from one schema version's JSONC text to the
 * next. It edits the text with jsonc-parser so comments and formatting survive, and it must
 * set `schemaVersion` to `to`.
 */
export interface Migration {
  readonly from: number;
  readonly to: number;
  readonly name: string;
  migrate(text: string): string;
}
