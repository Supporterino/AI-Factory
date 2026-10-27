/**
 * Durations in progress lines: `640ms`, `12.4s`, `2m14s`, `1h02m`. Progress output is read
 * while it runs, so a value must be short and never ambiguous about its unit.
 */
export function formatDuration(ms: number): string {
  const bounded = Math.max(0, Math.round(ms));
  if (bounded < 950) return `${bounded}ms`;
  const seconds = bounded / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes - hours * 60).padStart(2, "0")}m`;
}
