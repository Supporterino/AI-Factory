/**
 * Path classes shared by the edit scope, the shell blocklist and the post-session audit.
 * Paths are POSIX, relative to the session directory. Matching ignores case: macOS and
 * Windows filesystems treat `.GIT/config` and `.git/config` as the same file.
 */

const PROTECTED: readonly RegExp[] = [
  /^openspec\/specs(\/|$)/i,
  /^\.opencode(\/|$)/i,
  /^\.factory(\/|$)/i,
  /^factory\.config\.jsonc$/i,
  /^factory\.lock\.json$/i,
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)\.git(\/|$)/i,
  /^\.gitmodules$/i,
];

/** Files only the factory (or a human) may change. */
export function isProtectedPath(rel: string): boolean {
  const p = rel.replace(/^\.\//, "");
  return PROTECTED.some((re) => re.test(p));
}

const SECRET_BASENAMES: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\.(?!(example|sample|template|dist|defaults)$).+/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /kubeconfig/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /\.tfstate(\.backup)?$/i,
];

const SECRET_SEGMENTS: readonly RegExp[] = [
  /(^|\/)\.kube\/config$/i,
  /(^|\/)\.aws\/(credentials|config)$/i,
  /(^|\/)\.config\/gcloud(\/|$)/i,
  /(^|\/)\.azure(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.ssh(\/|$)/i,
];

/** Secret files: never read or written by an agent (§8). `.env.example` and friends are fine. */
export function isSecretPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  return SECRET_BASENAMES.some((re) => re.test(base)) || SECRET_SEGMENTS.some((re) => re.test(p));
}
