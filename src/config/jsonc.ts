import {
  applyEdits,
  type FormattingOptions,
  type JSONPath,
  modify,
  type ParseError,
  parse,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js"; // ESM build: the UMD one breaks bundling

/**
 * JSONC helpers. Edits go through jsonc-parser's `modify`, which only rewrites the touched
 * value, so comments and formatting elsewhere in the file survive.
 */

export interface JsoncParseResult {
  readonly value: unknown;
  /** Human-readable "line:col message" entries; empty when the text parsed cleanly. */
  readonly errors: readonly string[];
}

export function parseJsonc(text: string): JsoncParseResult {
  const raw: ParseError[] = [];
  const value: unknown = parse(text, raw, { allowTrailingComma: true, disallowComments: false });
  const errors = raw.map((e) => {
    const { line, col } = lineCol(text, e.offset);
    return `${line}:${col} ${printParseErrorCode(e.error)}`;
  });
  return { value, errors };
}

function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, col: (before.at(-1)?.length ?? 0) + 1 };
}

/** Guesses the file's indentation so inserted values match it. */
export function detectFormatting(text: string): FormattingOptions {
  const indented = text.split("\n").find((line) => /^[ \t]+\S/.test(line));
  if (indented?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol: "\n" };
  const width = indented ? indented.length - indented.trimStart().length : 2;
  return { insertSpaces: true, tabSize: Math.min(Math.max(width, 2), 8), eol: "\n" };
}

/** Sets (or, with `undefined`, removes) the value at `path`. */
export function setJsonc(text: string, path: JSONPath, value: unknown): string {
  const edits = modify(text, path, value, { formattingOptions: detectFormatting(text) });
  return applyEdits(text, edits);
}

/** Appends `value` to the array at `path`. */
export function appendJsonc(text: string, path: JSONPath, value: unknown): string {
  const edits = modify(text, [...path, -1], value, {
    formattingOptions: detectFormatting(text),
    isArrayInsertion: true,
  });
  return applyEdits(text, edits);
}
