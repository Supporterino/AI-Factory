/**
 * Secret redaction for logs (§8): token and key patterns, credentials in URLs, `key=value`
 * secrets, and the literal values of secret-looking environment variables.
 */

const MARK = (kind: string): string => `[REDACTED:${kind}]`;

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    MARK("private-key"),
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, MARK("aws-key")],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, MARK("github-token")],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, MARK("github-token")],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, MARK("gitlab-token")],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, MARK("slack-token")],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, MARK("api-key")],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MARK("google-key")],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MARK("jwt")],
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${MARK("credentials")}@`],
  [
    /\b((?:[A-Za-z0-9_]*_)?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    `$1${MARK("secret")}`,
  ],
];

const SECRET_ENV_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;

/** Values of secret-looking env vars, longest first (so overlapping values redact fully). */
export function secretEnvValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) => SECRET_ENV_NAME.test(name) && value !== undefined && value.length >= 8,
    )
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

export function redact(text: string, envValues: readonly string[] = []): string {
  let out = text;
  for (const value of envValues) out = out.split(value).join(MARK("env"));
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
