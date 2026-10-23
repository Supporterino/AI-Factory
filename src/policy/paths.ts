/**
 * Path classes shared by the edit scope, the shell blocklist and the post-session audit.
 * Paths are POSIX, relative to the session directory.
 */

const PROTECTED: readonly RegExp[] = [
  /^openspec\/specs(\/|$)/,
  /^\.opencode(\/|$)/,
  /^\.factory(\/|$)/,
  /^factory\.config\.jsonc$/,
  /^factory\.lock\.json$/,
  /(^|\/)AGENTS\.md$/,
  /(^|\/)\.git(\/|$)/,
  /^\.gitmodules$/,
];

/** Files only the factory (or a human) may change. */
export function isProtectedPath(rel: string): boolean {
  const p = rel.replace(/^\.\//, "");
  return PROTECTED.some((re) => re.test(p));
}

const SECRET_BASENAMES: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\.(?!(example|sample|template|dist|defaults)$).+/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/,
  /kubeconfig/i,
  /^\.netrc$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.git-credentials$/,
  /\.tfstate(\.backup)?$/,
];

const SECRET_SEGMENTS: readonly RegExp[] = [
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.aws\/(credentials|config)$/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.azure(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.ssh(\/|$)/,
];

/** Secret files: never read or written by an agent (§8). `.env.example` and friends are fine. */
export function isSecretPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  return SECRET_BASENAMES.some((re) => re.test(base)) || SECRET_SEGMENTS.some((re) => re.test(p));
}
