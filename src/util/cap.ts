/** Character budget per token, the tokenizer approximation used for packs and prompts (§11). */
export const CHARS_PER_TOKEN = 4;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * Caps text at `maxTokens`, cut at the last line that fits (never mid-line or mid-character),
 * with `note` saying where the rest is (audit P20).
 */
export function capText(text: string, maxTokens: number, note: string): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const keep = Math.max(0, maxTokens * CHARS_PER_TOKEN - note.length - 2);
  const cut = text.lastIndexOf("\n", keep);
  return `${text.slice(0, cut > keep / 2 ? cut : keep).trimEnd()}\n\n${note}`;
}
