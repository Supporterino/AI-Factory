/**
 * A Markdown code fence around untrusted text (gate output, findings): longer than any
 * backtick run inside, so the text cannot close the fence and talk to the model (audit S19).
 */
export function fence(text: string, info = ""): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}${info}\n${text}\n${marks}`;
}
